// Every tunable lives here. Precedence, lowest first:
//   DEFAULTS < <dataDir>/config.json < plugin options (CLAUDE_PLUGIN_OPTION_*) < SMART_USAGE_DEBUG
// Objects merge key by key; arrays replace. Invalid values are dropped (logged under "config").

import { readFileSync } from "node:fs";
import { isTruthyFlag } from "./flags.ts";
import { isObj, type Json } from "./json.ts";
import { log, setDebug } from "./log.ts";
import { dataFile } from "./paths.ts";
import { PLAN_IDS, type PlanId, type WindowKind } from "./types.ts";

/** Remaining headroom in Max 5x-equivalent percent at or below `atMost` gives `cap` (compare with a 1e-9 tolerance). */
export interface TierRow {
  atMost: number;
  cap: number;
}

/** A window projected to end at `projected`% or more of its limit gives `cap`. */
export interface PaceRow {
  projected: number;
  cap: number;
}

export interface Config {
  /** "auto" detects the plan from the account profile. */
  plan: PlanId | "auto";
  /** Agents allowed in flight when nothing is constrained. */
  normalCap: number;
  /** Shared-cache lifetime; at most one usage fetch per this many seconds across all sessions. */
  refreshSeconds: number;
  /** Past this age a reading is only a floor, valid while its window's resetsAt is ahead. */
  staleSeconds: number;
  fetchTimeoutMs: number;
  profileRefreshSeconds: number;
  /** Size of each plan's window relative to Max 5x's same window. A missing entry means 1. */
  multipliers: Record<PlanId, Partial<Record<WindowKind, number>>>;
  /** Highest-pressure row first; rows are checked in order and the first match wins. */
  tiers: Record<WindowKind, TierRow[]>;
  pace: {
    enabled: boolean;
    /** Empty by default: pace warns but sets no cap. */
    rows: Record<WindowKind, PaceRow[]>;
    /** Fraction of the window that must have elapsed before pace counts. */
    minElapsed: Record<WindowKind, number>;
    /** Usage that must be reached before pace counts. */
    minUsedPct: Record<WindowKind, number>;
  };
  /** Projected end-of-window % at which the reading is worth mentioning even without a cap. */
  warnProjectedPct: number;
  modelSteering: {
    enabled: boolean;
    /** A per-model weekly limit at or above this is mentioned. */
    scopedWarnPct: number;
    /** A per-model weekly limit at or above this: advise against that model for new subagents. */
    scopedAvoidPct: number;
  };
  /** Extra text appended to the instruction for a given cap ("0", "1", ...). */
  capNotes: Record<string, string>;
  /** Appended to the first line that lifts a stated cap 0. */
  liftedFromZeroNote: string;
  debug: boolean;
}

export const DEFAULTS: Config = {
  plan: "auto",
  normalCap: 3,
  refreshSeconds: 300,
  staleSeconds: 900,
  fetchTimeoutMs: 3000,
  profileRefreshSeconds: 24 * 3600,
  // Max 5x (now sold as "Max", 5x Pro in both windows) is the reference (1): the tiers below
  // were proven on it. Pro is 1/5 of it. Ultra, formerly Max 20x, is 10x Pro weekly and 20x
  // Pro in the 5-hour window, which only unverified Ultra accounts still have.
  multipliers: {
    pro: { five_hour: 0.2, seven_day: 0.2 },
    max5: { five_hour: 1, seven_day: 1 },
    max20: { five_hour: 4, seven_day: 2 },
    ultra: { five_hour: 4, seven_day: 2 },
    team: { five_hour: 0.2, seven_day: 0.2 },
    enterprise: { five_hour: 0.2, seven_day: 0.2 },
    unknown: { five_hour: 0.2, seven_day: 0.2 },
  },
  tiers: {
    five_hour: [
      { atMost: 5, cap: 0 },
      { atMost: 15, cap: 1 },
      { atMost: 30, cap: 2 },
    ],
    seven_day: [
      { atMost: 3, cap: 0 },
      { atMost: 8, cap: 1 },
      { atMost: 15, cap: 2 },
    ],
  },
  pace: {
    enabled: true,
    // Pace only warns by default: a cap would throttle a legitimate early burst. Rows in
    // config.json opt in to pace caps.
    rows: { five_hour: [], seven_day: [] },
    minElapsed: { five_hour: 0.2, seven_day: 1 / 7 },
    minUsedPct: { five_hour: 20, seven_day: 25 },
  },
  warnProjectedPct: 100,
  modelSteering: { enabled: true, scopedWarnPct: 75, scopedAvoidPct: 90 },
  capNotes: {},
  liftedFromZeroNote: "",
  debug: false,
};

/** Overlay `patch` on `base`, keeping only values whose type matches the base value's type. */
function merge<T>(base: T, patch: unknown, path: string): T {
  if (!isObj(patch) || !isObj(base)) return base;
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = (base as Json)[k];
    const where = `${path}${k}`;
    if (cur === undefined) {
      // Only capNotes is an open map and accepts new keys; every other key must already exist
      // in DEFAULTS (a per-plan multiplier can be changed, not added).
      if (path === "capNotes." && typeof v === "string") out[k] = v;
      else log("config", () => `ignored unknown key ${where}`);
    } else if (Array.isArray(cur)) {
      if (Array.isArray(v)) out[k] = v;
      else log("config", () => `ignored ${where}: expected array`);
    } else if (isObj(cur)) {
      out[k] = merge(cur, v, `${where}.`);
    } else if (typeof v === typeof cur) {
      out[k] = v;
    } else {
      log("config", () => `ignored ${where}: expected ${typeof cur}`);
    }
  }
  return out as T;
}

const optionEnv = (key: string): string | undefined => {
  const v = process.env[`CLAUDE_PLUGIN_OPTION_${key}`];
  return v === undefined || v === "" ? undefined : v;
};

function fromOptions(): Json {
  const out: Json = {};
  const plan = optionEnv("PLAN")?.toLowerCase();
  if (plan && (plan === "auto" || (PLAN_IDS as readonly string[]).includes(plan))) out.plan = plan;
  const cap = Number(optionEnv("NORMAL_CAP"));
  if (Number.isInteger(cap) && cap >= 1) out.normalCap = cap;
  const refresh = Number(optionEnv("REFRESH_SECONDS"));
  if (Number.isFinite(refresh) && refresh >= 60) out.refreshSeconds = refresh;
  const debug = optionEnv("DEBUG");
  if (debug !== undefined) out.debug = isTruthyFlag(debug);
  return out;
}

// Hook time budget, against the 10 s timeout in hooks/hooks.json: node start (~0.3 s), stdin
// (1 s cap, src/hooks/common.ts), one macOS keychain read (2 s, src/source/credentials.ts), one
// fetch or wait for another fetcher (fetchTimeoutMs), two trace-lock waits (0.5 s each,
// src/trace.ts). The clamp keeps the worst case near 8.3 s.
const FETCH_TIMEOUT_MS = { min: 500, max: 4000 };

function sane(c: Config): Config {
  const plan = c.plan === "auto" || (PLAN_IDS as readonly string[]).includes(c.plan) ? c.plan : "auto";
  return {
    ...c,
    plan,
    normalCap: Math.max(1, Math.floor(c.normalCap)),
    refreshSeconds: Math.max(60, c.refreshSeconds),
    staleSeconds: Math.max(c.refreshSeconds, c.staleSeconds),
    fetchTimeoutMs: Math.min(FETCH_TIMEOUT_MS.max, Math.max(FETCH_TIMEOUT_MS.min, c.fetchTimeoutMs)),
  };
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  let file: unknown = {};
  try {
    file = JSON.parse(readFileSync(dataFile("config.json"), "utf8"));
  } catch {
    /* no config file is the normal case */
  }
  cached = sane(merge(merge(DEFAULTS, file, ""), fromOptions(), ""));
  setDebug(cached.debug);
  return cached;
}

/** Tests only. */
export const resetConfigCache = (): void => {
  cached = null;
};
