// /smart-usage backend: status [--json] | refresh | override <cap> <duration|reset> [reason] | clear

import { currentState, nowSeconds, type State } from "./assessment.ts";
import { log } from "./log.ts";
import { clearOverride, overridePath, readOverride, writeOverride } from "./override.ts";
import { dataDir, dataFile } from "./paths.ts";
import { hasReducedBaseline, isBelowBaseline, round1, type WindowAssessment } from "./policy.ts";
import { readCache } from "./source/cache.ts";
import { formatDuration, modelAdvice, stamp, usageLine, WINDOW_LABEL } from "./wording.ts";

const USAGE = `Usage: smart-usage <command>

  status [--json]                        plan, windows, cap and why
  refresh                                fetch now (still honours a 429 backoff), then status
  override <cap> <30m|2h|1d|reset> [reason]
                                         set the cap by hand until the time given; "reset" means
                                         until the binding window resets
  clear                                  remove the override`;

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

/** Errors and usage-on-error go to stderr, so `status --json` stdout is always JSON or empty. */
const err = (text: string): void => {
  process.stderr.write(`${text}\n`);
};

class UsageError extends Error {}

const DURATION_UNIT_SECONDS: Record<string, number> = { m: 60, h: 3600, d: 86400 };

/** "30m" / "2h" / "1.5d" -> seconds; null when malformed. */
function parseDuration(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([mhd])$/i.exec(text.trim());
  const unit = m?.[2] ? DURATION_UNIT_SECONDS[m[2].toLowerCase()] : undefined;
  if (!m?.[1] || unit === undefined) return null;
  const seconds = Number(m[1]) * unit;
  return seconds > 0 ? seconds : null;
}

function backoffUntil(): number | null {
  const until = readCache().backoffUntil;
  return until > 0 ? until : null;
}

function statusJson(s: State): Record<string, unknown> {
  const a = s.assessment;
  const raw = readOverride();
  const backoff = backoffUntil();
  return {
    plan: a.plan,
    reading: { status: s.reading.status, ageSeconds: a.ageSeconds, detail: s.reading.detail ?? null },
    backoffUntil: backoff !== null && backoff > a.now ? backoff : null,
    windows: a.windows.map((w) => ({
      kind: w.kind,
      basis: w.basis,
      usedPct: w.usedPct,
      resetsAt: w.resetsAt,
      multiplier: w.multiplier,
      headroom: round1(w.headroom),
      elapsed: w.elapsed === null ? null : Math.round(w.elapsed * 1000) / 1000,
      projected: round1(w.projected),
      levelCap: w.levelCap,
      paceCap: w.paceCap,
      cap: w.cap,
    })),
    normalCap: a.normalCap,
    baseline: a.baseline,
    computedCap: a.computedCap,
    cap: a.cap,
    binding: a.binding,
    override: raw ? { ...raw, live: a.override !== null } : null,
    paceWarnings: a.paceWarnings,
    scoped: a.scoped,
    steerSmaller: a.steerSmaller,
    pressure: a.pressure,
    line: usageLine(a, s.config),
    configPath: dataFile("config.json"),
    dataDir: dataDir(),
  };
}

function windowText(w: WindowAssessment, now: number): string {
  const label = WINDOW_LABEL[w.kind];
  if (w.basis === "rolled_over") return `  ${label}: rolled over (treated as 0% used) -> no cap`;
  if (w.basis === "no_reading") return `  ${label}: stale reading without a reset time -> no cap`;
  const parts = [
    `${w.basis === "floor" ? "at least " : ""}${round1(w.usedPct)}% used`,
    `headroom ${round1(w.headroom)} (x${w.multiplier})`,
    w.elapsed === null ? "elapsed unknown" : `elapsed ${Math.round(w.elapsed * 100)}%`,
    w.projected === null ? "pace not counted yet" : `projected ${Math.round(w.projected)}%`,
    `level cap ${w.levelCap ?? "none"}`,
    `pace cap ${w.paceCap ?? "none"}`,
    w.resetsAt !== null ? `resets in ${formatDuration(w.resetsAt - now)}` : "no reset time",
  ];
  return `  ${label}: ${parts.join(", ")} -> cap ${w.cap}`;
}

function statusText(s: State): string {
  const a = s.assessment;
  const raw = readOverride();
  const backoff = backoffUntil();
  const lines = [
    `Plan: ${a.plan ? `${a.plan.label} (${a.plan.id}, from ${a.plan.source})` : "unknown (no reading)"}`,
    `Reading: ${s.reading.status}${a.ageSeconds !== null ? `, ${Math.round(a.ageSeconds)}s old` : ""}` +
      `${s.reading.detail ? ` (${s.reading.detail})` : ""}`,
    ...(backoff !== null && backoff > a.now ? [`Backoff: no fetch before ${stamp(backoff)}`] : []),
    "Windows:",
    ...(a.windows.length ? a.windows.map((w) => windowText(w, a.now)) : ["  none reported"]),
    `Cap: ${a.cap} of ${a.normalCap}` +
      (a.override
        ? ` (override; computed ${a.computedCap})`
        : isBelowBaseline(a) && a.binding
          ? ` (binding: ${a.binding})`
          : a.cap < a.normalCap
            ? " (the plan's normal)"
            : " (normal)"),
    `Plan baseline: ${a.baseline}${hasReducedBaseline(a) ? " (cap at 0% used on this plan)" : ""}`,
    `Override: ${
      raw
        ? `cap ${raw.cap} until ${stamp(raw.until)}${raw.reason ? ` (${raw.reason})` : ""}${a.override ? "" : " -- expired"}`
        : "none"
    }`,
    `Model advice: ${modelAdvice(a).join(" ") || "none"}`,
    `Config: ${dataFile("config.json")}`,
    "",
    `Line the hooks would inject:\n  ${usageLine(a, s.config)}`,
  ];
  return lines.join("\n");
}

async function status(args: string[], force = false): Promise<void> {
  const s = await currentState(force ? { force: true } : {});
  log("cli", () => `status force=${force} cap=${s.assessment.cap} status=${s.reading.status}`);
  out(args.includes("--json") ? JSON.stringify(statusJson(s), null, 2) : statusText(s));
}

async function override(args: string[]): Promise<void> {
  const [capArg, durationArg, ...reasonParts] = args;
  if (!capArg || !/^\d+$/.test(capArg) || !durationArg) throw new UsageError("override needs <cap> and <duration|reset>");
  const s = await currentState();
  const a = s.assessment;
  let until: number;
  if (durationArg.toLowerCase() === "reset") {
    const binding = a.windows.find((w) => w.kind === a.binding);
    if (!binding?.resetsAt || binding.resetsAt <= a.now) {
      throw new UsageError("no window with a future reset time to tie the override to; give a duration instead");
    }
    until = binding.resetsAt;
  } else {
    const seconds = parseDuration(durationArg);
    if (seconds === null) throw new UsageError(`bad duration "${durationArg}"; use e.g. 30m, 2h, 1d or reset`);
    until = Math.round(nowSeconds() + seconds);
  }
  const requested = Number(capArg);
  const cap = Math.min(requested, a.normalCap);
  const reason = reasonParts.join(" ").trim();
  if (!writeOverride({ cap, until, ...(reason ? { reason } : {}) })) {
    throw new Error(`could not write ${overridePath()}`);
  }
  log("cli", () => `override cap=${cap} until=${until} reason=${reason || "-"}`);
  out(
    `Override set: cap ${cap} until ${stamp(until)}${reason ? ` (${reason})` : ""}.` +
      (requested > cap ? ` Requested ${requested} is above the normal cap, so ${cap} applies.` : ""),
  );
}

function clear(): void {
  const removed = clearOverride();
  log("cli", () => `clear removed=${removed}`);
  out(removed ? "Override cleared." : "No override was set.");
}

const COMMANDS: Record<string, (args: string[]) => Promise<void> | void> = {
  status: (args) => status(args),
  refresh: (args) => status(args, true),
  override,
  clear,
};

async function main(argv: string[]): Promise<number> {
  const [name = "status", ...args] = argv;
  const command = COMMANDS[name];
  if (!command) {
    const help = name === "help" || name === "--help" || name === "-h";
    (help ? out : err)(USAGE);
    return help ? 0 : 2;
  }
  try {
    await command(args);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`smart-usage: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    log("cli", () => `${name} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    err(`smart-usage: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
