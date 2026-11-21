// Contract shared by the source layer (src/source/) and the policy/hook layer.

export const WINDOW_KINDS = ["five_hour", "seven_day"] as const;
export type WindowKind = (typeof WINDOW_KINDS)[number];

export const WINDOW_SECONDS: Record<WindowKind, number> = {
  five_hour: 5 * 3600,
  seven_day: 7 * 24 * 3600,
};

export interface UsageWindow {
  kind: WindowKind;
  /** 0-100, as the API reports it. */
  usedPct: number;
  /** Epoch seconds; null while the window has not started (nothing used yet). */
  resetsAt: number | null;
  /** Epoch seconds; from the API when it says so, otherwise resetsAt - window length. */
  startedAt: number | null;
  /** The API's own label for the window ("normal", ...), when it sends one. */
  severity: string | null;
}

/** A per-model weekly limit (e.g. a weekly cap on one model family). */
export interface ScopedLimit {
  model: string;
  usedPct: number;
  resetsAt: number | null;
  active: boolean;
}

export const PLAN_IDS = ["pro", "max5", "max20", "ultra", "team", "enterprise", "unknown"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export type PlanSource = "config" | "display_name" | "rate_limit_tier" | "organization_type" | "none";

export interface PlanInfo {
  id: PlanId;
  /** Human label, e.g. "Ultra" or "Max 5x"; the API's display name when it sent one. */
  label: string;
  source: PlanSource;
}

export interface Snapshot {
  /** Epoch seconds when the usage response was received. */
  fetchedAt: number;
  /** A window missing here was not reported (e.g. no 5-hour limit on the plan). */
  windows: Partial<Record<WindowKind, UsageWindow>>;
  scoped: ScopedLimit[];
  plan: PlanInfo;
}

/**
 * fresh     -- fetched in this call
 * cached    -- from the shared cache, younger than refreshSeconds
 * stale     -- older than staleSeconds; usable only as a floor while a window's resetsAt is ahead
 * backoff   -- the endpoint asked us to wait (429) or keeps failing; cache returned as is
 * auth      -- token expired or rejected; cache returned as is
 * no_credentials -- no OAuth login (API-key user, or logged out); snapshot is null
 * error     -- anything else; cache returned as is
 */
export type SourceStatus = "fresh" | "cached" | "stale" | "backoff" | "auth" | "no_credentials" | "error";

export interface Reading {
  snapshot: Snapshot | null;
  status: SourceStatus;
  /** Seconds since snapshot.fetchedAt; null without a snapshot. */
  ageSeconds: number | null;
  /** Short reason for a non-fresh status, for the debug log and /smart-usage status. */
  detail?: string;
}
