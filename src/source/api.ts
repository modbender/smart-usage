// The two undocumented OAuth endpoints Claude Code's /usage view reads, fetched and parsed
// defensively: anything unexpected drops that field, never the whole reading.

import { asObj, finiteNumber, nonEmptyString, type Json } from "../json.ts";
import { log } from "../log.ts";
import { WINDOW_SECONDS, type ScopedLimit, type Snapshot, type UsageWindow, type WindowKind } from "../types.ts";
import type { ProfileInfo } from "./plan.ts";

export const DEFAULT_API_BASE = "https://api.anthropic.com";
export const USAGE_PATH = "/api/oauth/usage";
export const PROFILE_PATH = "/api/oauth/profile";
const OAUTH_BETA = "oauth-2025-04-20";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** SMART_USAGE_API_BASE (tests) is honoured only for loopback hosts, so the token never leaves for anywhere else. */
export function apiBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SMART_USAGE_API_BASE;
  if (!raw) return DEFAULT_API_BASE;
  try {
    const url = new URL(raw);
    if ((url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname)) {
      return raw.replace(/\/+$/, "");
    }
  } catch {
    /* unparsable: ignored below */
  }
  log("fetch", () => "ignored SMART_USAGE_API_BASE: not a loopback http(s) URL");
  return DEFAULT_API_BASE;
}

// ---- parsing -----------------------------------------------------------------------------


/** ISO-8601 to epoch seconds; null when absent or unparsable. */
const epochSeconds = (v: unknown): number | null => {
  const s = nonEmptyString(v);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

const at = (root: Json, path: readonly string[]): unknown =>
  path.reduce<unknown>((node, key) => asObj(node)?.[key], root);

interface WindowSpec {
  kind: WindowKind;
  field: string;
  /** Where the API states the window's real start, when it does. */
  startedAtPath?: readonly string[];
  /** `limits[].kind` values that describe this window (for its severity label). */
  limitKinds: readonly string[];
}

const WINDOW_SPECS: readonly WindowSpec[] = [
  { kind: "five_hour", field: "five_hour", limitKinds: [] },
  {
    kind: "seven_day",
    field: "seven_day",
    startedAtPath: ["seven_day_breakdown", "window_started_at"],
    limitKinds: ["weekly_all"],
  },
];

/** Legacy per-model weekly fields; same shape as `seven_day`. */
const LEGACY_SCOPED_FIELDS: readonly { field: string; model: string }[] = [
  { field: "seven_day_opus", model: "Opus" },
  { field: "seven_day_sonnet", model: "Sonnet" },
];

const SCOPED_LIMIT_KIND = "weekly_scoped";

const limitsOf = (root: Json): Json[] =>
  Array.isArray(root.limits) ? root.limits.map(asObj).filter((l): l is Json => l !== null) : [];

function parseWindow(root: Json, spec: WindowSpec, limits: Json[]): UsageWindow | null {
  const raw = asObj(root[spec.field]);
  if (!raw) return null;
  const usedPct = finiteNumber(raw.utilization);
  if (usedPct === null || usedPct < 0) {
    log("fetch", () => `dropped ${spec.kind}: utilization ${JSON.stringify(raw.utilization)}`);
    return null;
  }
  const resetsAt = epochSeconds(raw.resets_at);
  const stated = spec.startedAtPath ? epochSeconds(at(root, spec.startedAtPath)) : null;
  const startedAt = stated ?? (resetsAt === null ? null : resetsAt - WINDOW_SECONDS[spec.kind]);
  const limit = limits.find((l) => spec.limitKinds.includes(String(l.kind)));
  const severity = nonEmptyString(raw.severity) ?? nonEmptyString(limit?.severity) ?? null;
  return { kind: spec.kind, usedPct, resetsAt, startedAt, severity };
}

function parseScopedLimit(limit: Json): ScopedLimit | null {
  if (limit.kind !== SCOPED_LIMIT_KIND) return null;
  const model = nonEmptyString(at(limit, ["scope", "model", "display_name"]));
  const usedPct = finiteNumber(limit.percent);
  if (!model || usedPct === null) return null;
  return { model, usedPct, resetsAt: epochSeconds(limit.resets_at), active: limit.is_active === true };
}

export type UsageParts = Pick<Snapshot, "windows" | "scoped">;

/** Null only when the body is not an object at all; a malformed part drops that part only. */
export function parseUsage(body: unknown): UsageParts | null {
  const root = asObj(body);
  if (!root) return null;
  const limits = limitsOf(root);
  const windows: Snapshot["windows"] = {};
  for (const spec of WINDOW_SPECS) {
    const w = parseWindow(root, spec, limits);
    if (w) windows[spec.kind] = w;
  }
  const scoped = limits.map(parseScopedLimit).filter((s): s is ScopedLimit => s !== null);
  const known = new Set(scoped.map((s) => s.model.toLowerCase()));
  for (const { field, model } of LEGACY_SCOPED_FIELDS) {
    const raw = asObj(root[field]);
    const usedPct = finiteNumber(raw?.utilization);
    if (!raw || usedPct === null || known.has(model.toLowerCase())) continue;
    scoped.push({ model, usedPct, resetsAt: epochSeconds(raw.resets_at), active: true });
  }
  return { windows, scoped };
}

export function parseProfile(body: unknown, nowS: number): ProfileInfo | null {
  const org = asObj(asObj(body)?.organization);
  if (!org) return null;
  return {
    fetchedAt: nowS,
    displayName: nonEmptyString(org.plan_display_name),
    rateLimitTier: nonEmptyString(org.rate_limit_tier),
    organizationType: nonEmptyString(org.organization_type),
  };
}

// ---- fetching ----------------------------------------------------------------------------

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export type FetchResult =
  | { kind: "ok"; body: unknown }
  | { kind: "http"; status: number; retryAfter: string | null }
  | { kind: "timeout" }
  | { kind: "network"; detail: string }
  | { kind: "bad_body" };

export interface FetchOptions {
  base: string;
  token: string;
  timeoutMs: number;
  fetchImpl: FetchImpl;
}

/**
 * The errno-style code of a failed fetch: bun puts it on the error, node's undici on
 * `error.cause`. Never the message, which can carry the URL.
 */
export function networkErrorCode(e: unknown): string {
  const code = (v: unknown): string | null => {
    const c = (v as { code?: unknown } | null)?.code;
    return typeof c === "string" && c !== "" ? c : null;
  };
  return code(e) ?? code((e as { cause?: unknown } | null)?.cause) ?? "fetch failed";
}

/** GETs `path`; never throws. The token goes only into the Authorization header and is never logged. */
export async function fetchJson(path: string, opts: FetchOptions): Promise<FetchResult> {
  const started = Date.now();
  const ms = () => Date.now() - started;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  log("fetch", () => `GET ${path} start`);
  try {
    const res = await opts.fetchImpl(`${opts.base}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "anthropic-beta": OAUTH_BETA,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (res.status !== 200) {
      const retryAfter = res.headers.get("retry-after");
      await res.body?.cancel().catch(() => {});
      log("fetch", () => `GET ${path} -> ${res.status} in ${ms()} ms`);
      return { kind: "http", status: res.status, retryAfter };
    }
    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch (e) {
      if (controller.signal.aborted) throw e;
      log("fetch", () => `GET ${path} -> 200 with unparsable body in ${ms()} ms`);
      return { kind: "bad_body" };
    }
    log("fetch", () => `GET ${path} -> 200 in ${ms()} ms`);
    return { kind: "ok", body };
  } catch (e) {
    if (controller.signal.aborted) {
      log("fetch", () => `GET ${path} timed out after ${ms()} ms`);
      return { kind: "timeout" };
    }
    const detail = networkErrorCode(e);
    log("fetch", () => `GET ${path} failed in ${ms()} ms: ${detail}`);
    return { kind: "network", detail };
  } finally {
    clearTimeout(timer);
  }
}

/** Retry-After as seconds (delta-seconds or HTTP-date); null when absent or unparsable. */
export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - nowMs) / 1000)) : null;
}
