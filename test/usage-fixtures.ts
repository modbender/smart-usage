// Reading fixtures for the policy and hook tests, built relative to a given `now`.

import { type Config, DEFAULTS } from "../src/config.ts";
import { PLAN_LABELS } from "../src/source/plan.ts";
import { type PlanId, type Reading, type ScopedLimit, type Snapshot, WINDOW_SECONDS, type WindowKind } from "../src/types.ts";

export interface WindowSpec {
  usedPct: number;
  /** Fraction of the window elapsed at `now`; default 0.5. */
  elapsed?: number;
  /** Override resetsAt outright (epoch seconds), or null for none. */
  resetsAt?: number | null;
}

export interface ReadingSpec {
  now: number;
  plan?: PlanId;
  windows: Partial<Record<WindowKind, WindowSpec>>;
  scoped?: { model: string; usedPct: number; resetsAt?: number | null }[];
  /** Seconds since the snapshot was fetched; default 30. */
  ageSeconds?: number;
}

export function makeReading(spec: ReadingSpec): Reading {
  const age = spec.ageSeconds ?? 30;
  const plan = spec.plan ?? "max5";
  const windows: Snapshot["windows"] = {};
  for (const [kind, w] of Object.entries(spec.windows) as [WindowKind, WindowSpec][]) {
    const len = WINDOW_SECONDS[kind];
    const elapsed = w.elapsed ?? 0.5;
    const resetsAt = w.resetsAt !== undefined ? w.resetsAt : spec.now + (1 - elapsed) * len;
    windows[kind] = {
      kind,
      usedPct: w.usedPct,
      resetsAt,
      startedAt: resetsAt === null ? null : resetsAt - len,
      severity: null,
    };
  }
  const scoped: ScopedLimit[] = (spec.scoped ?? []).map((s) => ({
    model: s.model,
    usedPct: s.usedPct,
    resetsAt: s.resetsAt !== undefined ? s.resetsAt : spec.now + 3 * 86400,
    active: true,
  }));
  return {
    snapshot: {
      fetchedAt: spec.now - age,
      windows,
      scoped,
      plan: { id: plan, label: PLAN_LABELS[plan], source: "config" },
    },
    status: age > DEFAULTS.staleSeconds ? "stale" : "fresh",
    ageSeconds: age,
  };
}

export const NO_SNAPSHOT: Reading = { snapshot: null, status: "no_credentials", ageSeconds: null };

/** DEFAULTS with a deep patch on top, for tests that tune one knob. */
export function configWith(patch: (c: Config) => void = () => {}): Config {
  const c = structuredClone(DEFAULTS);
  patch(c);
  return c;
}
