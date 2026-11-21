// UserPromptSubmit: one usage line while something is at stake, or when the cap or the plan's
// baseline differs from what this conversation was last told; one retraction once nothing is
// at stake, then silence. A steady baseline already stated (Pro's 2) stays silent, and so does
// a missing reading: it says nothing about the cap, so the stated one stands.

import { currentState } from "../assessment.ts";
import { log } from "../log.ts";
import { hasWindows } from "../policy.ts";
import { conversationKey, readTrace, updateTrace } from "../trace.ts";
import { usageLine } from "../wording.ts";
import { runHook } from "./common.ts";
import { recordStated, verdictSummary } from "./verdict.ts";

runHook("UserPromptSubmit", async (input) => {
  const key = conversationKey(input);
  const { config, assessment: a } = await currentState();
  const prev = readTrace(key);
  const summary = verdictSummary(a);

  if (!hasWindows(a)) {
    log("hook", () => `UserPromptSubmit ${key}: silent, no reading -- ${summary}`);
    updateTrace(key, { verdict: `silent, no reading -- ${summary}` });
    return null;
  }

  // Never stated: worth a line only if it is below normalCap.
  const differs = (stated: number | undefined, now: number): boolean =>
    stated !== undefined ? now !== stated : now < a.normalCap;
  const changed = differs(prev.cap, a.cap) || differs(prev.baseline, a.baseline);
  // Nothing at stake now, but the last line said otherwise: it is still the newest usage line
  // in context, so it gets one retraction.
  const retract = !a.pressure && !changed && prev.fired === true;

  if (!a.pressure && !changed && !retract) {
    log("hook", () => `UserPromptSubmit ${key}: silent -- ${summary}`);
    updateTrace(key, { verdict: `silent -- ${summary}` });
    return null;
  }

  const why = retract ? "retracted" : a.pressure ? "pressure" : "cap or baseline changed";
  log("hook", () => `UserPromptSubmit ${key}: emitted (${why}, prev cap ${prev.cap ?? "-"}) -- ${summary}`);
  return {
    output: { additionalContext: usageLine(a, config, { prevCap: prev.cap }) },
    record: () => recordStated(key, a, { verdict: `emitted (${why}) -- ${summary}` }),
  };
});
