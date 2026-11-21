import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig, resetConfigCache } from "../src/config.ts";
import { recordStated } from "../src/hooks/verdict.ts";
import { assess } from "../src/policy.ts";
import { readTrace, updateTrace } from "../src/trace.ts";
import { makeReading } from "./usage-fixtures.ts";

let dir: string;
const tracePath = (): string => join(dir, "trace.json");
const readAll = (): Record<string, Record<string, unknown>> => JSON.parse(readFileSync(tracePath(), "utf8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "smart-usage-trace-"));
  process.env.SMART_USAGE_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SMART_USAGE_DATA_DIR;
});

describe("trace.json", () => {
  test("entries older than 7 days are pruned on write; newer ones stay", () => {
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    writeFileSync(
      tracePath(),
      JSON.stringify({
        old: { at: iso(8 * 86400_000), cap: 1 },
        recent: { at: iso(6 * 86400_000), cap: 2 },
        undated: { cap: 0 },
      }),
    );
    updateTrace("me", { cap: 3 }, now);
    const all = readAll();
    expect(Object.keys(all).sort()).toEqual(["me", "recent"]);
    expect(all.recent?.cap).toBe(2);
  });

  test("a persistently unparsable trace is set aside so writes resume", () => {
    writeFileSync(tracePath(), "{torn");
    updateTrace("me", { cap: 1 });
    expect(readAll()).toMatchObject({ me: { cap: 1 } });
    expect(readFileSync(`${tracePath()}.bad`, "utf8")).toBe("{torn");
    updateTrace("me", { fired: true });
    expect(readAll()).toMatchObject({ me: { cap: 1, fired: true } });
  });

  test("a field of the wrong type reads as absent, and is dropped on the next write", () => {
    writeFileSync(
      tracePath(),
      JSON.stringify({ me: { at: new Date().toISOString(), cap: "1", baseline: 2, fired: "yes", statedAt: null } }),
    );
    expect(readTrace("me")).toEqual({ at: expect.any(String), baseline: 2 });
    updateTrace("me", { verdict: "x" });
    expect(readAll().me).toEqual({ at: expect.any(String), baseline: 2, verdict: "x" });
  });

  test("undefined in a patch removes the field", () => {
    updateTrace("me", { cap: 1, fired: true });
    updateTrace("me", { cap: undefined });
    expect(readTrace("me")).toEqual({ at: expect.any(String), fired: true });
  });
});

describe("recordStated", () => {
  const nowS = Date.now() / 1000;
  const at = (usedPct: number) =>
    assess(
      makeReading({ now: nowS, plan: "max5", windows: { five_hour: { usedPct, elapsed: 0.05 } } }),
      DEFAULTS,
      nowS,
    );

  test("keeps a lower cap another hook recorded while this one ran", () => {
    const started = Date.now() - 1000;
    recordStated("me", at(86), { gate: "a" }, started - 5000);
    expect(readTrace("me")).toMatchObject({ cap: 1, fired: true });
    recordStated("me", at(10), { gate: "b" }, started);
    expect(readTrace("me")).toMatchObject({ cap: 1, fired: true, gate: "b" });
  });

  test("records a higher cap when the lower one was stated before this hook started", () => {
    recordStated("me", at(86), {}, Date.now() - 5000);
    recordStated("me", at(10), {}, Date.now() + 1);
    expect(readTrace("me")).toMatchObject({ cap: 3, baseline: 3, fired: false });
  });
});

describe("config", () => {
  test("fetchTimeoutMs is clamped so a hook stays inside its 10 s timeout", () => {
    for (const [given, expected] of [
      [60_000, 4000],
      [10, 500],
      [2500, 2500],
    ] as const) {
      writeFileSync(join(dir, "config.json"), JSON.stringify({ fetchTimeoutMs: given }));
      resetConfigCache();
      expect(loadConfig().fetchTimeoutMs).toBe(expected);
    }
    resetConfigCache();
  });
});
