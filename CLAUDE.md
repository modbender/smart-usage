# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

smart-usage is a Claude Code plugin. It reads the account's plan usage from Anthropic's OAuth usage endpoint, scales limits to the plan's real size, and tells Claude how many subagents it may run at once (denying new ones near the limit). `docs/design.md` is the spec; read the relevant section before changing behaviour.

## Commands

```bash
bun install
bun run typecheck                          # tsc --noEmit
bun test                                   # all tests
bun test test/policy.test.ts               # one file
bun test -t "plan baseline"                # tests whose name matches
bun run build                              # bundle src/ into dist/*.mjs (node target)
bun run check                              # typecheck + test + build
```

`dist/` is committed and is what users run (`node dist/<hook>.mjs`); CI fails if it differs from a fresh build or has untracked files. Rebuild and commit `dist/` with every source change.

Run a hook by hand without network or credentials: `echo '{"session_id":"t"}' | SMART_USAGE_DATA_DIR="$(mktemp -d)" SMART_USAGE_READING_FILE=reading.json node dist/session-start.mjs`, where `reading.json` is a `Reading` (`src/types.ts`; `test/usage-fixtures.ts` builds them). Debug output: `SMART_USAGE_DEBUG=1`, written to `<data dir>/debug.log`.

## Architecture

Two layers meet at `src/types.ts` (`Reading`, `Snapshot`, `UsageWindow`, `PlanInfo`) and `src/reading.ts` (`currentReading()`, the only way hooks and the CLI get a reading).

- **Source layer** (`src/source/`): `credentials.ts` reads the OAuth token (credentials file, macOS Keychain, `CLAUDE_CODE_OAUTH_TOKEN`), read-only. `api.ts` calls `/api/oauth/usage` and `/api/oauth/profile` and parses them defensively. `plan.ts` detects the plan from a matcher table (display name first: the tier string still says `max_20x` on Ultra accounts). `cache.ts` and `index.ts` share one cache across all sessions and installs: one fetcher at a time under `fetch.lock`, backoff on 429/auth/errors, newer-version cache files honoured read-only.
- **Policy layer**: `policy.ts` turns a reading into an assessment: headroom in Max 5x-equivalent percent (`(100 - used) * multiplier`), level tiers and pace tiers per window, the plan baseline, override, model advice. `assessment.ts` combines reading, config and override. `wording.ts` builds every injected line. `trace.ts` records per conversation (`session_id`, plus `/agent_id` in a subagent) what cap was last stated.
- **Hooks** (`src/hooks/`, wired in `hooks/hooks.json`): SessionStart briefing, UserPromptSubmit line on change, PreToolUse gate on `Agent|Workflow`. `common.ts` (`runHook`) owns stdin parsing and fail-open exit.
- **CLI** (`src/cli.ts`) backs the `/smart-usage:smart-usage` skill in `skills/smart-usage/SKILL.md`.
- Shared helpers: `fs-util.ts` (atomic JSON writes, token-checked lock files), `json.ts`, `flags.ts`, `paths.ts`, `log.ts`, `config.ts` (every tunable and its default; plugin options arrive as `CLAUDE_PLUGIN_OPTION_*`).

State lives in `<CLAUDE_CONFIG_DIR or ~/.claude>/smart-usage/` (`src/paths.ts`), deliberately not `CLAUDE_PLUGIN_DATA`, so every install and session shares one fetch budget.

## Invariants

- **Hooks fail open**: any error exits 0 with no output. Never emit `permissionDecision: "allow"` (it would skip the user's permission prompt); deny only at cap 0.
- **Credentials are read-only**: never refresh the token (the refresh token rotates and would sign Claude Code out), never log or persist it, send it only to `api.anthropic.com` (`SMART_USAGE_API_BASE` is accepted for loopback hosts only, for tests).
- **No Bun APIs in `src/`**: bundles run under node. Tests may use Bun.
- **Supersede rule**: an injected line stays in context, so every line restates everything in force (cap and why, windows, model advice) and says it supersedes earlier lines. A change in what was stated gets exactly one line.
- **Calibration**: tiers are anchored on Max 5x (five-hour cap 2 / 1 / 0 from 70 / 85 / 95 % used, inclusive). Other plans derive from multipliers; tests assert the exact boundaries per plan.
- **Plan facts change** (Max 20x became Ultra on 2026-10-30; "Max" is the former Max 5x). Check current plan names and sizes before editing `src/source/plan.ts` or the multipliers.
- Adding a plan, tier, window or hook is a table entry (`config.ts`, `plan.ts`, `types.ts`), not a new branch.
