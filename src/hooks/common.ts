// The skeleton every hook shares: read the JSON input on stdin, run, print at most one JSON
// object, then record what it said, exit 0. Fails open: unreadable input, a broken stdout or
// any throw means no output and exit 0, so a hook never blocks a prompt or a launch. The output
// type has no "allow": that would skip the user's permission prompt, which is not this
// plugin's call.

import { isObj } from "../json.ts";
import { log } from "../log.ts";

export interface HookInput {
  session_id?: unknown;
  agent_id?: unknown;
  source?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  [key: string]: unknown;
}

export type HookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse";

export interface HookOutput {
  additionalContext?: string;
  permissionDecision?: "deny";
  permissionDecisionReason?: string;
}

export interface HookResult {
  output: HookOutput;
  /** Records the line as stated; runs only once stdout has taken the output. */
  record?: () => void;
}

/**
 * When this hook process was spawned (not when this module loaded, which is ~0.3 s later); a
 * trace write after this came from a concurrent hook.
 */
export const HOOK_STARTED_MS = Date.now() - process.uptime() * 1000;

// Claude Code closes stdin after writing the payload; the cap only guards a manual run. Kept
// short: it counts against the 10 s hook timeout (see the budget in src/config.ts).
const STDIN_TIMEOUT_MS = 1000;

/** The parsed input object, or null when stdin is empty or not a JSON object. */
async function readHookInput(): Promise<HookInput | null> {
  const chunks: Buffer[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      process.stdin.destroy();
      resolve();
    }, STDIN_TIMEOUT_MS);
  });
  const read = (async () => {
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  })();
  await Promise.race([read, timeout]);
  clearTimeout(timer);
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return isObj(parsed) ? (parsed as HookInput) : null;
  } catch {
    return null;
  }
}

const exit = (): never => process.exit(0);

export function runHook(event: HookEvent, main: (input: HookInput) => Promise<HookResult | null>): void {
  // EPIPE (the reader went away) would otherwise crash with exit 1.
  process.stdout.on("error", (e) => {
    log("hook", () => `${event}: stdout failed: ${String(e)}`);
    exit();
  });
  (async () => {
    const input = await readHookInput();
    if (!input) {
      log("hook", () => `${event}: unreadable input, silent`);
      return exit();
    }
    const result = await main(input);
    if (!result) return exit();
    const body = JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...result.output }, suppressOutput: true });
    // Record and exit from the write callback: the write can still be pending on a pipe, and a
    // line must not be recorded as stated before it was handed over.
    process.stdout.write(body, (err) => {
      if (!err) {
        try {
          result.record?.();
        } catch (e) {
          log("hook", () => `${event}: record failed: ${String(e)}`);
        }
      }
      exit();
    });
  })().catch((e: unknown) => {
    log("hook", () => `${event} failed open: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    exit();
  });
}
