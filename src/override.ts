// The user's manual cap, override.json: {cap, until, reason}, honoured while `until` is ahead.

import { unlinkSync } from "node:fs";
import { readJson, writeJsonAtomic } from "./fs-util.ts";
import { dataFile } from "./paths.ts";
import type { Override } from "./policy.ts";

export const overridePath = (): string => dataFile("override.json");

/** The file's content when well-formed, live or not; null when missing or malformed. */
export function readOverride(): Override | null {
  const o = readJson<Record<string, unknown>>(overridePath());
  if (!o || typeof o.cap !== "number" || typeof o.until !== "number") return null;
  return { cap: o.cap, until: o.until, ...(typeof o.reason === "string" && o.reason ? { reason: o.reason } : {}) };
}

export const writeOverride = (o: Override): boolean => writeJsonAtomic(overridePath(), o);

/** True when a file was removed. */
export function clearOverride(): boolean {
  try {
    unlinkSync(overridePath());
    return true;
  } catch {
    return false;
  }
}
