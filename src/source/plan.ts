// Plan detection: a table of matchers, first hit wins (docs/design.md section 2).

import { log } from "../log.ts";
import type { PlanId, PlanInfo, PlanSource } from "../types.ts";

/** The profile fields plan detection uses, as stored in the cache. */
export interface ProfileInfo {
  /** Epoch seconds when the profile was fetched. */
  fetchedAt: number;
  displayName: string | null;
  rateLimitTier: string | null;
  organizationType: string | null;
}

export interface PlanInputs {
  configPlan: PlanId | "auto";
  profile: ProfileInfo | null;
  /** `rateLimitTier` from the credentials store; often stale. */
  credentialsTier: string | null;
}

export const PLAN_LABELS: Record<PlanId, string> = {
  pro: "Pro",
  max5: "Max 5x",
  max20: "Max 20x",
  ultra: "Ultra",
  team: "Team",
  enterprise: "Enterprise",
  unknown: "Unknown",
};

/** All patterns must match for the row to apply. */
type PatternRow = { all: RegExp[]; plan: PlanId };

// Whole words only: "Maximum" is not Max, and "Max (2026)" is not Max 20x.
const DISPLAY_NAME_ROWS: PatternRow[] = [
  { all: [/ultra/i], plan: "ultra" },
  { all: [/\bmax\b/i, /\b20x?\b/i], plan: "max20" },
  // The current Max plan is displayed as plain "Max" (formerly "Max 5x").
  { all: [/\bmax\b/i], plan: "max5" },
  { all: [/\bpro\b/i], plan: "pro" },
  { all: [/team/i], plan: "team" },
  { all: [/enterprise/i], plan: "enterprise" },
];

// Max 20x was renamed Ultra and the tier string kept the old name, so max20 is reachable
// only through a display name that still says "Max 20x".
const TIER_ROWS: PatternRow[] = [
  { all: [/^default_claude_max_20x$/i], plan: "ultra" },
  { all: [/^default_claude_max_5x$/i], plan: "max5" },
  { all: [/pro/i], plan: "pro" },
];

// `claude_max` alone is ambiguous (5x or 20x) and falls through.
const ORGANIZATION_TYPE_ROWS: PatternRow[] = [
  { all: [/^claude_pro$/i], plan: "pro" },
  { all: [/^claude_team$/i], plan: "team" },
  { all: [/^claude_enterprise$/i], plan: "enterprise" },
];

const matchRows = (rows: PatternRow[], value: string | null | undefined): PlanId | null =>
  value ? (rows.find((r) => r.all.every((re) => re.test(value)))?.plan ?? null) : null;

interface Matcher {
  source: PlanSource;
  /** Says where the value came from in the debug log. */
  origin: string;
  match: (inputs: PlanInputs) => PlanId | null;
}

// The credentials tier has no PlanSource of its own; it is a rate-limit tier, read from a
// different store, so it reports as "rate_limit_tier" and the log names the store.
const MATCHERS: Matcher[] = [
  { source: "config", origin: "config.plan", match: (i) => (i.configPlan === "auto" ? null : i.configPlan) },
  { source: "display_name", origin: "profile", match: (i) => matchRows(DISPLAY_NAME_ROWS, i.profile?.displayName) },
  { source: "rate_limit_tier", origin: "profile", match: (i) => matchRows(TIER_ROWS, i.profile?.rateLimitTier) },
  {
    source: "organization_type",
    origin: "profile",
    match: (i) => matchRows(ORGANIZATION_TYPE_ROWS, i.profile?.organizationType),
  },
  { source: "rate_limit_tier", origin: "credentials", match: (i) => matchRows(TIER_ROWS, i.credentialsTier) },
];

export function detectPlan(inputs: PlanInputs): PlanInfo {
  const displayName = inputs.profile?.displayName ?? null;
  for (const m of MATCHERS) {
    const id = m.match(inputs);
    if (!id) continue;
    const label = m.source === "config" ? PLAN_LABELS[id] : (displayName ?? PLAN_LABELS[id]);
    log("plan", () => `detected ${id} from ${m.source} (${m.origin})`);
    return { id, label, source: m.source };
  }
  log("plan", () => "no plan detected; unknown");
  return { id: "unknown", label: displayName ?? PLAN_LABELS.unknown, source: "none" };
}
