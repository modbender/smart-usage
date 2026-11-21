// Every string smart-usage injects into a conversation, built from an Assessment.
//
// Supersede rule: injected lines stay in context and keep reading as current, so every line
// restates everything in force (plan, every reported window, the cap, model advice) and says
// it supersedes earlier smart-usage lines. A line that dropped a part would silently retract it.

import type { Config } from "./config.ts";
import {
  type Assessment,
  hasReducedBaseline,
  isBelowBaseline,
  type ScopedAssessment,
  type WindowAssessment,
} from "./policy.ts";
import type { WindowKind } from "./types.ts";

export const WINDOW_LABEL: Record<WindowKind, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
};

/** "2026-11-21T10:26Z": a reading that survives into a later hour is visibly old. */
export const stamp = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toISOString().replace(/:\d\d\.\d+Z$/, "Z");

/** "45m", "2h 40m", "3d 4h". Past 48 hours, hours stop being readable. */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

// Rounded down, so a figure never reads as a tier the reading has not reached.
const pct = (value: number): string => `${Math.floor(value)}%`;

const resetIn = (resetsAt: number | null, now: number): string | null =>
  resetsAt !== null && resetsAt > now ? `resets in ${formatDuration(resetsAt - now)}` : null;

function windowPart(w: WindowAssessment, a: Assessment): string {
  const label = `${WINDOW_LABEL[w.kind]} window`;
  if (w.basis === "rolled_over") return `${label} has reset`;
  if (w.basis === "no_reading" || w.usedPct === null) return `${label}: no current reading`;
  const used =
    w.basis === "floor"
      ? `at least ${pct(w.usedPct)} used as of ${Math.round((a.ageSeconds ?? 0) / 60)} min ago`
      : `${pct(w.usedPct)} used`;
  const extras = [
    resetIn(w.resetsAt, a.now),
    w.projected !== null ? `on pace for ${Math.round(w.projected)}% by reset` : null,
  ].filter(Boolean);
  return [`${label} ${used}`, ...extras].join(", ");
}

/** "smart-usage, 2026-11-21T10:26Z: Max 5x plan; 5-hour window 88% used, resets in 2h 40m." */
export function usageHead(a: Assessment): string {
  const plan = a.plan ? `${a.plan.label} plan` : "plan unknown";
  const parts = a.windows.map((w) => windowPart(w, a));
  const body = parts.length > 0 ? parts.join("; ") : "no usage reading";
  const floors = a.windows.some((w) => w.basis === "floor")
    ? ' Figures marked "at least" are from an older reading; within a window usage only rises.'
    : "";
  return `smart-usage, ${stamp(a.now)}: ${plan}; ${body}.${floors}`;
}

const CAP_LIMITS =
  "The cap limits new launches only; cutting verification or scope on budget grounds needs the user's approval.";

/** The instruction for a cap below normalCap. Cap 0 and 1 have their own wording; the rest share one. */
const CAP_RULE: Record<number, (cap: number) => string> = {
  0: () => "no new subagents or workflows; finish and checkpoint current work, then continue inline",
  1: () => "at most 1 subagent in flight, a Workflow's agents included; run parallel stages one after another",
};
const defaultCapRule = (cap: number): string => `at most ${cap} subagents in flight, a Workflow's agents included`;

function capSource(a: Assessment): string {
  if (a.override) {
    const reason = a.override.reason ? `: ${a.override.reason}` : "";
    return ` (set by the user's override until ${stamp(a.override.until)}${reason})`;
  }
  return a.binding && isBelowBaseline(a) ? ` (from the ${WINDOW_LABEL[a.binding]} window)` : "";
}

const planName = (a: Assessment): string => (a.plan ? `the ${a.plan.label} plan` : "this plan");

/**
 * The cap sentence. `prevCap` is the cap last stated to this conversation, if any; a lower one
 * gets an explicit lift so the earlier line stops reading as current. A cap below normalCap
 * always says why: pressure (the binding window or the override) or the plan's baseline.
 */
export function capText(a: Assessment, config: Config, prevCap?: number): string {
  const note = config.capNotes[String(a.cap)] ? ` ${config.capNotes[String(a.cap)]}` : "";
  const fromZero = prevCap === 0 && a.cap > 0 && config.liftedFromZeroNote ? ` ${config.liftedFromZeroNote}` : "";
  const lifted = prevCap !== undefined && prevCap < a.cap && !isBelowBaseline(a);
  const rule = (CAP_RULE[a.cap] ?? defaultCapRule)(a.cap);
  // Whenever the cap in force is not the plan's own normal, the line still says what that is.
  const planNormal =
    hasReducedBaseline(a) && a.cap !== a.baseline ? ` Up to ${a.baseline} in flight is normal for ${planName(a)}.` : "";

  if (isBelowBaseline(a)) {
    return `Subagent cap ${a.cap}${capSource(a)}: ${rule}.${fromZero} ${CAP_LIMITS}${planNormal}${note}`;
  }
  if (a.cap < a.normalCap) {
    const why = a.override ? capSource(a) : ` (normal for ${planName(a)})`;
    const earlier = lifted ? ` Any lower cap stated earlier no longer applies.${fromZero}` : "";
    return `Subagent cap ${lifted ? "back to " : ""}${a.cap}${why}: ${rule}.${earlier} ${CAP_LIMITS}${planNormal}${note}`;
  }
  if (lifted) {
    return (
      `Subagent cap lifted${capSource(a)}: back to normal, up to ${a.normalCap} in flight; ` +
      `any lower cap stated earlier no longer applies.${fromZero}${planNormal}`
    );
  }
  return `Subagent cap: normal${capSource(a)}, up to ${a.normalCap} in flight.${planNormal}`;
}

function scopedText(s: ScopedAssessment, now: number): string {
  const reset = resetIn(s.resetsAt, now);
  const head = `${s.model} weekly limit ${pct(s.usedPct)} used${reset ? ` (${reset})` : ""}`;
  return s.level === "avoid" ? `${head}: do not choose ${s.model} for new subagents.` : `${head}.`;
}

/** Model advice in force: smaller models under pressure, plus each per-model limit worth naming. */
export function modelAdvice(a: Assessment): string[] {
  return [
    a.steerSmaller ? "Prefer smaller models for subagents where the task allows." : "",
    ...a.scoped.map((s) => scopedText(s, a.now)),
  ].filter(Boolean);
}

export const SUPERSEDE = "This supersedes every earlier smart-usage line in this conversation.";

export interface LineOptions {
  /** The cap last stated to this conversation. */
  prevCap?: number;
  /** One more sentence, e.g. the gate's note on a launch that names an avoided model. */
  extra?: string;
}

/** The one line every hook emits. */
export function usageLine(a: Assessment, config: Config, opts: LineOptions = {}): string {
  const pace =
    a.paceWarnings.length > 0
      ? `At the current rate the ${a.paceWarnings.map((k) => WINDOW_LABEL[k]).join(" and ")} ` +
        `${a.paceWarnings.length > 1 ? "windows run" : "window runs"} out before reset.`
      : "";
  return [
    usageHead(a),
    a.pressure ? "" : hasReducedBaseline(a) ? "Nothing is constrained beyond the plan's normal." : "Nothing is constrained.",
    capText(a, config, opts.prevCap),
    pace,
    ...modelAdvice(a),
    opts.extra ?? "",
    SUPERSEDE,
  ]
    .filter(Boolean)
    .join(" ");
}

/** The gate's note on a launch whose `model` input names a limit past scopedAvoidPct. */
export const avoidedModelNote = (s: ScopedAssessment): string =>
  `This launch asked for ${s.model}, whose weekly limit is ${pct(s.usedPct)} used; ` +
  "choose another model for further subagents unless the user asked for this one.";
