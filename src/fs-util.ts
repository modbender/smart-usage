// Shared file primitives: atomic JSON writes, tolerant JSON reads, and an exclusive-create lock.
// Everything here runs under node as well as bun, so no Bun.* APIs.

import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { log } from "./log.ts";

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** Blocks the thread for `ms`; only for the few-millisecond retries below. */
export function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

const errCode = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? "";

// Windows refuses to replace a file another process has open at that instant; that is
// transient, so a few quick retries turn it into a success.
const RENAME_TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 6;

export function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (attempt >= RENAME_ATTEMPTS || !RENAME_TRANSIENT.has(errCode(e))) throw e;
      sleepSync(5 * attempt);
    }
  }
}

/** Parsed JSON, or null when the file is missing, torn or not JSON. */
export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Writes `value` as JSON via a temp file and a rename, so a reader never sees a torn file.
 * Creates the parent directory. Never throws; false means nothing was written.
 */
export function writeJsonAtomic(path: string, value: unknown): boolean {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(value));
    renameWithRetry(tmp, path);
    sweepOrphanTemps(path);
    return true;
  } catch (e) {
    log("cache", () => `write ${basename(path)} failed: ${errCode(e) || String(e)}`);
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing was written */
    }
    return false;
  }
}

// A temp file lives for milliseconds; one this old was left by a process killed mid-write.
const ORPHAN_TEMP_MS = 60_000;

/** Removes `<path>.<pid>.<random>.tmp` files old enough that no live writer still owns them. */
function sweepOrphanTemps(path: string): void {
  const dir = dirname(path);
  const prefix = `${basename(path)}.`;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      const full = join(dir, name);
      try {
        if (Date.now() - statSync(full).mtimeMs > ORPHAN_TEMP_MS) unlinkSync(full);
      } catch {
        /* another sweeper got it */
      }
    }
  } catch {
    /* sweeping is best effort */
  }
}

export interface LockOptions {
  /** A lock file older than this belongs to a killed process and is stolen. */
  staleMs: number;
  /** How long to keep retrying a held lock (synchronously). 0 or omitted: one attempt. */
  waitMs?: number;
}

/** Releases the lock; safe to call more than once. */
export type ReleaseLock = () => void;

// Only these mean another holder: the lock exists, or Windows is still deleting it.
// Anything else (an unusable directory) will not clear by waiting, so it gives up at once.
const LOCK_CONTENDED = new Set(["EEXIST", "EPERM", "EACCES"]);
const LOCK_CLOCK_SKEW_MS = 60_000;

/**
 * Exclusive-create lock. Returns a release function, or null when another process holds it
 * (or the directory is unusable). Each holder writes a unique token, and release removes the
 * file only while it still carries that token, so a holder whose lock was stolen as stale
 * cannot delete the thief's lock.
 *
 * Accepted races, each costing at most one duplicate critical section after a crash: two
 * processes stealing the same stale lock in the same instant can both acquire it, and release
 * reads the token then unlinks, so a steal landing between the two loses the thief's lock.
 */
export function tryLock(lockPath: string, opts: LockOptions): ReleaseLock | null {
  const name = basename(lockPath);
  const deadline = Date.now() + (opts.waitMs ?? 0);
  const token = `${process.pid}:${Math.random().toString(36).slice(2, 12)}`;
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    /* openSync below reports the real problem */
  }
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx");
    } catch (e) {
      const code = errCode(e);
      if (!LOCK_CONTENDED.has(code)) {
        log("lock", () => `${name} unusable: ${code || String(e)}`);
        return null;
      }
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        // A lock "from the future" (clock set back, skewed filesystem mtime) would otherwise
        // never age; past the skew allowance it is as untrustworthy as an old one.
        if (age > opts.staleMs || age < -LOCK_CLOCK_SKEW_MS) {
          unlinkSync(lockPath);
          log("lock", () => `stole stale ${name} (age ${Math.round(age)} ms)`);
          continue;
        }
      } catch (statErr) {
        // EEXIST then no lock: released meanwhile, so retry. EPERM/EACCES with no lock to be
        // found is a directory that refuses writes, not a holder.
        if (errCode(statErr) === "ENOENT") {
          if (code === "EEXIST") continue;
          log("lock", () => `${name} unusable: ${code}`);
          return null;
        }
      }
      if (Date.now() >= deadline) {
        log("lock", () => `${name} contended`);
        return null;
      }
      sleepSync(2 + Math.random() * 8);
      continue;
    }
    // This attempt created the file; if the token cannot be written, remove it again rather
    // than leave an empty lock that blocks every session for staleMs.
    try {
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      log("lock", () => `${name} unusable: ${errCode(e) || String(e)}`);
      try {
        unlinkSync(lockPath);
      } catch {
        /* nothing left to remove */
      }
      return null;
    }
    log("lock", () => `acquired ${name}`);
    return releaser(lockPath, name, token);
  }
}

function releaser(lockPath: string, name: string, token: string): ReleaseLock {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(lockPath, "utf8") === token) {
        unlinkSync(lockPath);
        log("lock", () => `released ${name}`);
      } else {
        log("lock", () => `${name} was stolen; left the new holder's lock in place`);
      }
    } catch {
      /* already gone (stolen and released) */
    }
  };
}

/** True when the lock file exists (someone holds it, or a stale one is lying around). */
export function lockHeld(lockPath: string): boolean {
  try {
    statSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `fn` under the lock. `{acquired: false}` when the lock could not be taken within
 * `opts.waitMs`; `fn` then did not run. `fn` must be synchronous: the lock is released when
 * it returns or throws (a throw propagates).
 */
export function withLock<T>(
  lockPath: string,
  opts: LockOptions,
  fn: () => T,
): { acquired: true; value: T } | { acquired: false } {
  const release = tryLock(lockPath, opts);
  if (!release) return { acquired: false };
  try {
    return { acquired: true, value: fn() };
  } finally {
    release();
  }
}
