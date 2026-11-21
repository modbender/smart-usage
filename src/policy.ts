// What a reading means: per-window headroom, level and pace caps, the overall cap, model advice.
// Pure: no I/O apart from the debug log, and `now` (epoch seconds) is always passed in.

import type { Config, PaceRow, TierRow } from "./config.ts";
import { log } from "./log.ts";
import {
  type PlanInfo,
  type Reading,
  type SourceStatus,
  type UsageWindow,
  WINDOW_KINDS,
  WINDOW_SECONDS,
  type WindowKind,
} from "./types.ts";

/**
 * fresh       -- reading younger than staleSeconds
 * floor       -- older reading while resetsAt is ahead: usage only rises within a window, so
 *                the figure is a lower bound and its cap still holds (or is too lenient)
 * rolled_over -- resetsAt has passed: a new window, treated as 0% used
 * no_reading  -- older reading without resetsAt: nothing says it is still the same window
 */
export type WindowBasis = "fresh" | "floor" | "rolled_over" | "no_reading";

export interface WindowAssessment {
  kind: WindowKind;
  basis: WindowBasis;
  /** Effective % used: 0 after a rollover, null without a usable reading. */
  usedPct: number | null;
  resetsAt: number | null;
  multiplier: number;
  /** (100 - usedPct) * multiplier, in Max 5x-equivalent percent. */
  headroom: number | null;
  /** Fraction of the window elapsed (0..1), null when the start is unknown. */
  elapsed: number | null;
  /** End-of-window % at the current rate; null until pace counts (minElapsed and minUsedPct met). */
  projected: number | null;
  /** null: the level tiers set no cap. */
  levelCap: number | null;
  /** null: pace sets no cap (or does not count yet). */
  paceCap: number | null;
  /** min(level cap, pace cap), clamped to normalCap. */
  cap: number;
}

export type ScopedLevel = "warn" | "avoid";

export interface ScopedAssessment {
  model: string;
  usedPct: number;
  resetsAt: number | null;
  level: ScopedLevel;
}

export interface Override {
  cap: number;
  /** Epoch seconds. */
  until: number;
  reason?: string;
}

export interface Assessment {
  now: number;
  plan: PlanInfo | null;
  status: SourceStatus;
  /** Seconds since the snapshot was fetched; null without a snapshot. */
  ageSeconds: number | null;
  normalCap: number;
  /**
   * The plan's normal: min(normalCap, the level cap each reported window gives at 0% used).
   * Below normalCap on small plans (Pro's 5-hour window gives cap 2 with nothing spent).
   */
  baseline: number;
  windows: WindowAssessment[];
  /** Cap from the windows alone, before any override. */
  computedCap: number;
  /** The cap in force: the live override's when there is one, else computedCap. */
  cap: number;
  /** The window with the lowest cap (ties: least headroom); null without windows. */
  binding: WindowKind | null;
  /** The override file's content while it is live. */
  override: Override | null;
  /** Windows projected at or past warnProjectedPct. */
  paceWarnings: WindowKind[];
  /** Per-model limits at or past scopedWarnPct (only with model steering on). */
  scoped: ScopedAssessment[];
  /** Advise smaller models for subagents. */
  steerSmaller: boolean;
  /** Anything worth telling the model: a cap below the baseline, a pace warning or a scoped warning. */
  pressure: boolean;
}

// Float multipliers (0.2) make (100 - 25) * 0.2 land at 15.000000000000002; the tolerance keeps
// the tiers inclusive at their exact boundaries.
const TIER_EPSILON = 1e-9;

const levelCapFor = (rows: readonly TierRow[], headroom: number): number | null =>
  rows.find((r) => headroom <= r.atMost + TIER_EPSILON)?.cap ?? null;

const paceCapFor = (rows: readonly PaceRow[], projected: number): number | null =>
  rows.find((r) => projected >= r.projected)?.cap ?? null;

const clampCap = (cap: number, normalCap: number): number => Math.max(0, Math.min(normalCap, Math.floor(cap)));

const lowest = (...caps: (number | null)[]): number | null =>
  caps.reduce<number | null>((min, c) => (c === null ? min : min === null ? c : Math.min(min, c)), null);

export function multiplierFor(config: Config, plan: PlanInfo | null, kind: WindowKind): number {
  return config.multipliers[plan?.id ?? "unknown"]?.[kind] ?? 1;
}

/** The level cap a window gives at 0% used on this plan; null when the tiers set none. */
const levelCapAtZero = (config: Config, plan: PlanInfo | null, kind: WindowKind): number | null =>
  levelCapFor(config.tiers[kind] ?? [], 100 * multiplierFor(config, plan, kind));

export function assessWindow(
  w: UsageWindow,
  config: Config,
  plan: PlanInfo | null,
  stale: boolean,
  now: number,
): WindowAssessment {
  const multiplier = multiplierFor(config, plan, w.kind);
  const normal = config.normalCap;
  const base = { kind: w.kind, resetsAt: w.resetsAt, multiplier };
  // A reset or unusable window counts as empty, never as looser than empty: on Pro that is
  // still cap 2, so missing data cannot lift the cap above the plan's baseline.
  const atZero = levelCapAtZero(config, plan, w.kind);
  const none = { elapsed: null, projected: null, levelCap: atZero, paceCap: null, cap: clampCap(atZero ?? normal, normal) };

  if (w.resetsAt !== null && w.resetsAt <= now) {
    return { ...base, ...none, basis: "rolled_over", usedPct: 0, headroom: 100 * multiplier };
  }
  if (stale && w.resetsAt === null) {
    return { ...base, ...none, basis: "no_reading", usedPct: null, headroom: null };
  }

  const usedPct = Math.max(0, w.usedPct);
  const headroom = (100 - usedPct) * multiplier;
  const levelCap = levelCapFor(config.tiers[w.kind] ?? [], headroom);

  const len = WINDOW_SECONDS[w.kind];
  const startedAt = w.startedAt ?? (w.resetsAt !== null ? w.resetsAt - len : null);
  const elapsed = startedAt === null ? null : Math.min(1, Math.max(0, (now - startedAt) / len));
  const paceCounts =
    config.pace.enabled &&
    elapsed !== null &&
    elapsed > 0 &&
    elapsed >= (config.pace.minElapsed[w.kind] ?? 1) &&
    usedPct >= (config.pace.minUsedPct[w.kind] ?? 100);
  const projected = paceCounts ? usedPct / elapsed : null;
  const paceCap = projected === null ? null : paceCapFor(config.pace.rows[w.kind] ?? [], projected);

  return {
    ...base,
    basis: stale ? "floor" : "fresh",
    usedPct,
    headroom,
    elapsed,
    projected,
    levelCap,
    paceCap,
    cap: clampCap(lowest(levelCap, paceCap) ?? normal, normal),
  };
}

/** The plan's normal cap: what the level tiers give every reported window at 0% used. */
export function baselineCap(config: Config, plan: PlanInfo | null, kinds: readonly WindowKind[]): number {
  let baseline = config.normalCap;
  for (const kind of kinds) {
    const atZero = levelCapAtZero(config, plan, kind);
    if (atZero !== null) baseline = Math.min(baseline, clampCap(atZero, config.normalCap));
  }
  return baseline;
}

/** The override while `until` is ahead, its cap clamped to 0..normalCap; otherwise null. */
export function liveOverride(o: Override | null | undefined, normalCap: number, now: number): Override | null {
  if (!o || !Number.isFinite(o.cap) || !Number.isFinite(o.until) || o.until <= now) return null;
  return { ...o, cap: clampCap(o.cap, normalCap) };
}

function scopedFor(reading: Reading | null, config: Config, now: number): ScopedAssessment[] {
  const s = config.modelSteering;
  if (!s.enabled) return [];
  const out: ScopedAssessment[] = [];
  for (const l of reading?.snapshot?.scoped ?? []) {
    if (l.resetsAt !== null && l.resetsAt <= now) continue;
    if (l.usedPct < s.scopedWarnPct) continue;
    out.push({
      model: l.model,
      usedPct: l.usedPct,
      resetsAt: l.resetsAt,
      level: l.usedPct >= s.scopedAvoidPct ? "avoid" : "warn",
    });
  }
  return out;
}

export function assess(
  reading: Reading | null,
  config: Config,
  now: number,
  override: Override | null = null,
): Assessment {
  const normalCap = config.normalCap;
  const snap = reading?.snapshot ?? null;
  const ageSeconds = snap ? Math.max(0, now - snap.fetchedAt) : null;
  const stale = ageSeconds !== null && ageSeconds > config.staleSeconds;
  const plan = snap?.plan ?? null;

  const windows: WindowAssessment[] = [];
  for (const kind of WINDOW_KINDS) {
    const w = snap?.windows[kind];
    if (w) windows.push(assessWindow(w, config, plan, stale, now));
  }

  let binding: WindowAssessment | null = null;
  for (const w of windows) {
    if (
      !binding ||
      w.cap < binding.cap ||
      (w.cap === binding.cap && (w.headroom ?? Infinity) < (binding.headroom ?? Infinity))
    ) {
      binding = w;
    }
  }
  const computedCap = clampCap(binding?.cap ?? normalCap, normalCap);
  const live = liveOverride(override, normalCap, now);
  const cap = live ? live.cap : computedCap;

  const paceWarnings = windows
    .filter((w) => w.projected !== null && w.projected >= config.warnProjectedPct)
    .map((w) => w.kind);
  const scoped = scopedFor(reading, config, now);
  const baseline = baselineCap(
    config,
    plan,
    windows.map((w) => w.kind),
  );
  const capped = isBelowBaseline({ cap, baseline });
  const steerSmaller = config.modelSteering.enabled && (capped || paceWarnings.length > 0);
  const pressure = capped || paceWarnings.length > 0 || scoped.length > 0;

  const a: Assessment = {
    now,
    plan,
    status: reading?.status ?? "error",
    ageSeconds,
    normalCap,
    baseline,
    windows,
    computedCap,
    cap,
    binding: binding?.kind ?? null,
    override: live,
    paceWarnings,
    scoped,
    steerSmaller,
    pressure,
  };
  log("policy", () => describeAssessment(a));
  return a;
}

/** The cap in force is below the plan's own normal: that, and only that, is a capped state. */
export const isBelowBaseline = (a: Pick<Assessment, "cap" | "baseline">): boolean => a.cap < a.baseline;

/** The plan's normal is below normalCap (Pro: 2 of 3), so lines name it. */
export const hasReducedBaseline = (a: Pick<Assessment, "baseline" | "normalCap">): boolean => a.baseline < a.normalCap;

/** A usable reading: at least one reported window. Without one the hooks say nothing. */
export const hasWindows = (a: Pick<Assessment, "windows">): boolean => a.windows.length > 0;

/** One decimal place, for logs and status output. */
export const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

/** One-line summary of an assessment and its inputs, for the debug log and hook verdicts. */
export function describeAssessment(a: Assessment): string {
  const r1 = (n: number | null): string => String(round1(n) ?? "-");
  const wins = a.windows
    .map(
      (w) =>
        `${w.kind}[${w.basis} used=${r1(w.usedPct)} x${w.multiplier} head=${r1(w.headroom)} ` +
        `el=${r1(w.elapsed)} proj=${r1(w.projected)} level=${w.levelCap ?? "-"} pace=${w.paceCap ?? "-"} cap=${w.cap}]`,
    )
    .join(" ");
  return (
    `plan=${a.plan?.id ?? "none"}(${a.plan?.source ?? "-"}) status=${a.status} age=${a.ageSeconds === null ? "-" : Math.round(a.ageSeconds)}s ` +
    `${wins || "no windows"} computed=${a.computedCap} cap=${a.cap}/${a.normalCap} baseline=${a.baseline} binding=${a.binding ?? "-"}` +
    `${a.override ? ` override=${a.override.cap} until ${a.override.until}` : ""}` +
    ` pace=[${a.paceWarnings.join(",")}] scoped=[${a.scoped.map((s) => `${s.model}:${s.level}`).join(",")}]` +
    ` steer=${a.steerSmaller} pressure=${a.pressure}`
  );
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The scoped limit past scopedAvoidPct that a launch's `model` input names, if any. Matches
 * loosely, since the input is an alias ("opus") and the limit a display name ("Opus 4.5").
 */
export function avoidedModel(a: Assessment, model: unknown): ScopedAssessment | null {
  if (typeof model !== "string" || !model.trim()) return null;
  const m = norm(model);
  return (
    a.scoped.find((s) => {
      if (s.level !== "avoid") return false;
      const name = norm(s.model);
      return name.length > 0 && (m.includes(name) || name.split(" ").includes(m));
    }) ?? null
  );
}
