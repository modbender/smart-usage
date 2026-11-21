# smart-usage

A Claude Code plugin that paces subagents against your subscription's usage limits.

If you run subagents on a Pro, Max or Ultra plan, you have probably hit the 5-hour or weekly limit in the middle of a task. smart-usage reads your real plan usage from Anthropic, scales its limits to the size of your plan, and tells Claude how many subagents it may run at once. When a window is filling up it also suggests smaller models for subagents, and when the window is nearly spent it blocks new subagents outright. It needs no status line.

smart-usage is an independent project. It is not affiliated with or endorsed by Anthropic.

## Install

In Claude Code:

```
/plugin marketplace add modbender/smart-usage
/plugin install smart-usage@smart-usage
```

Requirements:

- Claude Code signed in with a Claude subscription (OAuth login). If you use an API key, the plugin finds no OAuth login and stays silent.
- `node` 22 or later on your PATH. The hooks and the command run as `node dist/*.mjs`. CI runs the tests on Node 22 and 24.

## How it works

### Reading your usage

Claude Code's own `/usage` view gets its numbers from `GET https://api.anthropic.com/api/oauth/usage`. smart-usage reads the same endpoint with the OAuth token Claude Code already stored, and reads `GET /api/oauth/profile` to work out your plan.

All sessions on one Claude config directory share a single cache in `<config dir>/smart-usage/usage-cache.json`, where `<config dir>` is `CLAUDE_CONFIG_DIR` or `~/.claude`. At most one usage request goes out per 5 minutes (`refreshSeconds`, default 300) across every session, and only one session fetches at a time, using a lock file. The profile is fetched once a day, or sooner if the set of reported windows changes. When the endpoint answers 429, smart-usage waits for the `Retry-After` time (60 seconds if none is given) and doubles the wait on each repeat, up to 30 minutes. Network errors, timeouts and 5xx responses back off the same way from 60 seconds. A rejected token waits one refresh interval.

### Plan scaling

A percentage alone does not tell you how much work is left. Pro's limits are a fifth of Max's, so 25% left on Pro is about as much work as 5% left on Max. smart-usage converts what is left into Max 5x-equivalent headroom:

```
headroom = (100 - percent used) * plan multiplier
```

Max 5x (now sold as "Max") is the reference plan with a multiplier of 1, because the thresholds were tuned on it in daily use. Pro is 0.2. Ultra is 4 for the 5-hour window and 2 for the weekly one.

### Cut-offs

Each window gets a cap from its headroom. The table shows the headroom thresholds, then what they mean as percent used on each plan. Read "70 / 85 / 95" as: cap 2 from 70% used, cap 1 from 85%, cap 0 from 95%. Below the cap 2 threshold you get the normal cap, which is 3 by default.

| Window | Headroom for cap 2 / 1 / 0 | Pro | Max (5x) | Ultra and legacy Max 20x |
|---|---|---|---|---|
| 5-hour | ≤ 30 / ≤ 15 / ≤ 5 | always 2 / 25 / 75 | 70 / 85 / 95 | 92.5 / 96.25 / 98.75 (unverified Ultra only; verified Ultra has no 5-hour window) |
| weekly | ≤ 15 / ≤ 8 / ≤ 3 | 25 / 60 / 85 | 85 / 92 / 97 | 92.5 / 96 / 98.5 |

The weekly thresholds are stricter in real terms than the 5-hour ones, because running out of the weekly limit can cost you days.

**Pro's baseline is 2.** A full Pro 5-hour window is only 20 Max-equivalent points, which already falls in the cap 2 tier with nothing used. That is simply how Pro works, so smart-usage tells Claude at the start of a session that up to 2 subagents is normal for the plan, and doesn't repeat it on every prompt.

The overall cap is the lowest cap across the reported windows.

### Pace

A level check misses a fast burn early in a window, so smart-usage also projects where each window will end at the current rate (`percent used / fraction of window elapsed`):

- 5-hour: projected 130% or more gives cap 2; 200% or more gives cap 1.
- Weekly: projected 110% or more gives cap 2; 150% or more gives cap 1.

Pace only counts once 20% of the 5-hour window has passed and 20% is used, or one day of the weekly window has passed and 15% is used. Earlier readings are too noisy. Pace is the same on every plan. A window's cap is the lower of its level cap and its pace cap. Any window projected at 100% or more also triggers the advice to use smaller models.

### Old readings

If the cache can't be refreshed (backoff, no network), smart-usage keeps using the last reading. Within one window usage only goes up until the reset, so a reading older than 15 minutes (`staleSeconds`) still works as a lower bound: the real cap is the same or lower. The line says so ("at least 88% used as of 20 min ago"). A window whose reset time has passed counts as 0% used. With no reading at all, smart-usage stays silent and Claude works as normal.

### The three hooks

| Hook | What it does |
|---|---|
| SessionStart | One briefing line when a cap is in force, or when the plan's baseline is below the normal cap (Pro). After `/clear` or compaction it forgets what this conversation was told, since that line is gone. |
| UserPromptSubmit | A line while there is pressure, or when the cap changed since this conversation was last told. When the pressure lifts, one line says so, then silence. |
| PreToolUse on `Agent` and `Workflow` | Re-reads usage on every launch, because an autonomous run can go hours without a prompt. At cap 0 it denies the launch and gives the line as the reason. Below the baseline it adds the line as context. When the cap differs from the one this conversation was last told, including a raise, it says so once. A launch that asks for a model past its per-model limit gets a note. Otherwise it stays silent. |

Every line restates everything still in force and says it supersedes earlier smart-usage lines, so an old line never reads as current. All hooks fail open: on any error they exit quietly and never block a prompt or a launch. They never auto-approve a tool call either, so your permission prompts work as before.

Here is a real line, produced by running the SessionStart hook against a test reading for a Max 5x plan with 88% of the 5-hour window used and 60% of that window elapsed:

> smart-usage, 2026-11-21T11:02Z: Max 5x plan; 5-hour window 88% used, resets in 2h 0m, on pace for 147% by reset; weekly window 41% used, resets in 3d 20h, on pace for 91% by reset. Subagent cap 1 (from the 5-hour window): at most 1 subagent in flight, a Workflow's agents included; run parallel stages one after another. The cap limits new launches only; cutting verification or scope on budget grounds needs the user's approval. At the current rate the 5-hour window runs out before reset. Prefer smaller models for subagents where the task allows. This supersedes every earlier smart-usage line in this conversation.

## Plans

| Plan | 5-hour limit vs Pro | Weekly limit vs Pro | Multiplier (5-hour / weekly) |
|---|---|---|---|
| Pro | 1x | 1x | 0.2 / 0.2 |
| Max (formerly Max 5x) | 5x | 5x | 1 / 1 |
| Ultra (formerly Max 20x) | 20x, unverified accounts only | 10x | 4 / 2 |
| Max 20x (legacy name) | as Ultra | as Ultra | 4 / 2 |

Verified Ultra accounts have no 5-hour window at all (the API reports it as `null`), so only the weekly window applies. Team, Enterprise and unrecognised plans use Pro's multiplier, the most cautious one.

The plan is detected automatically from your account profile: the plan's display name first, then its rate-limit tier and organization type, then the tier recorded in your stored credentials. If detection gets it wrong, set the `plan` option to one of `pro`, `max5`, `max20`, `ultra`, `team` or `enterprise`.

## The `/smart-usage` command

Plugin skills are namespaced, so the command is `/smart-usage:smart-usage`. It runs only when you type it; Claude does not call it on its own.

```
/smart-usage:smart-usage                              # same as status
/smart-usage:smart-usage status                       # plan, each window, the cap and why
/smart-usage:smart-usage status --json                # the same as JSON
/smart-usage:smart-usage refresh                      # fetch now, then show status
/smart-usage:smart-usage override 1 2h long refactor  # cap 1 for 2 hours, with a reason
/smart-usage:smart-usage override 0 reset             # no new subagents until the binding window resets
/smart-usage:smart-usage clear                        # remove the override
```

`refresh` skips the wait after an auth or network error, but it still respects a 429 backoff. An override replaces the computed cap, up or down, until it expires. Durations take `m`, `h` or `d` (`30m`, `2h`, `1.5d`). A cap above the normal cap is lowered to the normal cap.

Sample `status` output, with the plan set to `max5`:

```
Plan: Max 5x (max5, from config)
Reading: fresh, 31s old
Windows:
  5-hour: 88% used, headroom 12 (x1), elapsed 60%, projected 147%, level cap 1, pace cap 2, resets in 2h 0m -> cap 1
  weekly: 41% used, headroom 59 (x1), elapsed 45%, projected 91%, level cap none, pace cap none, resets in 3d 20h -> cap 3
Cap: 1 of 3 (binding: five_hour)
Plan baseline: 3
Override: none
Model advice: Prefer smaller models for subagents where the task allows.
Config: ~/.claude/smart-usage/config.json

Line the hooks would inject:
  smart-usage, 2026-11-21T11:05Z: Max 5x plan; 5-hour window 88% used, ...
```

## Configuration

### Plugin options

The plugin declares four options. Claude Code passes them to the hooks as `CLAUDE_PLUGIN_OPTION_<NAME>` environment variables.

| Option | Default | Meaning |
|---|---|---|
| `plan` | empty (detect) | `pro`, `max5`, `max20`, `ultra`, `team` or `enterprise` |
| `normal_cap` | 3 | Subagents allowed in flight when nothing is constrained (1 to 20) |
| `refresh_seconds` | 300 | At most one usage request per this many seconds, shared by all sessions (60 to 3600) |
| `debug` | off | Write `debug.log` (see Troubleshooting) |

### config.json

For everything else, create `<config dir>/smart-usage/config.json`. Precedence, lowest first: built-in defaults, then `config.json`, then plugin options. Objects merge key by key, arrays replace whole, and a value of the wrong type is ignored (and logged when debug is on). Each hook run reads the file fresh, so changes apply on the next prompt or launch.

```json
{
  "tiers": {
    "seven_day": [
      { "atMost": 4, "cap": 0 },
      { "atMost": 10, "cap": 1 },
      { "atMost": 20, "cap": 2 }
    ]
  },
  "multipliers": { "ultra": { "seven_day": 2.5 } },
  "pace": { "minUsedPct": { "five_hour": 30 } },
  "capNotes": {
    "0": "Reviews: do a flagged self-review inline and list the independent review as owed once the window resets.",
    "1": "Reviews: run the spec and quality reviewers one after the other, not in parallel."
  },
  "liftedFromZeroNote": "Run any reviews that were deferred while the cap was 0."
}
```

What this does:

- `tiers.seven_day` makes the weekly window stricter. Rows are checked in order and the first row whose `atMost` is at or above the headroom wins, so put the cap 0 row first. Because arrays replace whole, list every row you want for that window.
- `multipliers.ultra.seven_day` changes how big Ultra's weekly window is relative to Max 5x.
- `pace.minUsedPct.five_hour` waits until 30% of the 5-hour window is used before pace counts.
- `capNotes` appends your own text to the line whenever that cap is in force. Use it to tell Claude what your own process does under pressure, for example how reviews change at cap 0.
- `liftedFromZeroNote` is appended to the first line that lifts a cap of 0.

With that file, the cap 0 line ends its rule like this (from a test run):

> Subagent cap 0 (from the 5-hour window): no new subagents or workflows; finish and checkpoint current work, then continue inline. The cap limits new launches only; cutting verification or scope on budget grounds needs the user's approval. Reviews: do a flagged self-review inline and list the independent review as owed once the window resets.

All keys and their defaults are in [`src/config.ts`](src/config.ts) (`DEFAULTS`):

| Key | Default | Meaning |
|---|---|---|
| `plan` | `"auto"` | Plan id, or `"auto"` to detect |
| `normalCap` | 3 | Cap when nothing is constrained |
| `refreshSeconds` | 300 | Shared cache lifetime (minimum 60) |
| `staleSeconds` | 900 | Past this age a reading is only a lower bound |
| `fetchTimeoutMs` | 3000 | Timeout for the usage and profile requests together (500 to 4000) |
| `profileRefreshSeconds` | 86400 | How often the plan is re-checked |
| `multipliers` | see Plans | Per plan and window, relative to Max 5x |
| `tiers` | see Cut-offs | Headroom rows per window, cap 0 first |
| `pace` | see Pace | `enabled`, `rows`, `minElapsed`, `minUsedPct` per window |
| `warnProjectedPct` | 100 | Projected end-of-window percent that triggers a pace warning |
| `modelSteering` | on, 75, 90 | `enabled`, `scopedWarnPct`, `scopedAvoidPct` for per-model weekly limits |
| `capNotes` | `{}` | Extra text per cap, keyed `"0"`, `"1"`, ... |
| `liftedFromZeroNote` | `""` | Extra text on the first line after cap 0 lifts |
| `debug` | false | Same as the `debug` option |

`modelSteering` covers per-model weekly limits, such as a weekly cap on one model family. At 75% used the line mentions the limit. At 90% it tells Claude not to pick that model for new subagents, and the agent gate adds a note to any launch that asks for it.

## Privacy and safety

- smart-usage reads the OAuth token Claude Code stored: `.credentials.json` in your Claude config directory, the macOS Keychain entry, or the `CLAUDE_CODE_OAUTH_TOKEN` environment variable.
- It sends that token only to `api.anthropic.com`, in the `Authorization` header of the two requests above. It makes no other network calls. A test-only base URL override (`SMART_USAGE_API_BASE`) is accepted only for loopback addresses.
- It never refreshes the token and never writes any credentials store. Refreshing would rotate the refresh token and sign Claude Code out. If the token has expired, smart-usage waits for Claude Code to refresh it on its next API call.
- It never logs, prints or saves the token. The debug log records only which store the token came from.
- Everything it keeps is in `<config dir>/smart-usage/`: `config.json` (yours; the plugin only reads it), `usage-cache.json`, `override.json`, `trace.json` (what each conversation was last told; entries older than 7 days are pruned), `fetch.lock` and, with debug on, `debug.log`.
- The usage and profile endpoints are undocumented and may change. Responses are parsed defensively: an unexpected field is dropped. If a response can't be used at all, smart-usage keeps the last good reading, and with none it stays silent and Claude works as if the plugin weren't installed.

## Troubleshooting

### Check what smart-usage sees

Run `/smart-usage:smart-usage status`. `Reading:` shows where the numbers came from: `fresh`, `cached`, `stale`, `backoff`, `auth` (token expired or rejected), `no_credentials` (no OAuth login) or `error`, with a short reason.

### Turn on the debug log

Set the `debug` option, or start Claude Code with the variable set so the hooks inherit it:

```bash
SMART_USAGE_DEBUG=1 claude
```

Lines go to `<config dir>/smart-usage/debug.log`, tagged `fetch`, `lock`, `cache`, `plan`, `policy`, `hook`, `trace`, `config` or `cli`. Every hook writes its verdict and the inputs behind it. The file is emptied when it passes 1 MB.

### Numbers or plan look wrong

Run `/smart-usage:smart-usage refresh`. If the plan is still wrong after an upgrade, delete `usage-cache.json`; the next fetch rebuilds it and re-reads your profile. Or set the `plan` option.

### Persistent 429 responses

The endpoint rate-limits clients that poll it hard, especially several at once. smart-usage already backs off, up to 30 minutes between attempts, and keeps working from the last reading meanwhile. Don't delete `usage-cache.json` during a 429: the file holds the backoff, and deleting it triggers an immediate request. Raise `refresh_seconds` instead, and check whether another tool on your machine (a status line or usage monitor) is polling the same endpoint.

## Limitations

- The usage and profile endpoints are undocumented. If Anthropic changes them, smart-usage goes silent until it is updated.
- With `CLAUDE_CONFIG_DIR` set on macOS, the Keychain entry name (`Claude Code-credentials-<hash>`) comes from third-party reports, not from Claude Code itself. smart-usage falls back to the plain name `Claude Code-credentials`.
- The cut-offs were tuned on Max 5x. The numbers for other plans are derived from their published sizes, not tested on each plan.
- The cap works by telling Claude, and by denying new launches at cap 0. smart-usage does not count running agents, so at cap 1 or 2 it relies on Claude following the instruction.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```

`bun run build` bundles the hooks and the CLI into `dist/*.mjs`. `dist/` is committed so users need only `node`, and CI fails if it doesn't match a fresh build. `bun run check` runs typecheck, tests and build in that order. The design notes are in [`docs/design.md`](docs/design.md).

To run a hook against a test reading instead of the live endpoint, point it at a temporary data directory and a `Reading` JSON file (see `src/types.ts`, and `test/usage-fixtures.ts` for how the tests build one):

```bash
echo '{"session_id":"test"}' | SMART_USAGE_DATA_DIR="$(mktemp -d)" SMART_USAGE_READING_FILE=reading.json node dist/session-start.mjs
```

## License

MIT
