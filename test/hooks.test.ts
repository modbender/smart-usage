// End to end: build the bundles into a temp dir, then run them under node with JSON on stdin,
// a temp data dir and a reading fixture built relative to Date.now().

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeReading, NO_SNAPSHOT, type ReadingSpec } from "./usage-fixtures.ts";

// Each case spawns node several times (~0.3-0.5 s each); the 5 s default is too tight under load.
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
let bundles: string;
let dataDir: string;
beforeAll(() => {
  bundles = mkdtempSync(join(tmpdir(), "smart-usage-dist-"));
  const build = spawnSync("bun", ["run", join(ROOT, "scripts", "build.ts"), bundles], { encoding: "utf8" });
  if (build.status !== 0) throw new Error(`build failed: ${build.stderr}${build.stdout}`);
});

afterAll(() => {
  rmSync(bundles, { recursive: true, force: true });
});

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "smart-usage-hooks-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const now = (): number => Date.now() / 1000;

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("CLAUDE_PLUGIN_OPTION_") || k.startsWith("SMART_USAGE_")) continue;
    env[k] = v;
  }
  return env;
}

/** Writes the reading fixture this test's hooks will see. */
function setReading(spec: Omit<ReadingSpec, "now"> | "none"): void {
  const reading = spec === "none" ? NO_SNAPSHOT : makeReading({ now: now(), ...spec });
  writeFileSync(join(dataDir, "reading.json"), JSON.stringify(reading));
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runScript(script: string, stdin: string, args: string[] = [], extraEnv: Record<string, string> = {}): Run {
  const r = spawnSync("node", [join(bundles, script), ...args], {
    input: stdin,
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...cleanEnv(),
      SMART_USAGE_DATA_DIR: dataDir,
      CLAUDE_CONFIG_DIR: dataDir,
      SMART_USAGE_READING_FILE: join(dataDir, "reading.json"),
      ...extraEnv,
    },
  });
  // Every run, whatever the test: "allow" would skip the user's permission prompt.
  expect(r.stdout).not.toMatch(/"allow"/);
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

type HookName = "session-start" | "prompt-submit" | "agent-gate";

function hook(name: HookName, input: Record<string, unknown> | string): Run {
  return runScript(`${name}.mjs`, typeof input === "string" ? input : JSON.stringify(input));
}

interface Parsed {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
  suppressOutput: boolean;
}

function parsed(r: Run): Parsed {
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout) as Parsed;
  expect(out.suppressOutput).toBe(true);
  return out;
}

const context = (r: Run): string => parsed(r).hookSpecificOutput.additionalContext ?? "";

function silent(r: Run): void {
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
}

const SESSION = { session_id: "s1" };
const gate = (extra: Record<string, unknown> = {}) =>
  hook("agent-gate", { ...SESSION, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: {}, ...extra });
const prompt = (extra: Record<string, unknown> = {}) =>
  hook("prompt-submit", { ...SESSION, hook_event_name: "UserPromptSubmit", prompt: "hi", ...extra });
const sessionStart = (source: string) => hook("session-start", { ...SESSION, hook_event_name: "SessionStart", source });

// max5 five_hour: cap 2 from 70%, 1 from 85%, 0 from 95%. Early in the window: no pace.
const at = (usedPct: number, weekly = 20) => ({
  plan: "max5" as const,
  windows: { five_hour: { usedPct, elapsed: 0.05 }, seven_day: { usedPct: weekly, elapsed: 0.05 } },
});

describe("agent gate", () => {
  test("cap 0 denies with the line as the reason", () => {
    setReading(at(96));
    const out = parsed(gate()).hookSpecificOutput;
    expect(out.hookEventName).toBe("PreToolUse");
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("no new subagents or workflows");
    expect(out.permissionDecisionReason).toContain("weekly window 20% used");
    expect(out.permissionDecisionReason).toContain("supersedes");
    expect(out.additionalContext).toBeUndefined();
  });

  test("cap 1 and cap 2 add context without a decision", () => {
    setReading(at(86));
    const one = parsed(gate()).hookSpecificOutput;
    expect(one.permissionDecision).toBeUndefined();
    expect(one.additionalContext).toContain("Subagent cap 1");
    setReading(at(72));
    expect(context(gate())).toContain("Subagent cap 2");
  });

  test("silent under the cap", () => {
    setReading(at(50));
    silent(gate());
  });

  test("back to normal once after a lower stated cap, then silent", () => {
    setReading(at(86));
    expect(context(gate())).toContain("Subagent cap 1");
    setReading(at(40));
    const lifted = context(gate());
    expect(lifted).toContain("Subagent cap lifted");
    expect(lifted).toContain("up to 3 in flight");
    expect(lifted).toContain("weekly window 20% used");
    silent(gate());
  });

  test("a launch naming a model past scopedAvoidPct gets a note, others stay silent", () => {
    setReading({ ...at(40), scoped: [{ model: "Fable", usedPct: 95 }] });
    const note = context(gate({ tool_input: { model: "fable", prompt: "x" } }));
    expect(note).toContain("This launch asked for Fable");
    expect(note).toContain("do not choose Fable for new subagents");
    silent(gate({ tool_input: { model: "sonnet" } }));
  });

  test("a subagent's cap is its own conversation", () => {
    setReading(at(86));
    expect(context(gate({ agent_id: "a1" }))).toContain("Subagent cap 1");
    setReading(at(40));
    silent(gate());
    expect(context(gate({ agent_id: "a1" }))).toContain("lifted");
  });

  test("no credentials: silent", () => {
    setReading("none");
    silent(gate());
  });
});

describe("prompt hook", () => {
  test("emits while capped, every prompt", () => {
    setReading(at(86));
    const first = context(prompt());
    expect(first).toContain("Subagent cap 1");
    expect(first).toContain("Max 5x plan");
    expect(context(prompt())).toContain("Subagent cap 1");
  });

  test("silent when nothing is at stake and nothing was said", () => {
    setReading(at(30));
    silent(prompt());
  });

  test("lifts a stated cap once, then goes silent", () => {
    setReading(at(86));
    context(prompt());
    setReading(at(30));
    const lift = context(prompt());
    expect(lift).toContain("Subagent cap lifted");
    expect(lift).toContain("Nothing is constrained.");
    silent(prompt());
  });

  test("retracts a pace warning once, then goes silent", () => {
    // max20 five_hour 21% at 20% elapsed: projected 105%, a warning without a cap.
    setReading({ plan: "max20", windows: { five_hour: { usedPct: 21, elapsed: 0.2 } } });
    const warned = context(prompt());
    expect(warned).toContain("on pace for 105% by reset");
    expect(warned).toContain("Subagent cap: normal");
    expect(warned).not.toContain("Nothing is constrained");
    setReading({ plan: "max20", windows: { five_hour: { usedPct: 10, elapsed: 0.5 } } });
    const retracted = context(prompt());
    expect(retracted).toContain("Nothing is constrained.");
    expect(retracted).toContain("supersedes");
    silent(prompt());
  });

  test("a cap the gate stated is lifted by the next prompt", () => {
    setReading(at(86));
    context(gate());
    setReading(at(30));
    expect(context(prompt())).toContain("Subagent cap lifted");
    silent(gate());
  });

  test("a lift the gate already delivered is not repeated by the prompt hook", () => {
    setReading(at(86));
    context(prompt());
    setReading(at(30));
    expect(context(gate())).toContain("lifted");
    silent(prompt());
  });
});

describe("session start", () => {
  test("briefs when there is pressure, silent otherwise", () => {
    setReading(at(86));
    const out = parsed(sessionStart("startup")).hookSpecificOutput;
    expect(out.hookEventName).toBe("SessionStart");
    expect(out.additionalContext).toContain("Subagent cap 1");
    setReading(at(30));
    silent(sessionStart("startup"));
  });

  test("clear and compact forget the stated cap", () => {
    for (const source of ["clear", "compact"]) {
      setReading(at(86));
      context(prompt());
      setReading(at(30));
      silent(sessionStart(source));
      // The capped line went with the old context, so there is nothing to lift.
      silent(prompt());
    }
  });

  test("resume keeps the stated cap, so the next prompt lifts it", () => {
    setReading(at(86));
    context(prompt());
    setReading(at(30));
    silent(sessionStart("resume"));
    expect(context(prompt())).toContain("Subagent cap lifted");
  });
});

describe("plan baseline (Pro: 2 in flight at 0% used)", () => {
  const pro = (usedPct: number) => ({
    plan: "pro" as const,
    windows: { five_hour: { usedPct, elapsed: 0.05 }, seven_day: { usedPct: 5, elapsed: 0.05 } },
  });

  test("stated once at session start, then silent until the cap moves; back to 2 once", () => {
    setReading(pro(0));
    const brief = context(sessionStart("startup"));
    expect(brief).toContain("Subagent cap 2 (normal for the Pro plan)");
    expect(brief).toContain("Pro plan");
    silent(prompt());
    silent(prompt());
    silent(gate());

    setReading(pro(30));
    expect(context(prompt())).toContain("Subagent cap 1 (from the 5-hour window)");
    const capped = context(gate());
    expect(capped).toContain("Subagent cap 1");
    expect(capped).toContain("Up to 2 in flight is normal for the Pro plan.");

    setReading(pro(0));
    expect(context(prompt())).toContain("Subagent cap back to 2 (normal for the Pro plan)");
    silent(prompt());
    silent(gate());
  });

  test("the gate delivers the back-to-2 line once when no prompt comes", () => {
    setReading(pro(30));
    expect(context(gate())).toContain("Subagent cap 1");
    setReading(pro(0));
    expect(context(gate())).toContain("Subagent cap back to 2");
    silent(gate());
    silent(prompt());
  });

  test("without a session-start line the first prompt states the baseline once", () => {
    setReading(pro(0));
    expect(context(prompt())).toContain("normal for the Pro plan");
    silent(prompt());
  });

  test("Max 5x at 0% has the full normal cap: session start is silent", () => {
    setReading(at(0, 0));
    silent(sessionStart("startup"));
    silent(prompt());
  });
});

const traceEntry = (key = "s1"): Record<string, unknown> => {
  const all = JSON.parse(readFileSync(join(dataDir, "trace.json"), "utf8")) as Record<string, Record<string, unknown>>;
  return all[key] ?? {};
};

describe("missing or reset readings", () => {
  test("no reading after a stated cap 0: every hook is silent and the stated cap stands", () => {
    setReading(at(96));
    expect(parsed(gate()).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(traceEntry().cap).toBe(0);
    setReading("none");
    silent(prompt());
    silent(gate());
    silent(sessionStart("startup"));
    expect(traceEntry().cap).toBe(0);
  });

  test("Pro with its 5-hour window rolled over stays at its baseline: no extra lines", () => {
    const weekly = { usedPct: 10, elapsed: 0.05 };
    setReading({ plan: "pro", windows: { five_hour: { usedPct: 0, elapsed: 0.05 }, seven_day: weekly } });
    expect(context(sessionStart("startup"))).toContain("normal for the Pro plan");
    setReading({ plan: "pro", windows: { five_hour: { usedPct: 40, resetsAt: Math.floor(now()) - 60 }, seven_day: weekly } });
    silent(prompt());
    silent(gate());
    expect(traceEntry().cap).toBe(2);
  });
});

describe("session start by source", () => {
  const pro = (usedPct: number) => ({
    plan: "pro" as const,
    windows: { five_hour: { usedPct, elapsed: 0.05 }, seven_day: { usedPct: 5, elapsed: 0.05 } },
  });

  test("resume is silent when the trace already holds the current cap and baseline", () => {
    setReading(pro(0));
    expect(context(sessionStart("startup"))).toContain("normal for the Pro plan");
    silent(sessionStart("resume"));
    setReading(pro(30));
    expect(context(sessionStart("resume"))).toContain("Subagent cap 1");
    silent(sessionStart("resume"));
  });

  test("resume of a conversation never told speaks like startup", () => {
    setReading(pro(0));
    expect(context(sessionStart("resume"))).toContain("normal for the Pro plan");
  });

  test("fork always states the current cap when there is a reading", () => {
    setReading(at(30));
    const line = context(sessionStart("fork"));
    expect(line).toContain("Subagent cap: normal, up to 3 in flight");
    expect(line).toContain("supersedes");
    expect(context(sessionStart("fork"))).toContain("Subagent cap: normal");
    setReading("none");
    silent(sessionStart("fork"));
  });
});

describe("gate announces any change from the stated cap", () => {
  const pro = {
    plan: "pro" as const,
    windows: { five_hour: { usedPct: 0, elapsed: 0.05 }, seven_day: { usedPct: 5, elapsed: 0.05 } },
  };
  const cli = (...args: string[]) => runScript("cli.mjs", "", args);

  test("on Pro an override 2 -> 3 gets one gate line, and its removal another", () => {
    setReading(pro);
    expect(context(sessionStart("startup"))).toContain("Subagent cap 2 (normal for the Pro plan)");
    silent(gate());
    expect(cli("override", "3", "1h", "big", "refactor").code).toBe(0);
    const raised = context(gate());
    expect(raised).toContain("Subagent cap lifted (set by the user's override");
    expect(raised).toContain("up to 3 in flight");
    expect(raised).toContain("Up to 2 in flight is normal for the Pro plan.");
    silent(gate());
    expect(cli("clear").code).toBe(0);
    expect(context(gate())).toContain("Subagent cap 2 (normal for the Pro plan)");
    silent(gate());
    silent(prompt());
  });
});

describe("fail open", () => {
  for (const name of ["session-start", "prompt-submit", "agent-gate"] as const) {
    test(`${name}: malformed stdin exits 0 with no output`, () => {
      setReading(at(96));
      silent(hook(name, "{not json"));
      silent(hook(name, "[1, 2]"));
    });

    test(`${name}: an unreadable reading exits 0 with no output`, () => {
      writeFileSync(join(dataDir, "reading.json"), "{torn");
      silent(hook(name, { ...SESSION, source: "startup", tool_name: "Agent" }));
    });
  }

  test("empty stdin exits 0 with no output", () => {
    setReading(at(96));
    silent(hook("agent-gate", ""));
  });
});

describe("cli", () => {
  const cli = (...args: string[]) => runScript("cli.mjs", "", args);
  const statusJson = () => {
    const r = cli("status", "--json");
    expect(r.code).toBe(0);
    return JSON.parse(r.stdout) as Record<string, any>;
  };

  test("status --json reports plan, windows, cap and the binding window", () => {
    setReading(at(86, 40));
    const s = statusJson();
    expect(s.plan).toMatchObject({ id: "max5", label: "Max 5x" });
    expect(s.reading.status).toBe("fresh");
    expect(s.cap).toBe(1);
    expect(s.normalCap).toBe(3);
    expect(s.binding).toBe("five_hour");
    expect(s.windows).toHaveLength(2);
    expect(s.windows[0]).toMatchObject({ kind: "five_hour", usedPct: 86, levelCap: 1, cap: 1 });
    expect(s.override).toBeNull();
    expect(s.line).toContain("Subagent cap 1");
    expect(s.dataDir).toBe(dataDir);
  });

  test("status prints readable text", () => {
    setReading(at(86));
    const r = cli("status");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Plan: Max 5x");
    expect(r.stdout).toContain("Cap: 1 of 3");
  });

  test("override sets a cap until a duration, the hooks honour it, clear removes it", () => {
    setReading(at(30));
    const set = cli("override", "1", "2h", "testing", "the", "cap");
    expect(set.code).toBe(0);
    expect(set.stdout).toContain("Override set: cap 1");
    const s = statusJson();
    expect(s.cap).toBe(1);
    expect(s.computedCap).toBe(3);
    expect(s.override).toMatchObject({ cap: 1, reason: "testing the cap", live: true });
    expect(s.override.until).toBeGreaterThan(now() + 7100);
    expect(s.override.until).toBeLessThan(now() + 7300);
    expect(context(gate())).toContain("set by the user's override");

    expect(cli("clear").stdout).toContain("Override cleared.");
    expect(existsSync(join(dataDir, "override.json"))).toBe(false);
    expect(statusJson().cap).toBe(3);
    expect(cli("clear").stdout).toContain("No override was set.");
  });

  test("override reset ties the override to the binding window's reset", () => {
    setReading(at(86));
    expect(cli("override", "3", "reset").code).toBe(0);
    const file = JSON.parse(readFileSync(join(dataDir, "override.json"), "utf8"));
    const s = statusJson();
    expect(file.until).toBe(s.windows[0].resetsAt);
    expect(s.cap).toBe(3);
  });

  test("override above the normal cap is clamped", () => {
    setReading(at(30));
    expect(cli("override", "9", "30m").stdout).toContain("above the normal cap");
    expect(statusJson().override.cap).toBe(3);
  });

  test("bad arguments exit 2 with usage on stderr, stdout empty", () => {
    setReading(at(30));
    for (const args of [["override"], ["override", "x", "2h"], ["override", "1", "2 weeks"], ["bogus"]]) {
      const r = cli(...args);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("Usage: smart-usage");
    }
  });
});
