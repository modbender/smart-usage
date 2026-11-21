// PreToolUse on Agent|Workflow. Re-reads on every launch, because an autonomous run can go
// hours without a prompt to carry a fresh line.
//
//   cap 0                                        -> deny, the line as the reason
//   cap below the plan's baseline                -> the line as additionalContext
//   any other change from the cap last stated    -> one context line stating the new cap
//     (raises included: back at the baseline, or an override above it)
//   launch names a model past scopedAvoidPct     -> the line plus a note on that model
//   no reading, or otherwise                     -> no output (never "allow")

import { currentState } from "../assessment.ts";
import { asObj, nonEmptyString } from "../json.ts";
import { log } from "../log.ts";
import { avoidedModel, hasWindows, isBelowBaseline } from "../policy.ts";
import { conversationKey, readTrace, updateTrace } from "../trace.ts";
import { avoidedModelNote, usageLine } from "../wording.ts";
import { runHook } from "./common.ts";
import { recordStated, verdictSummary } from "./verdict.ts";

const launchModel = (toolInput: unknown): unknown => asObj(toolInput)?.model;

runHook("PreToolUse", async (input) => {
  const key = conversationKey(input);
  const tool = nonEmptyString(input.tool_name) ?? "?";
  const { config, assessment: a } = await currentState();
  const prevCap = readTrace(key).cap;
  const summary = verdictSummary(a);

  const usable = hasWindows(a);
  const deny = usable && a.cap === 0;
  const capped = usable && (deny || isBelowBaseline(a));
  const changed = usable && prevCap !== undefined && prevCap !== a.cap;
  const avoided = usable ? avoidedModel(a, launchModel(input.tool_input)) : null;

  if (!capped && !changed && !avoided) {
    const why = usable ? "silent" : "silent, no reading";
    log("hook", () => `PreToolUse ${key} ${tool}: ${why} -- ${summary}`);
    updateTrace(key, { gate: `${tool}: ${why} -- ${summary}` });
    return null;
  }

  const verdict = deny ? "denied" : capped ? "context" : changed ? `cap ${prevCap} -> ${a.cap}` : "model note";
  log("hook", () => `PreToolUse ${key} ${tool}: ${verdict} (prev cap ${prevCap ?? "-"}) -- ${summary}`);
  const line = usageLine(a, config, { prevCap, ...(avoided ? { extra: avoidedModelNote(avoided) } : {}) });
  return {
    output: deny
      ? { permissionDecision: "deny", permissionDecisionReason: line }
      : { additionalContext: line },
    // The line lands in this conversation either way, so the prompt hook must see it as stated.
    record: () => recordStated(key, a, { gate: `${tool}: ${verdict} -- ${summary}` }),
  };
});
