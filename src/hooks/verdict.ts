import { type Assessment, hasReducedBaseline, isBelowBaseline } from "../policy.ts";
import { type TracePatch, updateTrace } from "../trace.ts";
import { HOOK_STARTED_MS } from "./common.ts";

/** Short trace/log summary: "cap 1/3 base 2 (five_hour), status fresh". */
export const verdictSummary = (a: Assessment): string =>
  `cap ${a.cap}/${a.normalCap}${hasReducedBaseline(a) ? ` base ${a.baseline}` : ""}` +
  `${isBelowBaseline(a) || a.override ? ` (${a.override ? "override" : a.binding ?? "-"})` : ""}, ` +
  `status ${a.status}` +
  `${a.paceWarnings.length ? `, pace ${a.paceWarnings.join("+")}` : ""}` +
  `${a.scoped.length ? `, scoped ${a.scoped.map((s) => `${s.model}:${s.level}`).join("+")}` : ""}`;

/**
 * Records that an emitted line stated `a` to this conversation, so later lines know what it was
 * told. Parallel launches run their gates side by side, and their lines can land in context in
 * either order; when another hook recorded a lower cap after this one started, that line may be
 * the newest in context, so the lower cap stays recorded and the next line still lifts it.
 */
export function recordStated(key: string, a: Assessment, extra: TracePatch, startedMs = HOOK_STARTED_MS): void {
  updateTrace(key, (prev) => {
    const concurrentLower =
      prev.statedAt !== undefined && prev.statedAt >= startedMs && prev.cap !== undefined && prev.cap < a.cap;
    return {
      ...extra,
      cap: concurrentLower ? prev.cap : a.cap,
      baseline: a.baseline,
      fired: a.pressure || (concurrentLower && prev.fired === true),
      statedAt: Date.now(),
    };
  });
}
