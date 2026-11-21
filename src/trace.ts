// Per-conversation record of what smart-usage last told each conversation, in trace.json.
//
// Injected context lives in one transcript and no other can see it, so retraction and lifting
// are per-conversation decisions. The prompt hook and the agent gate both write here for the
// same conversation: the gate's lines must update what the prompt hook believes was last stated.

import { readFileSync } from "node:fs";
import { readJson, renameWithRetry, withLock, writeJsonAtomic } from "./fs-util.ts";
import { isObj, nonEmptyString } from "./json.ts";
import { log } from "./log.ts";
import { dataFile } from "./paths.ts";

export interface TraceEntry {
  /** ISO time of the last write; entries older than TRACE_TTL_MS are pruned. */
  at: string;
  /** The last cap stated to this conversation; absent means none was ever stated. */
  cap?: number;
  /** The plan baseline last stated alongside `cap`. */
  baseline?: number;
  /** Whether the last line stated a constraint that will need superseding once it lifts. */
  fired?: boolean;
  /** Epoch ms when the last line was recorded; tells a concurrent hook its line may be newest. */
  statedAt?: number;
  /** What the prompt or session-start hook last decided. */
  verdict?: string;
  /** What the agent gate last decided, kept apart so a gate run does not overwrite `verdict`. */
  gate?: string;
}

export type TracePatch = { [K in Exclude<keyof TraceEntry, "at">]?: TraceEntry[K] | undefined };

/** A patch, or a function of the entry as it stands under the lock. */
export type TraceUpdate = TracePatch | ((prev: Partial<TraceEntry>) => TracePatch);

type TraceMap = Record<string, TraceEntry>;

const TRACE_FILE = "trace.json";
const TRACE_TTL_MS = 7 * 24 * 3600 * 1000;
// Holders keep the lock for about a millisecond; an older lock belongs to a killed process.
// The wait is short because a hook may update the trace twice inside its 10 s timeout.
const LOCK = { staleMs: 5000, waitMs: 500 };

/**
 * Which conversation an injected line lands in: session_id, plus `/agent_id` inside a subagent
 * (a subagent's hook output lands only in its own transcript). Without a session_id every
 * caller shares one slot, which is better than dropping the trace.
 */
export function conversationKey(input: { session_id?: unknown; agent_id?: unknown }): string {
  const session = nonEmptyString(input.session_id) ?? "shared";
  const agent = nonEmptyString(input.agent_id);
  return agent ? `${session}/${agent}` : session;
}

const FIELD_TYPES: Record<keyof TraceEntry, "string" | "number" | "boolean"> = {
  at: "string",
  cap: "number",
  baseline: "number",
  fired: "boolean",
  statedAt: "number",
  verdict: "string",
  gate: "string",
};

/** The entry's known fields with the right type; anything else reads as absent. */
function sanitize(entry: unknown): Partial<TraceEntry> {
  const out: Record<string, unknown> = {};
  if (!isObj(entry)) return out;
  for (const [k, type] of Object.entries(FIELD_TYPES)) {
    const v = entry[k];
    if (typeof v === type && (type !== "number" || Number.isFinite(v))) out[k] = v;
  }
  return out as Partial<TraceEntry>;
}

export function readTrace(key: string): Partial<TraceEntry> {
  const all = readJson<unknown>(dataFile(TRACE_FILE));
  return sanitize(isObj(all) ? all[key] : undefined);
}

type Loaded = { ok: true; all: TraceMap } | { ok: false };

/**
 * The map a writer merges into. A missing file is empty. A file that cannot be read right now
 * (Windows sharing violation) skips this write, since rewriting from {} would drop every other
 * conversation. A file that reads but does not parse cannot heal on its own (writes are
 * atomic), so it is set aside as trace.json.bad and writing resumes from empty.
 */
function loadForWrite(path: string): Loaded {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? { ok: true, all: {} } : { ok: false };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObj(parsed)) return { ok: true, all: parsed as TraceMap };
  } catch {
    /* set aside below */
  }
  try {
    renameWithRetry(path, `${path}.bad`);
    log("trace", () => "set aside an unparsable trace.json");
    return { ok: true, all: {} };
  } catch {
    return { ok: false };
  }
}

/**
 * Merges the update into this conversation's entry (an `undefined` value removes the field) and
 * prunes entries older than 7 days. Read-merge-write runs under a lock, so parallel hooks do not
 * drop each other's keys, and a function update sees the entry as it stands under that lock.
 * Never throws; skips the write when the lock cannot be taken or the file cannot be read.
 */
export function updateTrace(key: string, update: TraceUpdate, nowMs: number = Date.now()): void {
  const path = dataFile(TRACE_FILE);
  try {
    const result = withLock(`${path}.lock`, LOCK, () => {
      const loaded = loadForWrite(path);
      if (!loaded.ok) return false;
      const all = loaded.all;
      const cutoff = nowMs - TRACE_TTL_MS;
      for (const [k, e] of Object.entries(all)) {
        if (!(isObj(e) && Date.parse(e.at ?? "") > cutoff)) delete all[k];
      }
      const prev = sanitize(all[key]);
      const patch = typeof update === "function" ? update(prev) : update;
      const next: Record<string, unknown> = { ...prev, ...patch, at: new Date(nowMs).toISOString() };
      for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
      all[key] = next as unknown as TraceEntry;
      return writeJsonAtomic(path, all);
    });
    if (!result.acquired || !result.value) log("trace", () => `skipped write for ${key}`);
  } catch (e) {
    log("trace", () => `write for ${key} failed: ${String(e)}`);
  }
}
