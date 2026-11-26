import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, DEFAULTS } from "../src/config.ts";
import { assess, avoidedModel } from "../src/policy.ts";
import type { PlanId, WindowKind } from "../src/types.ts";
import { avoidedModelNote, capText, usageLine } from "../src/wording.ts";
import { configWith, makeReading, NO_SNAPSHOT, type ReadingSpec } from "./usage-fixtures.ts";

const NOW = 1_800_000_000;
const NORMAL = DEFAULTS.normalCap;

const savedDataDir = process.env.SMART_USAGE_DATA_DIR;
let dataDir: string;
beforeAll(() => {
  // policy.ts logs through log.ts; keep any debug output away from the real data dir.
  dataDir = mkdtempSync(join(tmpdir(), "smart-usage-policy-"));
  process.env.SMART_USAGE_DATA_DIR = dataDir;
});
afterAll(() => {
  if (savedDataDir === undefined) delete process.env.SMART_USAGE_DATA_DIR;
  else process.env.SMART_USAGE_DATA_DIR = savedDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const run = (spec: Omit<ReadingSpec, "now">, config: Config = DEFAULTS, override = null as Parameters<typeof assess>[3]) =>
  assess(makeReading({ now: NOW, ...spec }), config, NOW, override);

// Early in the window, so pace never counts and only the level tiers decide.
const levelCap = (plan: PlanId, kind: WindowKind, usedPct: number, config: Config = DEFAULTS): number =>
  run({ plan, windows: { [kind]: { usedPct, elapsed: 0.05 } } }, config).cap;

describe("level tiers", () => {
  // % used at which cap 2 / 1 / 0 start (docs/design.md section 3). null: cap 2 even at 0%.
  const CUTOFFS: [PlanId, WindowKind, [number | null, number, number]][] = [
    ["max5", "five_hour", [70, 85, 95]],
    ["max20", "five_hour", [92.5, 96.25, 98.75]],
    ["ultra", "five_hour", [92.5, 96.25, 98.75]],
    ["pro", "five_hour", [null, 25, 75]],
    ["max5", "seven_day", [85, 92, 97]],
    ["max20", "seven_day", [92.5, 96, 98.5]],
    ["ultra", "seven_day", [92.5, 96, 98.5]],
    ["pro", "seven_day", [25, 60, 85]],
  ];

  for (const [plan, kind, [c2, c1, c0]] of CUTOFFS) {
    test(`${plan} ${kind}: cap 2 / 1 / 0 from ${c2 ?? "0"} / ${c1} / ${c0}`, () => {
      if (c2 === null) {
        expect(levelCap(plan, kind, 0)).toBe(2);
      } else {
        expect(levelCap(plan, kind, c2 - 0.01)).toBe(NORMAL);
        expect(levelCap(plan, kind, c2)).toBe(2);
      }
      expect(levelCap(plan, kind, c1 - 0.01)).toBe(2);
      expect(levelCap(plan, kind, c1)).toBe(1);
      expect(levelCap(plan, kind, c0 - 0.01)).toBe(1);
      expect(levelCap(plan, kind, c0)).toBe(0);
      expect(levelCap(plan, kind, 100)).toBe(0);
    });
  }

  test("every configured plan's boundaries follow from its multiplier and the tier rows", () => {
    for (const [plan, perWindow] of Object.entries(DEFAULTS.multipliers) as [PlanId, Partial<Record<WindowKind, number>>][]) {
      for (const [kind, mult] of Object.entries(perWindow) as [WindowKind, number][]) {
        const rows = DEFAULTS.tiers[kind];
        rows.forEach((row, i) => {
          const cutoff = 100 - row.atMost / mult;
          if (cutoff <= 0.01) return;
          expect(levelCap(plan, kind, cutoff)).toBe(row.cap);
          expect(levelCap(plan, kind, cutoff - 0.01)).toBe(rows[i + 1]?.cap ?? NORMAL);
        });
      }
    }
  });

  test("exact boundaries hold when a float multiplier overshoots them", () => {
    const mult = 1.1;
    const cfg = configWith((c) => {
      c.multipliers.pro = { five_hour: mult, seven_day: mult };
    });
    const cutoff = 100 - 3 / mult;
    // A strict compare would put this headroom past atMost 3.
    expect((100 - cutoff) * mult).toBeGreaterThan(3);
    expect(levelCap("pro", "seven_day", cutoff, cfg)).toBe(0);
    expect(levelCap("pro", "seven_day", cutoff - 0.01, cfg)).toBe(1);
    expect(levelCap("pro", "five_hour", 25)).toBe(1);
  });

  test("Ultra without a five_hour window is judged on the weekly window alone", () => {
    const a = run({ plan: "ultra", windows: { seven_day: { usedPct: 50, elapsed: 0.05 } } });
    expect(a.windows.map((w) => w.kind)).toEqual(["seven_day"]);
    expect(a.cap).toBe(NORMAL);
    expect(a.pressure).toBe(false);
  });

  test("an unknown plan is treated as cautiously as Pro", () => {
    expect(levelCap("unknown", "five_hour", 25)).toBe(1);
  });
});

describe("pace tiers", () => {
  // max20 keeps the level tiers out of the way below 92%.
  const pace = (kind: WindowKind, usedPct: number, elapsed: number, config: Config = DEFAULTS) =>
    run({ plan: "max20", windows: { [kind]: { usedPct, elapsed } } }, config).windows[0]!;

  // Pace caps are opt-in through config.json rows.
  const withRows = configWith((c) => {
    c.pace.rows = {
      five_hour: [
        { projected: 200, cap: 1 },
        { projected: 130, cap: 2 },
      ],
      seven_day: [
        { projected: 150, cap: 1 },
        { projected: 110, cap: 2 },
      ],
    };
  });

  test("by default pace sets no cap but still warns and steers", () => {
    const a = run({ plan: "max20", windows: { five_hour: { usedPct: 45, elapsed: 0.2 } } });
    expect(a.windows[0]).toMatchObject({ projected: 225, paceCap: null, cap: NORMAL });
    expect(a.cap).toBe(NORMAL);
    expect(a.paceWarnings).toEqual(["five_hour"]);
    expect(a).toMatchObject({ steerSmaller: true, pressure: true });
    const weekly = run({ plan: "ultra", windows: { seven_day: { usedPct: 59, elapsed: 0.23 } } });
    expect(weekly).toMatchObject({ cap: NORMAL, paceWarnings: ["seven_day"], steerSmaller: true, pressure: true });
  });

  test("five_hour rows: projected >= 200 -> cap 1, >= 130 -> cap 2", () => {
    expect(pace("five_hour", 45, 0.2, withRows)).toMatchObject({ projected: 225, paceCap: 1, cap: 1, levelCap: null });
    expect(pace("five_hour", 30, 0.2, withRows)).toMatchObject({ projected: 150, paceCap: 2, cap: 2 });
    expect(pace("five_hour", 40, 0.2, withRows)).toMatchObject({ projected: 200, paceCap: 1 });
    expect(pace("five_hour", 26, 0.2, withRows)).toMatchObject({ projected: 130, paceCap: 2 });
    expect(pace("five_hour", 25, 0.2, withRows)).toMatchObject({ projected: 125, paceCap: null, cap: NORMAL });
  });

  test("seven_day rows: projected >= 150 -> cap 1, >= 110 -> cap 2", () => {
    expect(pace("seven_day", 40, 0.25, withRows)).toMatchObject({ projected: 160, paceCap: 1, cap: 1 });
    expect(pace("seven_day", 30, 0.25, withRows)).toMatchObject({ projected: 120, paceCap: 2, cap: 2 });
    expect(pace("seven_day", 27, 0.25, withRows)).toMatchObject({ projected: 108, paceCap: null });
  });

  test("pace does not count before minElapsed", () => {
    const w = pace("five_hour", 45, 0.15, withRows);
    expect(w.projected).toBeNull();
    expect(w.paceCap).toBeNull();
    expect(w.cap).toBe(NORMAL);
    expect(pace("seven_day", 30, 0.1).projected).toBeNull();
  });

  test("pace does not count below minUsedPct", () => {
    // 19% at 5% elapsed would project 380%, but 19 < minUsedPct 20.
    const cfg = configWith((c) => {
      c.pace.rows = withRows.pace.rows;
      c.pace.minElapsed.five_hour = 0;
    });
    expect(pace("five_hour", 19, 0.05, cfg).projected).toBeNull();
    expect(pace("five_hour", 20, 0.05, cfg)).toMatchObject({ projected: 400, paceCap: 1 });
  });

  test("seven_day pace counts from 25% used, inclusive", () => {
    expect(pace("seven_day", 24.9, 0.2).projected).toBeNull();
    expect(pace("seven_day", 25, 0.2).projected).toBeCloseTo(125);
    expect(run({ plan: "max20", windows: { seven_day: { usedPct: 25, elapsed: 0.2 } } }).paceWarnings).toEqual(["seven_day"]);
  });

  test("pace off in config sets no cap", () => {
    const cfg = configWith((c) => {
      c.pace.rows = withRows.pace.rows;
      c.pace.enabled = false;
    });
    expect(pace("five_hour", 45, 0.2, cfg)).toMatchObject({ projected: null, paceCap: null, cap: NORMAL });
  });

  test("with rows, window cap is the lower of level and pace", () => {
    // max5 at 72%: level cap 2; 72 / 0.3 = 240% projected: pace cap 1.
    const w = run({ plan: "max5", windows: { five_hour: { usedPct: 72, elapsed: 0.3 } } }, withRows).windows[0]!;
    expect(w).toMatchObject({ levelCap: 2, paceCap: 1, cap: 1 });
  });

  test("a projection past warnProjectedPct without a pace cap still warns and steers", () => {
    const a = run({ plan: "max20", windows: { five_hour: { usedPct: 21, elapsed: 0.2 } } });
    expect(a.windows[0]!.projected).toBeCloseTo(105);
    expect(a.cap).toBe(NORMAL);
    expect(a.paceWarnings).toEqual(["five_hour"]);
    expect(a.steerSmaller).toBe(true);
    expect(a.pressure).toBe(true);
  });
});

describe("overall cap", () => {
  test("is the minimum over windows, and names the binding window", () => {
    const a = run({
      plan: "max5",
      windows: { five_hour: { usedPct: 72, elapsed: 0.05 }, seven_day: { usedPct: 93, elapsed: 0.05 } },
    });
    expect(a.windows.map((w) => w.cap)).toEqual([2, 1]);
    expect(a.cap).toBe(1);
    expect(a.binding).toBe("seven_day");
  });

  test("no snapshot gives the normal cap, silently", () => {
    const a = assess(NO_SNAPSHOT, DEFAULTS, NOW);
    expect(a).toMatchObject({ cap: NORMAL, windows: [], pressure: false, steerSmaller: false, binding: null });
  });

  test("normalCap clamps the tier caps", () => {
    const one = configWith((c) => {
      c.normalCap = 1;
    });
    const a = run({ plan: "max5", windows: { five_hour: { usedPct: 72, elapsed: 0.05 } } }, one);
    expect(a.cap).toBe(1);
    expect(a.pressure).toBe(false);
  });

  test("a custom normalCap of 5 is the cap when nothing binds, and tiers still apply", () => {
    const five = configWith((c) => {
      c.normalCap = 5;
    });
    const calm = run({ plan: "max5", windows: { five_hour: { usedPct: 50, elapsed: 0.05 } } }, five);
    expect(calm.cap).toBe(5);
    expect(calm.pressure).toBe(false);
    expect(usageLine(calm, five)).toContain("up to 5 in flight");
    const busy = run({ plan: "max5", windows: { five_hour: { usedPct: 72, elapsed: 0.05 } } }, five);
    expect(busy.cap).toBe(2);
    expect(busy.pressure).toBe(true);
    expect(usageLine(busy, five)).toContain("at most 2 subagents in flight");
  });
});

describe("reading age", () => {
  const stale = DEFAULTS.staleSeconds + 60;

  test("a window whose resetsAt has passed rolled over: 0% used, no cap", () => {
    const a = run({ plan: "max5", windows: { five_hour: { usedPct: 99, resetsAt: NOW - 1 } } });
    expect(a.windows[0]).toMatchObject({ basis: "rolled_over", usedPct: 0, cap: NORMAL });
    expect(a.cap).toBe(NORMAL);
    expect(a.pressure).toBe(false);
  });

  test("a rolled-over or unusable window counts as empty, never looser: Pro stays at its baseline", () => {
    const weekly = { usedPct: 10, elapsed: 0.05 };
    const rolled = run({ plan: "pro", windows: { five_hour: { usedPct: 40, resetsAt: NOW - 1 }, seven_day: weekly } });
    expect(rolled.windows[0]).toMatchObject({ basis: "rolled_over", levelCap: 2, cap: 2 });
    expect(rolled).toMatchObject({ cap: 2, baseline: 2, pressure: false });
    const stale = run({
      plan: "pro",
      ageSeconds: DEFAULTS.staleSeconds + 60,
      windows: { five_hour: { usedPct: 99, resetsAt: null }, seven_day: weekly },
    });
    expect(stale.windows[0]).toMatchObject({ basis: "no_reading", cap: 2 });
    expect(stale).toMatchObject({ cap: 2, baseline: 2 });
  });

  test("a stale reading with a future resetsAt is a floor and keeps its cap", () => {
    const a = run({ plan: "max5", ageSeconds: stale, windows: { five_hour: { usedPct: 96, elapsed: 0.05 } } });
    expect(a.windows[0]).toMatchObject({ basis: "floor", usedPct: 96, cap: 0 });
    expect(a.cap).toBe(0);
    expect(usageLine(a, DEFAULTS)).toContain("at least 96% used as of 16 min ago");
  });

  test("a stale reading without resetsAt gives no cap", () => {
    const a = run({ plan: "max5", ageSeconds: stale, windows: { five_hour: { usedPct: 99, resetsAt: null } } });
    expect(a.windows[0]).toMatchObject({ basis: "no_reading", usedPct: null, cap: NORMAL });
    expect(a.cap).toBe(NORMAL);
  });

  test("a fresh reading without resetsAt still counts", () => {
    const a = run({ plan: "max5", windows: { five_hour: { usedPct: 99, resetsAt: null } } });
    expect(a.windows[0]).toMatchObject({ basis: "fresh", cap: 0, elapsed: null, projected: null });
  });
});

describe("override", () => {
  const hot = { plan: "max5" as const, windows: { five_hour: { usedPct: 97, elapsed: 0.05 } } };
  const calm = { plan: "max5" as const, windows: { five_hour: { usedPct: 10, elapsed: 0.05 } } };

  test("raises the cap while live", () => {
    const a = run(hot, DEFAULTS, { cap: 3, until: NOW + 600, reason: "upgraded" });
    expect(a.computedCap).toBe(0);
    expect(a.cap).toBe(3);
    expect(a.override).toEqual({ cap: 3, until: NOW + 600, reason: "upgraded" });
    expect(capText(a, DEFAULTS)).toContain("override");
  });

  test("lowers the cap while live", () => {
    const a = run(calm, DEFAULTS, { cap: 1, until: NOW + 600 });
    expect(a.computedCap).toBe(NORMAL);
    expect(a.cap).toBe(1);
    expect(a.pressure).toBe(true);
  });

  test("is ignored once expired", () => {
    const a = run(hot, DEFAULTS, { cap: 3, until: NOW });
    expect(a.override).toBeNull();
    expect(a.cap).toBe(0);
  });

  test("is clamped to 0..normalCap", () => {
    expect(run(hot, DEFAULTS, { cap: 9, until: NOW + 600 }).cap).toBe(NORMAL);
    expect(run(calm, DEFAULTS, { cap: -2, until: NOW + 600 }).cap).toBe(0);
  });
});

describe("model steering", () => {
  const withScoped = (usedPct: number, resetsAt?: number | null) =>
    run({
      plan: "max5",
      windows: { seven_day: { usedPct: 20, elapsed: 0.05 } },
      scoped: [{ model: "Fable", usedPct, ...(resetsAt !== undefined ? { resetsAt } : {}) }],
    });

  test("below scopedWarnPct a per-model limit is not mentioned", () => {
    const a = withScoped(74);
    expect(a.scoped).toEqual([]);
    expect(a.pressure).toBe(false);
  });

  test("at scopedWarnPct it is mentioned", () => {
    const a = withScoped(75);
    expect(a.scoped).toMatchObject([{ model: "Fable", level: "warn" }]);
    expect(a.pressure).toBe(true);
    const line = usageLine(a, DEFAULTS);
    expect(line).toContain("Fable weekly limit 75% used");
    expect(line).not.toContain("do not choose");
  });

  test("at scopedAvoidPct the line advises against the model, and the gate matches its alias", () => {
    const a = withScoped(90);
    expect(a.scoped).toMatchObject([{ model: "Fable", level: "avoid" }]);
    expect(usageLine(a, DEFAULTS)).toContain("do not choose Fable for new subagents");
    expect(avoidedModel(a, "fable")?.model).toBe("Fable");
    expect(avoidedModel(a, "claude-fable-5")?.model).toBe("Fable");
    expect(avoidedModel(a, "sonnet")).toBeNull();
    expect(avoidedModel(a, undefined)).toBeNull();
    expect(avoidedModel(withScoped(80), "fable")).toBeNull();
  });

  test("a per-model limit past its reset is ignored", () => {
    expect(withScoped(95, NOW - 1).scoped).toEqual([]);
  });

  test("steering off drops all model advice", () => {
    const off = configWith((c) => {
      c.modelSteering.enabled = false;
    });
    const a = run(
      { plan: "max5", windows: { five_hour: { usedPct: 90, elapsed: 0.05 } }, scoped: [{ model: "Fable", usedPct: 99 }] },
      off,
    );
    expect(a.scoped).toEqual([]);
    expect(a.steerSmaller).toBe(false);
    expect(usageLine(a, off)).not.toContain("model");
  });
});

describe("wording", () => {
  test("every line restates every part in force", () => {
    const a = run({
      plan: "max5",
      windows: { five_hour: { usedPct: 86, elapsed: 0.05 }, seven_day: { usedPct: 40, elapsed: 0.25 } },
      scoped: [{ model: "Fable", usedPct: 93 }],
    });
    const line = usageLine(a, DEFAULTS, { extra: avoidedModelNote(a.scoped[0]!) });
    for (const part of [
      "Max 5x plan",
      "5-hour window 86% used, resets in 4h 45m",
      "weekly window 40% used, resets in 5d 6h, on pace for 160% by reset",
      "Subagent cap 1 (from the 5-hour window): at most 1 subagent in flight",
      "limits new launches only",
      "needs the user's approval",
      "weekly window runs out before reset",
      "Prefer smaller models",
      "Fable weekly limit 93% used",
      "This launch asked for Fable",
      "supersedes every earlier smart-usage line",
    ]) {
      expect(line).toContain(part);
    }
  });

  test("cap 0 says no new subagents and to continue inline", () => {
    const a = run({ plan: "max5", windows: { five_hour: { usedPct: 96, elapsed: 0.05 } } });
    expect(capText(a, DEFAULTS)).toContain("no new subagents or workflows; finish and checkpoint current work");
  });

  test("lifting a lower stated cap says so; lifting from 0 appends liftedFromZeroNote", () => {
    const cfg = configWith((c) => {
      c.liftedFromZeroNote = "Run the review owed from the cap-0 stretch.";
      c.capNotes = { "1": "Reviews run one after another." };
    });
    const calm = run({ plan: "max5", windows: { five_hour: { usedPct: 10, elapsed: 0.05 } } }, cfg);
    expect(capText(calm, cfg)).toBe("Subagent cap: normal, up to 3 in flight.");
    expect(capText(calm, cfg, 1)).toContain("lifted");
    expect(capText(calm, cfg, 1)).not.toContain("owed");
    expect(capText(calm, cfg, 0)).toContain("Run the review owed from the cap-0 stretch.");
    const one = run({ plan: "max5", windows: { five_hour: { usedPct: 86, elapsed: 0.05 } } }, cfg);
    expect(capText(one, cfg, 0)).toContain("Run the review owed");
    expect(capText(one, cfg)).toEndWith("Reviews run one after another.");
    expect(usageLine(calm, cfg, { prevCap: 1 })).toContain("Nothing is constrained.");
  });

  test("percentages round down, so a figure never shows a tier not reached", () => {
    const a = run({ plan: "max5", windows: { five_hour: { usedPct: 84.99, elapsed: 0.05 } } });
    expect(usageLine(a, DEFAULTS)).toContain("84% used");
  });
});

describe("plan baseline", () => {
  const both = (plan: PlanId, usedPct = 0) =>
    run({ plan, windows: { five_hour: { usedPct, elapsed: 0.05 }, seven_day: { usedPct: 5, elapsed: 0.05 } } });

  test("is the level cap each reported window gives at 0% used, at most normalCap", () => {
    expect(both("pro").baseline).toBe(2);
    expect(run({ plan: "pro", windows: { seven_day: { usedPct: 5, elapsed: 0.05 } } }).baseline).toBe(NORMAL);
    expect(both("max5").baseline).toBe(NORMAL);
    expect(both("max20").baseline).toBe(NORMAL);
    expect(run({ plan: "ultra", windows: { seven_day: { usedPct: 0, elapsed: 0.05 } } }).baseline).toBe(3);
    expect(both("ultra").baseline).toBe(3);
    expect(assess(NO_SNAPSHOT, DEFAULTS, NOW).baseline).toBe(NORMAL);
    const one = configWith((c) => {
      c.normalCap = 1;
    });
    expect(run({ plan: "pro", windows: { five_hour: { usedPct: 0, elapsed: 0.05 } } }, one).baseline).toBe(1);
  });

  test("a cap at the baseline is the plan's normal: no pressure, no model steering", () => {
    const a = both("pro");
    expect(a).toMatchObject({ cap: 2, baseline: 2, pressure: false, steerSmaller: false });
    const line = usageLine(a, DEFAULTS);
    expect(line).toContain("Subagent cap 2 (normal for the Pro plan): at most 2 subagents in flight");
    expect(line).toContain("Nothing is constrained beyond the plan's normal.");
    expect(line).not.toContain("Prefer smaller models");
  });

  test("a cap below the baseline is pressure and still names the plan's normal", () => {
    const a = both("pro", 30);
    expect(a).toMatchObject({ cap: 1, baseline: 2, pressure: true, steerSmaller: true, binding: "five_hour" });
    const line = usageLine(a, DEFAULTS);
    expect(line).toContain("Subagent cap 1 (from the 5-hour window)");
    expect(line).toContain("Up to 2 in flight is normal for the Pro plan.");
  });

  test("back at the baseline after a lower stated cap reads as back to the plan's normal", () => {
    const text = capText(both("pro"), DEFAULTS, 1);
    expect(text).toContain("Subagent cap back to 2 (normal for the Pro plan)");
    expect(text).toContain("no longer applies");
    expect(capText(both("pro"), DEFAULTS, 2)).not.toContain("back to");
  });

  test("an override above the baseline still states the plan's normal", () => {
    const a = run(
      { plan: "pro", windows: { five_hour: { usedPct: 0, elapsed: 0.05 } } },
      DEFAULTS,
      { cap: 3, until: NOW + 600 },
    );
    expect(a).toMatchObject({ cap: 3, baseline: 2, pressure: false });
    const text = capText(a, DEFAULTS);
    expect(text).toContain("set by the user's override");
    expect(text).toContain("Up to 2 in flight is normal for the Pro plan.");
  });
});
