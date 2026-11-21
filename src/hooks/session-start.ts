// SessionStart: one briefing line when there is pressure, or when the plan's baseline is below
// normalCap (so Pro hears its normal of 2 once per conversation).
//
//   startup         -> speak on pressure or a reduced baseline
//   resume          -> the same, unless this conversation's trace already holds the current
//                      cap and baseline (the resumed transcript still carries that line)
//   clear, compact  -> the earlier line is gone from context: forget it, then as startup
//   fork            -> always state the current cap whenever there is a reading: the fork
//                      inherits the transcript, and its trace may not know which cap it holds
//   no reading      -> silent

import { currentState } from "../assessment.ts";
import { log } from "../log.ts";
import { hasReducedBaseline, hasWindows } from "../policy.ts";
import { conversationKey, readTrace, updateTrace } from "../trace.ts";
import { usageLine } from "../wording.ts";
import { runHook } from "./common.ts";
import { recordStated, verdictSummary } from "./verdict.ts";

const FORGETS_CONTEXT: ReadonlySet<unknown> = new Set(["clear", "compact"]);

runHook("SessionStart", async (input) => {
  const key = conversationKey(input);
  const source = String(input.source);
  const forget = FORGETS_CONTEXT.has(input.source);
  if (forget) {
    updateTrace(key, { cap: undefined, baseline: undefined, fired: false, verdict: `forgot stated cap (${source})` });
  }
  const prev = forget ? {} : readTrace(key);

  const { config, assessment: a } = await currentState();
  const summary = verdictSummary(a);
  const worthSaying = a.pressure || hasReducedBaseline(a);
  const alreadyHeld = source === "resume" && prev.cap === a.cap && prev.baseline === a.baseline;
  const speak = hasWindows(a) && (source === "fork" || (worthSaying && !alreadyHeld));

  if (!speak) {
    const why = !hasWindows(a) ? "no reading" : alreadyHeld ? "already stated" : "nothing to say";
    log("hook", () => `SessionStart ${key} (${source}): silent, ${why} -- ${summary}`);
    if (!forget) updateTrace(key, { verdict: `session start (${source}) silent, ${why} -- ${summary}` });
    return null;
  }

  log("hook", () => `SessionStart ${key} (${source}): briefing -- ${summary}`);
  return {
    output: { additionalContext: usageLine(a, config, { prevCap: prev.cap }) },
    record: () => recordStated(key, a, { verdict: `session start (${source}) briefing -- ${summary}` }),
  };
});
