# smart-usage design

smart-usage keeps Claude Code from running through a plan's usage limits by accident. It reads
the account's usage straight from Anthropic, works out how much room is left in absolute
terms for the account's plan, and tells the model how many subagents it may run at once.
It also blocks new subagents outright when the room is nearly gone.

## 1. Data source

Claude Code's own `/usage` view reads two OAuth endpoints. Neither is documented, so every
field is parsed defensively and anything unexpected drops that field, never the hook.

| Endpoint | Used for | Refresh |
|---|---|---|
| `GET https://api.anthropic.com/api/oauth/usage` | windows, per-model limits | at most once per `refreshSeconds` (300) across all sessions |
| `GET https://api.anthropic.com/api/oauth/profile` | plan detection | every `profileRefreshSeconds` (24 h), or when the set of reported windows changes |

Headers: `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`.

Observed response (Ultra, 2026-11-21, `test/fixtures/usage-ultra.json`):

- `five_hour`, `seven_day`: `null` or `{utilization: 0-100, resets_at: ISO-8601 | null, ...}`.
  On Ultra `five_hour` is `null`: the plan has no 5-hour limit.
- `limits[]`: `{kind: "weekly_all" | "weekly_scoped" | ..., percent, severity, resets_at, scope: {model: {display_name}}, is_active}`.
  `weekly_scoped` is a per-model weekly limit (Fable on Ultra).
- `seven_day_breakdown.window_started_at`: the real start of the weekly window.
- Legacy per-model fields `seven_day_opus`, `seven_day_sonnet`: same shape as `seven_day`.
- `pace`, `indicator`: `null` so far; ignored.

Profile (`test/fixtures/profile-ultra.json`): `organization.plan_display_name` is `"Ultra"`,
while `rate_limit_tier` says `default_claude_max_20x` and `organization_type` says
`claude_max`. `~/.claude/.credentials.json` said `max` / `default_claude_max_5x` on the same
account. **The display name is the only field that tracked the upgrade.**

The endpoint is known to answer 429 when polled hard, especially by several sessions at once
(claude-code issues 30930, 31319, 31637). Hence one shared cache, one fetcher at a time, and
backoff.

### Credentials (read-only)

Order: `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json` → `claudeAiOauth.accessToken`;
macOS Keychain (`security find-generic-password -s "Claude Code-credentials" -w`, the JSON
inside has the same shape; with `CLAUDE_CONFIG_DIR` set, a service name suffixed with a hash
of that dir is tried first, inferred from third-party reports and unverified); then the
`CLAUDE_CODE_OAUTH_TOKEN` env var.

- Never refresh the token. The refresh token rotates; using it would sign Claude Code out.
  An expired `expiresAt` (ms) means status `auth` without a request; Claude Code refreshes
  the token on its next API call and the next hook picks it up.
- Never log, print or persist the token. It goes only to the hardcoded Anthropic host.
  `SMART_USAGE_API_BASE` (tests) is honoured only for loopback hosts.
- No OAuth token (API-key users): status `no_credentials`, every hook stays silent.

### Shared cache, lock, backoff

All in `dataDir()` (`<CLAUDE_CONFIG_DIR or ~/.claude>/smart-usage/`, see `src/paths.ts`):

| File | Holds |
|---|---|
| `usage-cache.json` | last good `Snapshot`, last profile result, `backoffUntil`, `failures`, `lastError` |
| `fetch.lock` | exclusive-create lock; stolen when older than `fetchTimeoutMs * 2 + 2 s` |
| `override.json` | `{cap, until, reason}`, honoured while `until` is ahead |
| `trace.json` | per-conversation record of the last cap stated (see 4) |
| `config.json` | user config (see `src/config.ts`) |
| `debug.log` | debug channel, only when enabled |

`getReading({allowFetch, force})`:

1. Cache younger than `refreshSeconds` (and not `force`) → `cached`.
2. Inside `backoffUntil` → cache as is; status by the backoff's reason (`backoff` for 429 and
   errors, `auth`, `no_credentials`). `force` (`refresh`) skips auth, error and no_credentials
   backoffs, never a 429 one. Auth and no_credentials pauses also end as soon as the
   credential stores change (file or Keychain mtime, env var presence; never token material),
   so a fresh login works at once.
3. Try the lock. Lost it → cache as is (`cached`/`stale`). With no cache at all, wait up to
   `fetchTimeoutMs` for the holder, then re-read the cache.
4. Fetch with an abort timeout of `fetchTimeoutMs` (clamped to 500-4000 ms so a hook stays inside its 10 s timeout). 200 → write cache atomically
   (temp + rename, retried on Windows EPERM/EBUSY), status `fresh`. 429 → `backoffUntil` from
   `Retry-After` (seconds or HTTP date; 0 or missing is treated as 60 s), doubling on
   consecutive 429s only, max 1800 s. 401/403 → `auth`, retry after `refreshSeconds`. Network, timeout, 5xx →
   exponential backoff from 60 s.
5. Profile fetch rides on the same lock, only when due (see table), within what is left of the
   same `fetchTimeoutMs` budget. Its failure keeps the old plan, is retried after an hour, and
   never fails the usage read.

Atomic writes everywhere; a torn or unparsable cache file is treated as missing. Across plugin
versions the top-level `v`, `fetchedAt` and `backoffUntil` and the `fetch.lock` protocol are
permanent: an older version honours a newer file's gates and never overwrites it while that
file is recent, and takes over once it is not (so a downgrade recovers).

## 2. Plan detection

First hit wins, as a data table, not a branch chain:

1. `config.plan` when not `"auto"` (source `config`).
2. `plan_display_name`, case-insensitive, in this order: `/ultra/` → ultra, `/\bmax\b/` with
   `/\b20x?\b/` → max20, `/\bmax\b/` → max5 (the current plan is named just "Max"; it was "Max 5x"),
   `/\bpro\b/` → pro, `/team/` → team, `/enterprise/` → enterprise.
3. `rate_limit_tier`: `default_claude_max_20x` → **ultra** (Max 20x was renamed Ultra and
   the tier string kept the old name; Ultra's multiplier is also the more cautious of the two),
   `default_claude_max_5x` → max5, containing `pro` → pro. `max20` is reached only through a
   display name that still says "Max 20x" (legacy accounts, if any).
4. `organization_type`: `claude_pro` → pro, `claude_team` → team, `claude_enterprise` →
   enterprise. `claude_max` alone is ambiguous and falls through.
5. The `rateLimitTier` stored with the token, from whichever store supplied it (often stale;
   better than nothing).
6. `unknown` (multiplier 0.2, Pro's, the most cautious).

## 3. Policy: how much room is left, in absolute terms

The same percentage means very different amounts of work on different plans: 25% left on Pro
is a few subagents, 25% left on Max 20x is twenty times that. So the policy works in
**Max 5x-equivalent percent**:

    headroom = (100 - usedPct) * multiplier[plan][window]

Max 5x is the reference because the 5-hour tiers (70 / 85 / 95 %) were run on it in practice
before this plugin existed. Plan sizes (Anthropic renamed Max 20x to Ultra on 2026-10-30;
the current "Max" is the former Max 5x):

| Plan | 5-hour vs Pro | weekly vs Pro | multiplier five_hour / seven_day |
|---|---|---|---|
| Pro | 1x | 1x | 0.2 / 0.2 |
| Max (Max 5x) | 5x | 5x | 1 / 1 |
| Ultra (was Max 20x) | 20x, only on unverified accounts | 10x | 4 / 2 |
| Max 20x (legacy name) | as Ultra | as Ultra | 4 / 2 |
| Team, Enterprise, unknown | not researched | not researched | 0.2 / 0.2 (Pro's, the most cautious) |

Sources: secondary coverage quoting Anthropic's Help Center (e.g.
https://www.datastudios.org/post/claude-max-20x-renamed-ultra-removes-5-hour-limit-verified-accounts);
all configurable. Each window gives a cap; the overall cap is the minimum over reported
windows, clamped to `normalCap`.

**Level tiers** (`config.tiers`, first row whose `atMost` is at or above the headroom wins, with a 1e-9 tolerance for float multipliers). Cut-offs
below are % used at which cap 2 / 1 / 0 start:

| Window | cap 0 | cap 1 | cap 2 | Pro | Max (5x) | Ultra and legacy Max 20x |
|---|---|---|---|---|---|---|
| five_hour | ≤ 5 | ≤ 15 | ≤ 30 | always 2 / 25 / 75 | 70 / 85 / 95 | 92.5 / 96.25 / 98.75 (unverified Ultra only; verified Ultra has no 5-hour window) |
| seven_day | ≤ 3 | ≤ 8 | ≤ 15 | 25 / 60 / 85 | 85 / 92 / 97 | 92.5 / 96 / 98.5 |

The weekly rows are stricter in real terms than the 5-hour rows: running dry costs days, not
hours.

**Plan baseline.** A small plan can be capped at 0% used: a Pro 5-hour window is a fifth of
the reference, so the level tiers give Pro cap 2 with nothing spent. That is the plan's
normal, not pressure. `baseline = min(normalCap, level cap of each reported window at 0%
used)`; with no reported windows it is `normalCap`. Everything that talks about "normal" or
"pressure" uses the baseline: pressure means cap below baseline, a pace warning or a scoped
warning; "back to normal" means back to the baseline. A baseline below `normalCap` is stated
once per conversation (see section 4), not on every prompt.

**Pace** (`config.pace`), because a level alone misses a fast burn early in a window:

    elapsed   = (now - startedAt) / windowLength          (0..1)
    projected = usedPct / elapsed                         (end-of-window % at the current rate)

Counted only once `elapsed >= minElapsed` and `usedPct >= minUsedPct` (early readings are
noise): five_hour 20% elapsed and 20% used, seven_day one day and 25% used. Pace is
plan-independent: it is a ratio, and running out is running out.

By default pace only warns. A projection at or over `warnProjectedPct` is a pace warning: it
counts as pressure, triggers model steering and is named in the line, but sets no cap.
`pace.rows` is empty by default because a pace cap throttles a legitimate burst (ten agents
on ten features early in the week), and the level tiers already bound the cap as the limit
nears. The original hook treated weekly pace the same way. A user opts in to pace caps with
rows in `config.json`, highest projection first, e.g. five_hour ≥ 200 → cap 1, ≥ 130 → cap 2;
seven_day ≥ 150 → cap 1, ≥ 110 → cap 2.

Window cap = level cap, or min(level cap, pace cap) when rows are configured. The override
file, while live, replaces the computed cap (up or down).

**Reading age.** A reading older than `staleSeconds` is a floor: within one window usage only
rises until `resetsAt`, so an old figure is a lower bound and its cap is still valid, or too
lenient. A window whose `resetsAt` has passed rolled over: treat it as 0% used. A stale window
without `resetsAt` gives no cap. No snapshot at all gives the normal cap, silently: every hook
stays silent without a reported window, and the cap last stated to a conversation stands.

**Model steering** (`config.modelSteering`, advisory text only, never rewrites tool input):
whenever the cap is below the baseline or any window is projected at or over `warnProjectedPct`,
advise smaller models for subagents. A per-model limit at or over `scopedWarnPct` is mentioned;
at or over `scopedAvoidPct` the line advises against that model for new subagents, and the
agent gate adds a note to a launch whose `model` input names it. A limit the API marks
`is_active: false` counts too: what the flag means is undocumented, and its percentage
still says how close the model is to its own weekly cap.

## 4. Hooks

All three fail open: any error exits 0 with no output. All set `suppressOutput: true`. None
ever returns `permissionDecision: "allow"` (that would skip the user's permission prompt).

| Hook | When it speaks |
|---|---|
| SessionStart | Pressure exists, or the baseline is below `normalCap` (e.g. Pro): one briefing line. On `source` `clear` or `compact`, forget this conversation's stated cap first, since the earlier line is gone from context. On `resume`, silent when the trace already holds the current cap and baseline. On `fork`, always state the current cap (the fork inherits the transcript, but its trace may not know which cap that holds). |
| UserPromptSubmit | Pressure exists, or the cap or baseline changed since this conversation was last told (including a baseline below `normalCap` never stated yet). A steady baseline already stated is silence, so Pro is not told on every prompt. When nothing is at stake but the last line said otherwise, one retraction line, then silence. |
| PreToolUse `Agent\|Workflow` | Re-reads on every launch (autonomous runs go hours without a prompt). Cap 0 → `deny` with the line as `permissionDecisionReason`. Cap below the baseline → `additionalContext`. Any other change from the cap last stated to this conversation, raises included (e.g. back at the baseline, or an override above it) → one context line stating the new cap. A launch naming a model past `scopedAvoidPct` → context note. Otherwise silent. |

**Supersede rule.** Injected lines stay in context and keep reading as current. Every line
restates everything still in force (cap, windows, model advice) and says it supersedes earlier
smart-usage lines; dropping a part silently retracts it. The trace (`trace.json`) records per
conversation the last cap stated and whether the last line fired, keyed by `session_id`,
plus `/agent_id` inside a subagent (a subagent's hook output lands only in its own
transcript). Entries older than 7 days are pruned on write; writes take a lock.

**Wording.** Neutral by default. Cap 0: no new subagents or workflows; finish and checkpoint
current work, continue inline. Cap 1: at most one subagent in flight, a Workflow's agents
included; run parallel stages one after another. Cap n: at most n in flight. Lifted: back to
normal, up to `normalCap`. Every capped line also says the cap limits new launches only, and
that cutting verification or scope on budget grounds needs the user's approval.
`config.capNotes[cap]` appends the user's own text (e.g. how their review process adapts);
`config.liftedFromZeroNote` is appended to the first line that lifts a stated cap 0.

## 5. `/smart-usage`

A command backed by `dist/cli.mjs`. Plugin skills are namespaced, so it registers as
`/smart-usage:smart-usage`.

- `status [--json]`: plan and its source, each window (used, headroom units, elapsed, projected,
  level cap, pace cap), overall cap and why, reading age and source status, backoff, override,
  config file path.
- `refresh`: fetch now (still honours a 429 backoff).
- `override <cap> <duration|reset> [reason]`: write `override.json`; `reset` = until the
  binding window's `resetsAt`.
- `clear`: delete the override.

## 6. Build and layout

TypeScript in `src/`, developed and tested with bun. `scripts/build.ts` bundles each hook and
the CLI with `Bun.build({target: "node"})` into `dist/*.mjs`, committed, so users need only
`node`. CI checks that `dist/` matches a fresh build.

Plugin options (`userConfig` in `.claude-plugin/plugin.json`, reaching hooks as
`CLAUDE_PLUGIN_OPTION_<KEY>`): `plan`, `normal_cap`, `refresh_seconds`, `debug`. They have no
defaults, so an unset option never overrides `config.json`.

Environment seams: `SMART_USAGE_DATA_DIR` moves the data dir (tests, and users who want state
elsewhere); `SMART_USAGE_READING_FILE` replaces the reading with a JSON file and touches
neither network nor credentials (tests and reproducing a report); `SMART_USAGE_API_BASE`,
loopback only (tests).

Debug: `SMART_USAGE_DEBUG=1` or `"debug": true` writes tagged lines to `debug.log`
(`src/log.ts`): fetch start/stop and status, lock acquire/release/steal, cache hits, plan
detection and its source, every policy decision with its inputs, every hook's verdict.
