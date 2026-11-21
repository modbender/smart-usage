// getReading: the source layer's one entry point (docs/design.md section 1).
// Order: fresh cache -> backoff -> credentials -> fetch.lock -> fetch -> atomic cache write.
// Never throws; every failure maps to a SourceStatus with a short detail.
//
// Latency budget. The cached path reads two small files and does no network. A fetching call
// costs at most one keychain wait on macOS (2 s; the fallback name is tried only after a
// definite not-found, which returns at once) plus fetchTimeoutMs, which covers both requests:
// the profile fetch gets only what the usage fetch left. The lock is held for the requests and
// the write only, well inside its stale age (2 x fetchTimeoutMs + 2 s). A caller that finds the
// lock held and no cache waits at most fetchTimeoutMs.

import { loadConfig, type Config } from "../config.ts";
import { lockHeld, tryLock, withLock } from "../fs-util.ts";
import { log } from "../log.ts";
import type { ReadingOptions } from "../reading.ts";
import type { Reading, Snapshot, SourceStatus } from "../types.ts";
import {
  apiBase,
  fetchJson,
  parseProfile,
  parseRetryAfter,
  parseUsage,
  PROFILE_PATH,
  USAGE_PATH,
  type FetchImpl,
  type FetchResult,
  type UsageParts,
} from "./api.ts";
import { fetchLockPath, readCache, writeCache, type BackoffReason, type CacheFile } from "./cache.ts";
import { credentialsStamp, isExpired, readCredentials, type CredentialLookup, type Credentials } from "./credentials.ts";
import { detectPlan } from "./plan.ts";

export type SourceConfig = Pick<Config, "refreshSeconds" | "staleSeconds" | "fetchTimeoutMs" | "profileRefreshSeconds" | "plan">;

export interface SourceDeps {
  nowMs: () => number;
  fetchImpl: FetchImpl;
  config: SourceConfig;
  readCredentials: () => CredentialLookup;
  /** Cheap fingerprint of the credential stores; see credentialsStamp. */
  credentialsStamp: (opts: { includeEnv: boolean }) => string;
  apiBase: string;
  sleep: (ms: number) => Promise<void>;
}

const BACKOFF_BASE_S = 60;
const BACKOFF_MAX_S = 1800;
const WAIT_POLL_MS = 50;
/** A failed profile fetch is retried no sooner than this; the old plan stands meanwhile. */
const PROFILE_RETRY_S = 3600;
/** Below this much of the fetch budget left, the profile fetch waits for the next refresh. */
const PROFILE_MIN_BUDGET_MS = 250;
const NEWER_VERSION = "cache owned by a newer smart-usage";

/** While a backoff of this reason is ahead, readings report this status. */
const BACKOFF_STATUS: Record<BackoffReason, SourceStatus> = {
  rate_limit: "backoff",
  error: "backoff",
  auth: "auth",
  no_credentials: "no_credentials",
};

/** Backoffs a forced fetch (`/smart-usage refresh`) may skip; a 429 is always honoured. */
const FORCE_SKIPS: ReadonlySet<BackoffReason> = new Set(["auth", "error", "no_credentials"]);

/**
 * Pauses that end as soon as the credential stores change (a login or a token refresh).
 * Only a session with no login at all records no_credentials, so that stamp may carry this
 * process's env-token presence: a session that has the env token is not held by it. Both kinds
 * of session can record auth, so its stamp leaves env out, or they would end each other's
 * pause on every call.
 */
const STAMPED_PAUSES: Partial<Record<BackoffReason, { includeEnv: boolean }>> = {
  auth: { includeEnv: false },
  no_credentials: { includeEnv: true },
};

const stampFor = (reason: BackoffReason, d: SourceDeps): string | null => {
  const opts = STAMPED_PAUSES[reason];
  return opts ? d.credentialsStamp(opts) : null;
};

const defaultDeps = (): SourceDeps => ({
  nowMs: Date.now,
  fetchImpl: (input, init) => fetch(input, init),
  config: loadConfig(),
  readCredentials: () => readCredentials(),
  credentialsStamp: (opts) => credentialsStamp(opts),
  apiBase: apiBase(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

export async function getReading(opts: ReadingOptions = {}): Promise<Reading> {
  try {
    return await getReadingWith(opts, defaultDeps());
  } catch (e) {
    log("cache", () => `getReading failed: ${(e as Error)?.message ?? String(e)}`);
    try {
      return present(readCache(), "error", "internal error", loadConfig(), Date.now() / 1000);
    } catch {
      return { snapshot: null, status: "error", ageSeconds: null, detail: "internal error" };
    }
  }
}

const lockStaleMs = (c: SourceConfig): number => c.fetchTimeoutMs * 2 + 2000;

const ageOf = (cache: CacheFile, nowS: number): number | null =>
  cache.snapshot ? Math.max(0, nowS - cache.snapshot.fetchedAt) : null;

const ageStatus = (cache: CacheFile, nowS: number, c: SourceConfig): SourceStatus =>
  (ageOf(cache, nowS) ?? Infinity) > c.staleSeconds ? "stale" : "cached";

// Times read back from the cache are trusted only within these bounds, so a clock set back
// (or a corrupted file) cannot pin a reading as fresh or a backoff as active for hours.
const CLOCK_SKEW_S = 60;

const isFresh = (cache: CacheFile, nowS: number, c: SourceConfig): boolean => {
  if (cache.fetchedAt <= 0) return false;
  const age = nowS - cache.fetchedAt;
  return age > -CLOCK_SKEW_S && age < c.refreshSeconds;
};

/** The cache as a Reading; the plan is recomputed so a config change applies at once. */
function present(cache: CacheFile, status: SourceStatus, detail: string | undefined, c: SourceConfig, nowS: number): Reading {
  const snap = status === "no_credentials" ? null : cache.snapshot;
  const base = detail ? { detail } : {};
  if (!snap) return { snapshot: null, status, ageSeconds: null, ...base };
  const plan = detectPlan({ configPlan: c.plan, profile: cache.profile, credentialsTier: cache.credentialsTier });
  return { snapshot: { ...snap, plan }, status, ageSeconds: Math.floor(Math.max(0, nowS - snap.fetchedAt)), ...base };
}

/** The reading to return while a backoff is ahead, or null when none applies. */
function activeBackoff(cache: CacheFile, nowS: number, force: boolean, d: SourceDeps): Reading | null {
  const c = d.config;
  const reason = cache.backoffReason ?? "error";
  const longest = Math.max(BACKOFF_MAX_S, c.refreshSeconds) + CLOCK_SKEW_S;
  if (cache.backoffUntil <= nowS || cache.backoffUntil - nowS > longest) return null;
  if (force && FORCE_SKIPS.has(reason)) return null;
  const stamp = stampFor(reason, d);
  if (stamp !== null && cache.backoffStamp !== stamp) {
    log("cache", () => `backoff (${reason}) ended: credentials changed`);
    return null;
  }
  const left = Math.ceil(cache.backoffUntil - nowS);
  log("cache", () => `backoff active (${reason}), ${left} s left`);
  return present(cache, BACKOFF_STATUS[reason], `${cache.lastError ?? reason}; retry in ${left} s`, c, nowS);
}

export async function getReadingWith(opts: ReadingOptions, d: SourceDeps): Promise<Reading> {
  const c = d.config;
  const force = opts.force === true;
  const nowS = d.nowMs() / 1000;
  const cache = readCache();
  const age = ageOf(cache, nowS);

  if (!force && isFresh(cache, nowS, c)) {
    log("cache", () => `hit, age ${Math.floor(age ?? 0)} s`);
    return present(cache, "cached", undefined, c, nowS);
  }
  log("cache", () => (age === null ? "miss: no snapshot" : `expired, age ${Math.floor(age)} s`));

  const backoff = activeBackoff(cache, nowS, force, d);
  if (backoff) return backoff;
  if (cache.readOnly) return present(cache, ageStatus(cache, nowS, c), NEWER_VERSION, c, nowS);
  if (opts.allowFetch === false) return present(cache, ageStatus(cache, nowS, c), "fetch not allowed", c, nowS);

  const lookup = d.readCredentials();
  if (!lookup.creds) {
    if (!lookup.definitive) return present(cache, "error", "credentials unreadable", c, nowS);
    recordNoCredentials(d, nowS);
    return { snapshot: null, status: "no_credentials", ageSeconds: null, detail: "no OAuth login" };
  }
  const creds = lookup.creds;
  if (isExpired(creds, d.nowMs())) {
    log("fetch", () => "token expired; not fetching");
    return present(cache, "auth", "token expired", c, nowS);
  }

  const release = tryLock(fetchLockPath(), { staleMs: lockStaleMs(c) });
  if (!release) return waitForHolder(cache, d);
  try {
    // Another session may have finished a fetch between our read and the lock.
    const current = readCache();
    if (!force && isFresh(current, nowS, c)) {
      log("cache", () => "hit after lock: another session just fetched");
      return present(current, "cached", undefined, c, nowS);
    }
    const held = activeBackoff(current, nowS, force, d);
    if (held) return held;
    if (current.readOnly) return present(current, ageStatus(current, nowS, c), NEWER_VERSION, c, nowS);
    return await fetchAndStore(current, creds, d);
  } finally {
    release();
  }
}

/** Another session holds fetch.lock. Use the cache as is; with none, wait for the holder. */
async function waitForHolder(cache: CacheFile, d: SourceDeps): Promise<Reading> {
  const c = d.config;
  if (cache.snapshot) {
    return present(cache, ageStatus(cache, d.nowMs() / 1000, c), "another session is fetching", c, d.nowMs() / 1000);
  }
  const deadline = Date.now() + c.fetchTimeoutMs;
  while (Date.now() < deadline && lockHeld(fetchLockPath()) && !readCache().snapshot) await d.sleep(WAIT_POLL_MS);
  const after = readCache();
  const nowS = d.nowMs() / 1000;
  const backoff = activeBackoff(after, nowS, false, d);
  if (backoff) return backoff;
  if (after.snapshot) return present(after, ageStatus(after, nowS, c), undefined, c, nowS);
  return { snapshot: null, status: "error", ageSeconds: null, detail: "another session is fetching" };
}

/**
 * Pauses credential lookups (a keychain spawn on macOS) once every store has definitively
 * answered "no OAuth login": API-key users. The pause ends early when the stores change.
 * Skipped when another session holds the lock.
 */
function recordNoCredentials(d: SourceDeps, nowS: number): void {
  const c = d.config;
  withLock(fetchLockPath(), { staleMs: lockStaleMs(c) }, () => {
    const current = readCache();
    const written = writeCache({
      ...current,
      backoffUntil: nowS + c.refreshSeconds,
      backoffReason: "no_credentials",
      backoffStamp: stampFor("no_credentials", d),
      failures: 0,
      lastError: "no OAuth login",
    });
    if (written) log("cache", () => `backoff set (no_credentials) for ${c.refreshSeconds} s`);
  });
}

const windowSet = (windows: Snapshot["windows"] | undefined): string => Object.keys(windows ?? {}).sort().join(",");

function profileDue(cache: CacheFile, parts: UsageParts, nowS: number, c: SourceConfig): boolean {
  if (nowS < cache.profileRetryAt) return false;
  if (!cache.profile) return true;
  if (nowS - cache.profile.fetchedAt >= c.profileRefreshSeconds) return true;
  return windowSet(cache.snapshot?.windows) !== windowSet(parts.windows);
}

async function fetchAndStore(cache: CacheFile, creds: Credentials, d: SourceDeps): Promise<Reading> {
  const c = d.config;
  const started = Date.now();
  const fetchOpts = { base: d.apiBase, token: creds.token, timeoutMs: c.fetchTimeoutMs, fetchImpl: d.fetchImpl };
  const res = await fetchJson(USAGE_PATH, fetchOpts);
  const nowS = d.nowMs() / 1000;
  const parts = res.kind === "ok" ? parseUsage(res.body) : null;
  if (!parts) return recordFailure(cache, res.kind === "ok" ? { kind: "bad_body" } : res, d, nowS);

  let { profile, profileRetryAt } = cache;
  if (profileDue(cache, parts, nowS, c)) {
    const budget = c.fetchTimeoutMs - (Date.now() - started);
    if (budget < PROFILE_MIN_BUDGET_MS) {
      log("plan", () => `profile fetch deferred: ${budget} ms of the fetch budget left`);
    } else {
      const p = await fetchJson(PROFILE_PATH, { ...fetchOpts, timeoutMs: budget });
      const parsed = p.kind === "ok" ? parseProfile(p.body, Math.floor(d.nowMs() / 1000)) : null;
      if (parsed) {
        profile = parsed;
        profileRetryAt = 0;
      } else {
        profileRetryAt = Math.floor(nowS) + PROFILE_RETRY_S;
        log("plan", () => `profile fetch failed (${p.kind}); keeping the previous plan, retry in ${PROFILE_RETRY_S} s`);
      }
    }
  }

  const fetchedAt = Math.floor(nowS);
  const next: CacheFile = {
    ...cache,
    fetchedAt,
    // The stored plan is a placeholder; present() recomputes it on every read.
    snapshot: { fetchedAt, ...parts, plan: { id: "unknown", label: "Unknown", source: "none" } },
    profile,
    profileRetryAt,
    credentialsTier: creds.rateLimitTier,
    backoffUntil: 0,
    backoffReason: null,
    backoffStamp: null,
    failures: 0,
    lastError: null,
  };
  writeCache(next);
  return present(next, "fresh", undefined, c, nowS);
}

interface Failure {
  reason: BackoffReason;
  status: SourceStatus;
  baseS: number;
  /** Doubles per consecutive failure of the same reason. */
  doubles: boolean;
  detail: string;
}

/** Doubling from `baseS` per earlier consecutive failure, capped. */
const doubled = (baseS: number, streak: number): number => Math.min(BACKOFF_MAX_S, baseS * 2 ** Math.min(streak, 16));

function classify(res: Exclude<FetchResult, { kind: "ok" }>, d: SourceDeps): Failure {
  if (res.kind === "http" && res.status === 429) {
    // Retry-After 0 has been seen persisting for minutes, so 0 or missing counts as the base.
    const stated = parseRetryAfter(res.retryAfter, d.nowMs());
    const baseS = stated && stated > 0 ? stated : BACKOFF_BASE_S;
    return { reason: "rate_limit", status: "backoff", baseS, doubles: true, detail: "429 rate limited" };
  }
  if (res.kind === "http" && (res.status === 401 || res.status === 403)) {
    const detail = `${res.status} token rejected`;
    return { reason: "auth", status: "auth", baseS: d.config.refreshSeconds, doubles: false, detail };
  }
  const detail =
    res.kind === "http" ? `HTTP ${res.status}` : res.kind === "network" ? `network: ${res.detail}` : res.kind === "timeout" ? "timeout" : "unrecognised response";
  return { reason: "error", status: "error", baseS: BACKOFF_BASE_S, doubles: true, detail };
}

function recordFailure(cache: CacheFile, res: Exclude<FetchResult, { kind: "ok" }>, d: SourceDeps, nowS: number): Reading {
  const f = classify(res, d);
  // Only an unbroken run of the same kind doubles: earlier auth failures do not lengthen a 429.
  const streak = cache.backoffReason === f.reason ? cache.failures : 0;
  const delayS = f.doubles ? doubled(f.baseS, streak) : f.baseS;
  const next: CacheFile = {
    ...cache,
    backoffUntil: nowS + delayS,
    backoffReason: f.reason,
    backoffStamp: stampFor(f.reason, d),
    failures: streak + 1,
    lastError: f.detail,
  };
  writeCache(next);
  log("cache", () => `backoff set (${f.reason}: ${f.detail}) for ${delayS} s, streak ${next.failures}`);
  return present(next, f.status, `${f.detail}; retry in ${Math.ceil(delayS)} s`, d.config, nowS);
}
