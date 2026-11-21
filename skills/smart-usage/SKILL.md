---
name: smart-usage
description: Show smart-usage's view of your plan usage and subagent cap, refresh it, or set a temporary cap override.
argument-hint: "[status [--json] | refresh | override <cap> <30m|2h|1d|reset> [reason] | clear]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" *)
---

The user's arguments, as typed: $ARGUMENTS

Run one command with the Bash tool and nothing before or after it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" <arguments>
```

Replace `<arguments>` with the user's arguments, split on spaces, each word in single quotes.
Inside a word, write an apostrophe as `'\''`. For example, the arguments `override 1 2h don't fan out`
become `'override' '1' '2h' 'don'\''t' 'fan' 'out'`. With no arguments, leave `<arguments>`
out; the command then runs `status`. The CLI joins the words after the duration into the
override reason.

Then show the command's output to the user verbatim in a code block and stop. Do not add analysis,
do not run anything else, and do not change any plan, cap or task based on it.
