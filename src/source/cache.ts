// The shared usage cache: one file for every session on this Claude config dir, shared by
// every installed version of the plugin (see paths.ts). Written only by the fetch.lock holder,
// always atomically; a torn file reads as missing.
//
// Cross-version rule: the top-level `v`, `fetchedAt` and `backoffUntil` keep their meaning in
// every future version, and so does the fetch.lock protocol. A reader that finds a newer `v`
// honours those gate fields, never fetches and never writes, so two versions running at once
// share one fetch budget and one 429 backoff instead of overwriting each other's file. Once the
// newer version has stopped writing for NEWER_VERSION_HORIZON_MS (a downgrade), it takes over.

import { statSync } from "node:fs";
import { readJson, writeJsonAtomic } from "../fs-util.ts";
import { finiteNumber, isObj } from "../json.ts";
import { log } from "../log.ts";
import { dataFile } from "../paths.ts";
import type { Snapshot } from "../types.ts";
import type { ProfileInfo } from "./plan.ts";

export const CACHE_VERSION = 1;

/** Why requests are paused; decides the status reported while `backoffUntil` is ahead. */
export const BACKOFF_REASONS = ["rate_limit", "auth", "error", "no_credentials"] as const;
export type BackoffReason = (typeof BACKOFF_REASONS)[number];
const isBackoffReason = (v: unknown): v is BackoffReason => (BACKOFF_REASONS as readonly unknown[]).includes(v);

export interface CacheFile {
  v: number;
  /** Epoch seconds of the last good usage fetch; 0 for none. Gates fetching across versions. */
  fetchedAt: number;
  /** Last good usage reading. Its `plan` is recomputed on every read. */
  snapshot: Snapshot | null;
  profile: ProfileInfo | null;
  /** Epoch seconds before which a failed profile fetch is not retried; 0 for none. */
  profileRetryAt: number;
  /** The credentials store's `rateLimitTier` at the last fetch; the last plan hint. */
  credentialsTier: string | null;
  /** Epoch seconds; 0 when not backing off. Gates fetching across versions. */
  backoffUntil: number;
  backoffReason: BackoffReason | null;
  /** For auth and no_credentials pauses: the credentials stamp they were recorded against. */
  backoffStamp: string | null;
  /** Consecutive failures of `backoffReason`'s kind; drives the doubling. */
  failures: number;
  lastError: string | null;
  /** Not persisted. The file on disk belongs to a newer version: never fetch, never write. */
  readOnly?: boolean;
}

export const EMPTY_CACHE: CacheFile = {
  v: CACHE_VERSION,
  fetchedAt: 0,
  snapshot: null,
  profile: null,
  profileRetryAt: 0,
  credentialsTier: null,
  backoffUntil: 0,
  backoffReason: null,
  backoffStamp: null,
  failures: 0,
  lastError: null,
};

export const cachePath = (): string => dataFile("usage-cache.json");
export const fetchLockPath = (): string => dataFile("fetch.lock");

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const validSnapshot = (s: unknown): s is Snapshot =>
  isObj(s) && typeof s.fetchedAt === "number" && isObj(s.windows) && Array.isArray(s.scoped);

const validProfile = (p: unknown): p is ProfileInfo => isObj(p) && typeof p.fetchedAt === "number";

/**
 * A newer version owns the file only while it keeps writing it. While any of its sessions is
 * active it rewrites the file at least once per refresh interval (a fetch, a backoff and a
 * no-credentials pause all write), so a file untouched this long means that version is no
 * longer running, and this one takes over.
 */
export const NEWER_VERSION_HORIZON_MS = 24 * 3600_000;
const MTIME_SKEW_MS = 60_000;

function newerVersionAlive(): boolean {
  try {
    const age = Date.now() - statSync(cachePath()).mtimeMs;
    return age > -MTIME_SKEW_MS && age < NEWER_VERSION_HORIZON_MS;
  } catch {
    return false;
  }
}

/** The cache, or EMPTY_CACHE when missing, torn or unrecognised; read-only when a live newer version owns it. */
export function readCache(): CacheFile {
  const raw = readJson<unknown>(cachePath());
  // Missing or unparsable reads as null and is logged by the caller as a miss, so polling waiters stay quiet.
  if (!isObj(raw) || typeof raw.v !== "number" || raw.v < CACHE_VERSION) {
    if (raw !== null) log("cache", () => "ignored unrecognised cache file");
    return { ...EMPTY_CACHE };
  }
  if (raw.v > CACHE_VERSION) {
    if (!newerVersionAlive()) {
      log("cache", () => `taking over a v${raw.v} cache file not written for ${NEWER_VERSION_HORIZON_MS / 3600_000} h`);
      return { ...EMPTY_CACHE };
    }
    // Only the gate fields are trusted; the rest of a newer file's shape is unknown.
    log("cache", () => `cache file is v${raw.v} (this is v${CACHE_VERSION}); read-only`);
    return {
      ...EMPTY_CACHE,
      v: raw.v,
      fetchedAt: finiteNumber(raw.fetchedAt) ?? 0,
      backoffUntil: finiteNumber(raw.backoffUntil) ?? 0,
      backoffReason: isBackoffReason(raw.backoffReason) ? raw.backoffReason : "error",
      lastError: "cache owned by a newer smart-usage",
      readOnly: true,
    };
  }
  const snapshot = validSnapshot(raw.snapshot) ? raw.snapshot : null;
  return {
    v: CACHE_VERSION,
    fetchedAt: finiteNumber(raw.fetchedAt) ?? snapshot?.fetchedAt ?? 0,
    snapshot,
    profile: validProfile(raw.profile) ? raw.profile : null,
    profileRetryAt: finiteNumber(raw.profileRetryAt) ?? 0,
    credentialsTier: str(raw.credentialsTier),
    backoffUntil: finiteNumber(raw.backoffUntil) ?? 0,
    backoffReason: isBackoffReason(raw.backoffReason) ? raw.backoffReason : null,
    backoffStamp: str(raw.backoffStamp),
    failures: finiteNumber(raw.failures) ?? 0,
    lastError: str(raw.lastError),
  };
}

/** Refuses (false) for a cache read from a newer version's file. */
export function writeCache(cache: CacheFile): boolean {
  const { readOnly, ...file } = cache;
  if (readOnly || file.v !== CACHE_VERSION) {
    log("cache", () => "not writing: the cache file belongs to a newer version");
    return false;
  }
  return writeJsonAtomic(cachePath(), file);
}
