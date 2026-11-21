// Reading + config + override -> Assessment, the one path the hooks and the CLI share.

import { type Config, loadConfig } from "./config.ts";
import { readOverride } from "./override.ts";
import { type Assessment, assess } from "./policy.ts";
import { currentReading, type ReadingOptions } from "./reading.ts";
import type { Reading } from "./types.ts";

export interface State {
  config: Config;
  reading: Reading;
  assessment: Assessment;
}

export const nowSeconds = (): number => Date.now() / 1000;

export async function currentState(opts: ReadingOptions = {}): Promise<State> {
  const config = loadConfig();
  const reading = await currentReading(opts);
  return { config, reading, assessment: assess(reading, config, nowSeconds(), readOverride()) };
}
