import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, renameWithRetry, tryLock, withLock, writeJsonAtomic } from "../src/fs-util.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "smart-usage-fs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("JSON files", () => {
  test("writeJsonAtomic round-trips, creates the directory, leaves no temp files", () => {
    const path = join(dir, "nested", "a.json");
    expect(writeJsonAtomic(path, { a: 1 })).toBe(true);
    expect(writeJsonAtomic(path, { a: 2 })).toBe(true);
    expect(readJson<{ a: number }>(path)).toEqual({ a: 2 });
    expect(readdirSync(join(dir, "nested"))).toEqual(["a.json"]);
  });

  test("readJson: missing and torn files are null", () => {
    expect(readJson(join(dir, "none.json"))).toBeNull();
    writeFileSync(join(dir, "torn.json"), '{"a":');
    expect(readJson(join(dir, "torn.json"))).toBeNull();
  });
});

describe("lock", () => {
  const opts = { staleMs: 5000 };

  test("exclusive until released", () => {
    const lock = join(dir, "x.lock");
    const release = tryLock(lock, opts)!;
    expect(release).toBeFunction();
    expect(tryLock(lock, opts)).toBeNull();
    release();
    release();
    expect(existsSync(lock)).toBe(false);
    const again = tryLock(lock, opts);
    expect(again).not.toBeNull();
    again!();
  });

  test("a lock left by a killed process is stolen after staleMs", () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, "dead");
    const old = (Date.now() - 10_000) / 1000;
    utimesSync(lock, old, old);
    const release = tryLock(lock, opts);
    expect(release).not.toBeNull();
    release!();
  });

  test("a holder whose lock was stolen does not delete the thief's lock", () => {
    const lock = join(dir, "x.lock");
    const first = tryLock(lock, opts)!;
    writeFileSync(lock, "thief-token");
    first();
    expect(readFileSync(lock, "utf8")).toBe("thief-token");
  });

  test("withLock waits for a short holder, and reports a busy one", () => {
    const lock = join(dir, "x.lock");
    expect(withLock(lock, opts, () => 7)).toEqual({ acquired: true, value: 7 });
    const held = tryLock(lock, opts)!;
    expect(withLock(lock, { ...opts, waitMs: 30 }, () => 1)).toEqual({ acquired: false });
    held();
    expect(() => withLock(lock, opts, () => {
      throw new Error("boom");
    })).toThrow("boom");
    expect(existsSync(lock)).toBe(false);
  });
});

describe("lock edge cases", () => {
  const opts = { staleMs: 5000 };

  test("a lock dated in the future beyond the skew allowance is stolen", () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, "future");
    const ahead = (Date.now() + 3600_000) / 1000;
    utimesSync(lock, ahead, ahead);
    const release = tryLock(lock, opts);
    expect(release).not.toBeNull();
    release!();
  });

  test("a lock dated slightly ahead (within the skew allowance) is respected", () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, "live");
    const ahead = (Date.now() + 10_000) / 1000;
    utimesSync(lock, ahead, ahead);
    expect(tryLock(lock, opts)).toBeNull();
  });

  test("a failed token write removes the lock file it created", () => {
    const lock = join(dir, "x.lock");
    const spy = spyOn(fs, "writeSync").mockImplementation(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    try {
      expect(tryLock(lock, opts)).toBeNull();
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(lock)).toBe(false);
    const release = tryLock(lock, opts);
    expect(release).not.toBeNull();
    release!();
  });

  test("orphaned temp files are swept on the next write; fresh ones are left alone", () => {
    const path = join(dir, "a.json");
    const orphan = `${path}.999.dead.tmp`;
    const live = `${path}.998.live.tmp`;
    writeFileSync(orphan, "{");
    writeFileSync(live, "{");
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(orphan, old, old);
    expect(writeJsonAtomic(path, 1)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});

describe("renameWithRetry (Windows EPERM/EBUSY)", () => {
  test("transient EPERM/EBUSY is retried until the rename lands", () => {
    const real = fs.renameSync;
    let attempts = 0;
    const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      attempts++;
      if (attempts <= 2) throw Object.assign(new Error("busy"), { code: attempts === 1 ? "EPERM" : "EBUSY" });
      real(from, to);
    });
    try {
      expect(writeJsonAtomic(join(dir, "a.json"), { ok: 1 })).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(attempts).toBe(3);
    expect(readJson(join(dir, "a.json"))).toEqual({ ok: 1 });
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });

  test("a rename that never succeeds gives up, reports false and removes its temp file", () => {
    let attempts = 0;
    const spy = spyOn(fs, "renameSync").mockImplementation(() => {
      attempts++;
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    try {
      expect(writeJsonAtomic(join(dir, "a.json"), { ok: 1 })).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(attempts).toBe(6);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a non-transient error is not retried", () => {
    let attempts = 0;
    const spy = spyOn(fs, "renameSync").mockImplementation(() => {
      attempts++;
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });
    try {
      expect(() => renameWithRetry(join(dir, "x"), join(dir, "y"))).toThrow("gone");
    } finally {
      spy.mockRestore();
    }
    expect(attempts).toBe(1);
  });
});
