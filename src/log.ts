// One gated debug channel. Off by default; on with SMART_USAGE_DEBUG=1 or config "debug": true.
// Messages are thunks so nothing is formatted while it is off.

import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isTruthyFlag } from "./flags.ts";
import { dataDir, dataFile } from "./paths.ts";

export type LogTag = "fetch" | "lock" | "cache" | "plan" | "policy" | "hook" | "trace" | "config" | "cli";

const MAX_BYTES = 1024 * 1024;
const envOn = isTruthyFlag(process.env.SMART_USAGE_DEBUG);
let enabled = envOn;

export const setDebug = (on: boolean): void => {
  enabled = envOn || on;
};

export const debugEnabled = (): boolean => enabled;

export function log(tag: LogTag, message: () => string): void {
  if (!enabled) return;
  try {
    mkdirSync(dataDir(), { recursive: true });
    const file = dataFile("debug.log");
    try {
      if (statSync(file).size > MAX_BYTES) writeFileSync(file, "");
    } catch {
      /* first write */
    }
    appendFileSync(file, `${new Date().toISOString()} [${process.pid}] [${tag}] ${message()}\n`);
  } catch {
    /* logging never breaks a hook */
  }
}
