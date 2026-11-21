// The one entry point the hooks and the CLI use to get a reading.
// SMART_USAGE_READING_FILE (tests only) returns a Reading from a JSON file and never touches
// the network or credentials, so the hook tests do not depend on the source layer.

import { readFileSync } from "node:fs";
import type { Reading } from "./types.ts";

export interface ReadingOptions {
  /** false: never fetch, return whatever the cache holds. */
  allowFetch?: boolean;
  /** true: fetch even inside refreshSeconds (still honours a 429 backoff). */
  force?: boolean;
}

export async function currentReading(opts: ReadingOptions = {}): Promise<Reading> {
  const fixture = process.env.SMART_USAGE_READING_FILE;
  if (fixture) return JSON.parse(readFileSync(fixture, "utf8")) as Reading;
  const { getReading } = await import("./source/index.ts");
  return getReading(opts);
}
