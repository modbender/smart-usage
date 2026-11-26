var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// src/flags.ts
var isTruthyFlag = (v) => /^(1|true|yes|on)$/i.test(v ?? "");

// src/json.ts
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v), asObj = (v) => isObj(v) ? v : null, nonEmptyString = (v) => typeof v === "string" && v !== "" ? v : null, finiteNumber = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;

// src/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
var claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), dataDir = () => process.env.SMART_USAGE_DATA_DIR || join(claudeConfigDir(), "smart-usage"), dataFile = (name) => join(dataDir(), name);
var init_paths = () => {};

// src/log.ts
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
function log(tag, message) {
  if (!enabled)
    return;
  try {
    mkdirSync(dataDir(), { recursive: true });
    const file = dataFile("debug.log");
    try {
      if (statSync(file).size > MAX_BYTES)
        writeFileSync(file, "");
    } catch {}
    appendFileSync(file, `${new Date().toISOString()} [${process.pid}] [${tag}] ${message()}
`);
  } catch {}
}
var MAX_BYTES, envOn, enabled, setDebug = (on) => {
  enabled = envOn || on;
};
var init_log = __esm(() => {
  init_paths();
  MAX_BYTES = 1024 * 1024;
  envOn = isTruthyFlag(process.env.SMART_USAGE_DEBUG);
  enabled = envOn;
});

// src/types.ts
var WINDOW_KINDS, WINDOW_SECONDS, PLAN_IDS;
var init_types = __esm(() => {
  WINDOW_KINDS = ["five_hour", "seven_day"];
  WINDOW_SECONDS = {
    five_hour: 5 * 3600,
    seven_day: 7 * 24 * 3600
  };
  PLAN_IDS = ["pro", "max5", "max20", "ultra", "team", "enterprise", "unknown"];
});

// src/config.ts
import { readFileSync } from "node:fs";
function merge(base, patch, path) {
  if (!isObj(patch) || !isObj(base))
    return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = base[k];
    const where = `${path}${k}`;
    if (cur === undefined) {
      if (path === "capNotes." && typeof v === "string")
        out[k] = v;
      else
        log("config", () => `ignored unknown key ${where}`);
    } else if (Array.isArray(cur)) {
      if (Array.isArray(v))
        out[k] = v;
      else
        log("config", () => `ignored ${where}: expected array`);
    } else if (isObj(cur)) {
      out[k] = merge(cur, v, `${where}.`);
    } else if (typeof v === typeof cur) {
      out[k] = v;
    } else {
      log("config", () => `ignored ${where}: expected ${typeof cur}`);
    }
  }
  return out;
}
function fromOptions() {
  const out = {};
  const plan = optionEnv("PLAN")?.toLowerCase();
  if (plan && (plan === "auto" || PLAN_IDS.includes(plan)))
    out.plan = plan;
  const cap = Number(optionEnv("NORMAL_CAP"));
  if (Number.isInteger(cap) && cap >= 1)
    out.normalCap = cap;
  const refresh = Number(optionEnv("REFRESH_SECONDS"));
  if (Number.isFinite(refresh) && refresh >= 60)
    out.refreshSeconds = refresh;
  const debug = optionEnv("DEBUG");
  if (debug !== undefined)
    out.debug = isTruthyFlag(debug);
  return out;
}
function sane(c) {
  const plan = c.plan === "auto" || PLAN_IDS.includes(c.plan) ? c.plan : "auto";
  return {
    ...c,
    plan,
    normalCap: Math.max(1, Math.floor(c.normalCap)),
    refreshSeconds: Math.max(60, c.refreshSeconds),
    staleSeconds: Math.max(c.refreshSeconds, c.staleSeconds),
    fetchTimeoutMs: Math.min(FETCH_TIMEOUT_MS.max, Math.max(FETCH_TIMEOUT_MS.min, c.fetchTimeoutMs))
  };
}
function loadConfig() {
  if (cached)
    return cached;
  let file = {};
  try {
    file = JSON.parse(readFileSync(dataFile("config.json"), "utf8"));
  } catch {}
  cached = sane(merge(merge(DEFAULTS, file, ""), fromOptions(), ""));
  setDebug(cached.debug);
  return cached;
}
var DEFAULTS, optionEnv = (key) => {
  const v = process.env[`CLAUDE_PLUGIN_OPTION_${key}`];
  return v === undefined || v === "" ? undefined : v;
}, FETCH_TIMEOUT_MS, cached = null;
var init_config = __esm(() => {
  init_log();
  init_paths();
  init_types();
  DEFAULTS = {
    plan: "auto",
    normalCap: 3,
    refreshSeconds: 300,
    staleSeconds: 900,
    fetchTimeoutMs: 3000,
    profileRefreshSeconds: 24 * 3600,
    multipliers: {
      pro: { five_hour: 0.2, seven_day: 0.2 },
      max5: { five_hour: 1, seven_day: 1 },
      max20: { five_hour: 4, seven_day: 2 },
      ultra: { five_hour: 4, seven_day: 2 },
      team: { five_hour: 0.2, seven_day: 0.2 },
      enterprise: { five_hour: 0.2, seven_day: 0.2 },
      unknown: { five_hour: 0.2, seven_day: 0.2 }
    },
    tiers: {
      five_hour: [
        { atMost: 5, cap: 0 },
        { atMost: 15, cap: 1 },
        { atMost: 30, cap: 2 }
      ],
      seven_day: [
        { atMost: 3, cap: 0 },
        { atMost: 8, cap: 1 },
        { atMost: 15, cap: 2 }
      ]
    },
    pace: {
      enabled: true,
      rows: { five_hour: [], seven_day: [] },
      minElapsed: { five_hour: 0.2, seven_day: 1 / 7 },
      minUsedPct: { five_hour: 20, seven_day: 25 }
    },
    warnProjectedPct: 100,
    modelSteering: { enabled: true, scopedWarnPct: 75, scopedAvoidPct: 90 },
    capNotes: {},
    liftedFromZeroNote: "",
    debug: false
  };
  FETCH_TIMEOUT_MS = { min: 500, max: 4000 };
});

// src/fs-util.ts
import {
  closeSync,
  mkdirSync as mkdirSync2,
  openSync,
  readdirSync,
  readFileSync as readFileSync2,
  renameSync,
  statSync as statSync2,
  unlinkSync,
  writeFileSync as writeFileSync2,
  writeSync
} from "node:fs";
import { basename, dirname, join as join2 } from "node:path";
function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}
function renameWithRetry(from, to) {
  for (let attempt = 1;; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (attempt >= RENAME_ATTEMPTS || !RENAME_TRANSIENT.has(errCode(e)))
        throw e;
      sleepSync(5 * attempt);
    }
  }
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync2(path, "utf8"));
  } catch {
    return null;
  }
}
function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    mkdirSync2(dirname(path), { recursive: true });
    writeFileSync2(tmp, JSON.stringify(value));
    renameWithRetry(tmp, path);
    sweepOrphanTemps(path);
    return true;
  } catch (e) {
    log("cache", () => `write ${basename(path)} failed: ${errCode(e) || String(e)}`);
    try {
      unlinkSync(tmp);
    } catch {}
    return false;
  }
}
function sweepOrphanTemps(path) {
  const dir = dirname(path);
  const prefix = `${basename(path)}.`;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp"))
        continue;
      const full = join2(dir, name);
      try {
        if (Date.now() - statSync2(full).mtimeMs > ORPHAN_TEMP_MS)
          unlinkSync(full);
      } catch {}
    }
  } catch {}
}
function tryLock(lockPath, opts) {
  const name = basename(lockPath);
  const deadline = Date.now() + (opts.waitMs ?? 0);
  const token = `${process.pid}:${Math.random().toString(36).slice(2, 12)}`;
  try {
    mkdirSync2(dirname(lockPath), { recursive: true });
  } catch {}
  for (;; ) {
    let fd;
    try {
      fd = openSync(lockPath, "wx");
    } catch (e) {
      const code = errCode(e);
      if (!LOCK_CONTENDED.has(code)) {
        log("lock", () => `${name} unusable: ${code || String(e)}`);
        return null;
      }
      try {
        const age = Date.now() - statSync2(lockPath).mtimeMs;
        if (age > opts.staleMs || age < -LOCK_CLOCK_SKEW_MS) {
          unlinkSync(lockPath);
          log("lock", () => `stole stale ${name} (age ${Math.round(age)} ms)`);
          continue;
        }
      } catch (statErr) {
        if (errCode(statErr) === "ENOENT") {
          if (code === "EEXIST")
            continue;
          log("lock", () => `${name} unusable: ${code}`);
          return null;
        }
      }
      if (Date.now() >= deadline) {
        log("lock", () => `${name} contended`);
        return null;
      }
      sleepSync(2 + Math.random() * 8);
      continue;
    }
    try {
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      log("lock", () => `${name} unusable: ${errCode(e) || String(e)}`);
      try {
        unlinkSync(lockPath);
      } catch {}
      return null;
    }
    log("lock", () => `acquired ${name}`);
    return releaser(lockPath, name, token);
  }
}
function releaser(lockPath, name, token) {
  let released = false;
  return () => {
    if (released)
      return;
    released = true;
    try {
      if (readFileSync2(lockPath, "utf8") === token) {
        unlinkSync(lockPath);
        log("lock", () => `released ${name}`);
      } else {
        log("lock", () => `${name} was stolen; left the new holder's lock in place`);
      }
    } catch {}
  };
}
function lockHeld(lockPath) {
  try {
    statSync2(lockPath);
    return true;
  } catch {
    return false;
  }
}
function withLock(lockPath, opts, fn) {
  const release = tryLock(lockPath, opts);
  if (!release)
    return { acquired: false };
  try {
    return { acquired: true, value: fn() };
  } finally {
    release();
  }
}
var sleepCell, errCode = (e) => e?.code ?? "", RENAME_TRANSIENT, RENAME_ATTEMPTS = 6, ORPHAN_TEMP_MS = 60000, LOCK_CONTENDED, LOCK_CLOCK_SKEW_MS = 60000;
var init_fs_util = __esm(() => {
  init_log();
  sleepCell = new Int32Array(new SharedArrayBuffer(4));
  RENAME_TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
  LOCK_CONTENDED = new Set(["EEXIST", "EPERM", "EACCES"]);
});

// src/source/api.ts
function apiBase(env = process.env) {
  const raw = env.SMART_USAGE_API_BASE;
  if (!raw)
    return DEFAULT_API_BASE;
  try {
    const url = new URL(raw);
    if ((url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname)) {
      return raw.replace(/\/+$/, "");
    }
  } catch {}
  log("fetch", () => "ignored SMART_USAGE_API_BASE: not a loopback http(s) URL");
  return DEFAULT_API_BASE;
}
function parseWindow(root, spec, limits) {
  const raw = asObj(root[spec.field]);
  if (!raw)
    return null;
  const usedPct = finiteNumber(raw.utilization);
  if (usedPct === null || usedPct < 0) {
    log("fetch", () => `dropped ${spec.kind}: utilization ${JSON.stringify(raw.utilization)}`);
    return null;
  }
  const resetsAt = epochSeconds(raw.resets_at);
  const stated = spec.startedAtPath ? epochSeconds(at(root, spec.startedAtPath)) : null;
  const startedAt = stated ?? (resetsAt === null ? null : resetsAt - WINDOW_SECONDS[spec.kind]);
  const limit = limits.find((l) => spec.limitKinds.includes(String(l.kind)));
  const severity = nonEmptyString(raw.severity) ?? nonEmptyString(limit?.severity) ?? null;
  return { kind: spec.kind, usedPct, resetsAt, startedAt, severity };
}
function parseScopedLimit(limit) {
  if (limit.kind !== SCOPED_LIMIT_KIND)
    return null;
  const model = nonEmptyString(at(limit, ["scope", "model", "display_name"]));
  const usedPct = finiteNumber(limit.percent);
  if (!model || usedPct === null)
    return null;
  return { model, usedPct, resetsAt: epochSeconds(limit.resets_at), active: limit.is_active === true };
}
function parseUsage(body) {
  const root = asObj(body);
  if (!root)
    return null;
  const limits = limitsOf(root);
  const windows = {};
  for (const spec of WINDOW_SPECS) {
    const w = parseWindow(root, spec, limits);
    if (w)
      windows[spec.kind] = w;
  }
  const scoped = limits.map(parseScopedLimit).filter((s) => s !== null);
  const known = new Set(scoped.map((s) => s.model.toLowerCase()));
  for (const { field, model } of LEGACY_SCOPED_FIELDS) {
    const raw = asObj(root[field]);
    const usedPct = finiteNumber(raw?.utilization);
    if (!raw || usedPct === null || known.has(model.toLowerCase()))
      continue;
    scoped.push({ model, usedPct, resetsAt: epochSeconds(raw.resets_at), active: true });
  }
  return { windows, scoped };
}
function parseProfile(body, nowS) {
  const org = asObj(asObj(body)?.organization);
  if (!org)
    return null;
  return {
    fetchedAt: nowS,
    displayName: nonEmptyString(org.plan_display_name),
    rateLimitTier: nonEmptyString(org.rate_limit_tier),
    organizationType: nonEmptyString(org.organization_type)
  };
}
function networkErrorCode(e) {
  const code = (v) => {
    const c = v?.code;
    return typeof c === "string" && c !== "" ? c : null;
  };
  return code(e) ?? code(e?.cause) ?? "fetch failed";
}
async function fetchJson(path, opts) {
  const started = Date.now();
  const ms = () => Date.now() - started;
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  log("fetch", () => `GET ${path} start`);
  try {
    const res = await opts.fetchImpl(`${opts.base}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "anthropic-beta": OAUTH_BETA,
        Accept: "application/json"
      },
      signal: controller.signal
    });
    if (res.status !== 200) {
      const retryAfter = res.headers.get("retry-after");
      await res.body?.cancel().catch(() => {});
      log("fetch", () => `GET ${path} -> ${res.status} in ${ms()} ms`);
      return { kind: "http", status: res.status, retryAfter };
    }
    let body;
    try {
      body = JSON.parse(await res.text());
    } catch (e) {
      if (controller.signal.aborted)
        throw e;
      log("fetch", () => `GET ${path} -> 200 with unparsable body in ${ms()} ms`);
      return { kind: "bad_body" };
    }
    log("fetch", () => `GET ${path} -> 200 in ${ms()} ms`);
    return { kind: "ok", body };
  } catch (e) {
    if (controller.signal.aborted) {
      log("fetch", () => `GET ${path} timed out after ${ms()} ms`);
      return { kind: "timeout" };
    }
    const detail = networkErrorCode(e);
    log("fetch", () => `GET ${path} failed in ${ms()} ms: ${detail}`);
    return { kind: "network", detail };
  } finally {
    clearTimeout(timer);
  }
}
function parseRetryAfter(header, nowMs) {
  if (header === null)
    return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed))
    return Number(trimmed);
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - nowMs) / 1000)) : null;
}
var DEFAULT_API_BASE = "https://api.anthropic.com", USAGE_PATH = "/api/oauth/usage", PROFILE_PATH = "/api/oauth/profile", OAUTH_BETA = "oauth-2025-04-20", LOOPBACK_HOSTS, epochSeconds = (v) => {
  const s = nonEmptyString(v);
  if (!s)
    return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}, at = (root, path) => path.reduce((node, key) => asObj(node)?.[key], root), WINDOW_SPECS, LEGACY_SCOPED_FIELDS, SCOPED_LIMIT_KIND = "weekly_scoped", limitsOf = (root) => Array.isArray(root.limits) ? root.limits.map(asObj).filter((l) => l !== null) : [];
var init_api = __esm(() => {
  init_log();
  init_types();
  LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
  WINDOW_SPECS = [
    { kind: "five_hour", field: "five_hour", limitKinds: [] },
    {
      kind: "seven_day",
      field: "seven_day",
      startedAtPath: ["seven_day_breakdown", "window_started_at"],
      limitKinds: ["weekly_all"]
    }
  ];
  LEGACY_SCOPED_FIELDS = [
    { field: "seven_day_opus", model: "Opus" },
    { field: "seven_day_sonnet", model: "Sonnet" }
  ];
});

// src/source/cache.ts
import { statSync as statSync3 } from "node:fs";
function newerVersionAlive() {
  try {
    const age = Date.now() - statSync3(cachePath()).mtimeMs;
    return age > -MTIME_SKEW_MS && age < NEWER_VERSION_HORIZON_MS;
  } catch {
    return false;
  }
}
function readCache() {
  const raw = readJson(cachePath());
  if (!isObj(raw) || typeof raw.v !== "number" || raw.v < CACHE_VERSION) {
    if (raw !== null)
      log("cache", () => "ignored unrecognised cache file");
    return { ...EMPTY_CACHE };
  }
  if (raw.v > CACHE_VERSION) {
    if (!newerVersionAlive()) {
      log("cache", () => `taking over a v${raw.v} cache file not written for ${NEWER_VERSION_HORIZON_MS / 3600000} h`);
      return { ...EMPTY_CACHE };
    }
    log("cache", () => `cache file is v${raw.v} (this is v${CACHE_VERSION}); read-only`);
    return {
      ...EMPTY_CACHE,
      v: raw.v,
      fetchedAt: finiteNumber(raw.fetchedAt) ?? 0,
      backoffUntil: finiteNumber(raw.backoffUntil) ?? 0,
      backoffReason: isBackoffReason(raw.backoffReason) ? raw.backoffReason : "error",
      lastError: "cache owned by a newer smart-usage",
      readOnly: true
    };
  }
  const snapshot = validSnapshot(raw.snapshot) ? raw.snapshot : null;
  return {
    v: CACHE_VERSION,
    fetchedAt: finiteNumber(raw.fetchedAt) ?? snapshot?.fetchedAt ?? 0,
    snapshot,
    profile: validProfile(raw.profile) ? raw.profile : null,
    profileRetryAt: finiteNumber(raw.profileRetryAt) ?? 0,
    credentialsTier: str(raw.credentialsTier),
    backoffUntil: finiteNumber(raw.backoffUntil) ?? 0,
    backoffReason: isBackoffReason(raw.backoffReason) ? raw.backoffReason : null,
    backoffStamp: str(raw.backoffStamp),
    failures: finiteNumber(raw.failures) ?? 0,
    lastError: str(raw.lastError)
  };
}
function writeCache(cache) {
  const { readOnly, ...file } = cache;
  if (readOnly || file.v !== CACHE_VERSION) {
    log("cache", () => "not writing: the cache file belongs to a newer version");
    return false;
  }
  return writeJsonAtomic(cachePath(), file);
}
var CACHE_VERSION = 1, BACKOFF_REASONS, isBackoffReason = (v) => BACKOFF_REASONS.includes(v), EMPTY_CACHE, cachePath = () => dataFile("usage-cache.json"), fetchLockPath = () => dataFile("fetch.lock"), str = (v) => typeof v === "string" ? v : null, validSnapshot = (s) => isObj(s) && typeof s.fetchedAt === "number" && isObj(s.windows) && Array.isArray(s.scoped), validProfile = (p) => isObj(p) && typeof p.fetchedAt === "number", NEWER_VERSION_HORIZON_MS, MTIME_SKEW_MS = 60000;
var init_cache = __esm(() => {
  init_fs_util();
  init_log();
  init_paths();
  BACKOFF_REASONS = ["rate_limit", "auth", "error", "no_credentials"];
  EMPTY_CACHE = {
    v: CACHE_VERSION,
    fetchedAt: 0,
    snapshot: null,
    profile: null,
    profileRetryAt: 0,
    credentialsTier: null,
    backoffUntil: 0,
    backoffReason: null,
    backoffStamp: null,
    failures: 0,
    lastError: null
  };
  NEWER_VERSION_HORIZON_MS = 24 * 3600000;
});

// src/source/credentials.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync as readFileSync3, statSync as statSync4 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";
function parseOauthDoc(text, store) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return "unknown";
  }
  const oauth = asObj(asObj(doc)?.claudeAiOauth);
  const token = nonEmptyString(oauth?.accessToken);
  if (!oauth || !token)
    return "none";
  const expiresAt = finiteNumber(oauth.expiresAt);
  return { token, expiresAt, rateLimitTier: nonEmptyString(oauth.rateLimitTier), store };
}
function keychainServices(env) {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (!dir)
    return [KEYCHAIN_SERVICE];
  const suffix = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return [`${KEYCHAIN_SERVICE}-${suffix}`, KEYCHAIN_SERVICE];
}
function readCredentials(overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  let definitive = true;
  for (const read of READERS) {
    const result = read(deps);
    if (result === "unknown")
      definitive = false;
    else if (result !== "none") {
      log("fetch", () => `credentials from ${result.store}`);
      return { creds: result, definitive: true };
    }
  }
  log("fetch", () => definitive ? "no OAuth credentials found" : "no OAuth credentials readable (a store could not be read)");
  return { creds: null, definitive };
}
function credentialsStamp(opts, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const parts = [`file:${deps.mtime(credentialsFilePath(deps.configDir)) ?? "-"}`];
  if (deps.platform === "darwin")
    parts.push(`keychain:${deps.mtime(keychainDbPath(deps.home)) ?? "-"}`);
  if (opts.includeEnv)
    parts.push(`env:${deps.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ? 1 : 0}`);
  return parts.join(" ");
}
var KEYCHAIN_SERVICE = "Claude Code-credentials", KEYCHAIN_TIMEOUT_MS = 2000, KEYCHAIN_NOT_FOUND = 44, defaultDeps = () => ({
  platform: process.platform,
  env: process.env,
  configDir: claudeConfigDir(),
  home: homedir2(),
  readFile: (path) => readFileSync3(path, "utf8"),
  keychain: (args) => execFileSync("security", args, {
    timeout: KEYCHAIN_TIMEOUT_MS,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }),
  mtime: (path) => {
    try {
      return statSync4(path).mtimeMs;
    } catch {
      return null;
    }
  }
}), credentialsFilePath = (configDir = claudeConfigDir()) => join3(configDir, ".credentials.json"), keychainDbPath = (home) => join3(home, "Library", "Keychains", "login.keychain-db"), fromFile = (deps) => {
  try {
    return parseOauthDoc(deps.readFile(credentialsFilePath(deps.configDir)), "file");
  } catch (e) {
    return e?.code === "ENOENT" ? "none" : "unknown";
  }
}, fromKeychain = (deps) => {
  if (deps.platform !== "darwin")
    return "none";
  for (const service of keychainServices(deps.env)) {
    let out;
    try {
      out = deps.keychain(["find-generic-password", "-s", service, "-w"]);
    } catch (e) {
      if (e?.status === KEYCHAIN_NOT_FOUND)
        continue;
      return "unknown";
    }
    const result = parseOauthDoc(out.trim(), "keychain");
    if (result !== "none")
      return result;
  }
  return "none";
}, fromEnv = (deps) => {
  const token = nonEmptyString(deps.env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
  return token ? { token, expiresAt: null, rateLimitTier: null, store: "env" } : "none";
}, READERS, isExpired = (creds, nowMs) => creds.expiresAt !== null && creds.expiresAt <= nowMs;
var init_credentials = __esm(() => {
  init_log();
  init_paths();
  READERS = [fromFile, fromKeychain, fromEnv];
});

// src/source/plan.ts
function detectPlan(inputs) {
  const displayName = inputs.profile?.displayName ?? null;
  for (const m of MATCHERS) {
    const id = m.match(inputs);
    if (!id)
      continue;
    const label = m.source === "config" ? PLAN_LABELS[id] : displayName ?? PLAN_LABELS[id];
    log("plan", () => `detected ${id} from ${m.source} (${m.origin})`);
    return { id, label, source: m.source };
  }
  log("plan", () => "no plan detected; unknown");
  return { id: "unknown", label: displayName ?? PLAN_LABELS.unknown, source: "none" };
}
var PLAN_LABELS, DISPLAY_NAME_ROWS, TIER_ROWS, ORGANIZATION_TYPE_ROWS, matchRows = (rows, value) => value ? rows.find((r) => r.all.every((re) => re.test(value)))?.plan ?? null : null, MATCHERS;
var init_plan = __esm(() => {
  init_log();
  PLAN_LABELS = {
    pro: "Pro",
    max5: "Max 5x",
    max20: "Max 20x",
    ultra: "Ultra",
    team: "Team",
    enterprise: "Enterprise",
    unknown: "Unknown"
  };
  DISPLAY_NAME_ROWS = [
    { all: [/ultra/i], plan: "ultra" },
    { all: [/\bmax\b/i, /\b20x?\b/i], plan: "max20" },
    { all: [/\bmax\b/i], plan: "max5" },
    { all: [/\bpro\b/i], plan: "pro" },
    { all: [/team/i], plan: "team" },
    { all: [/enterprise/i], plan: "enterprise" }
  ];
  TIER_ROWS = [
    { all: [/^default_claude_max_20x$/i], plan: "ultra" },
    { all: [/^default_claude_max_5x$/i], plan: "max5" },
    { all: [/pro/i], plan: "pro" }
  ];
  ORGANIZATION_TYPE_ROWS = [
    { all: [/^claude_pro$/i], plan: "pro" },
    { all: [/^claude_team$/i], plan: "team" },
    { all: [/^claude_enterprise$/i], plan: "enterprise" }
  ];
  MATCHERS = [
    { source: "config", origin: "config.plan", match: (i) => i.configPlan === "auto" ? null : i.configPlan },
    { source: "display_name", origin: "profile", match: (i) => matchRows(DISPLAY_NAME_ROWS, i.profile?.displayName) },
    { source: "rate_limit_tier", origin: "profile", match: (i) => matchRows(TIER_ROWS, i.profile?.rateLimitTier) },
    {
      source: "organization_type",
      origin: "profile",
      match: (i) => matchRows(ORGANIZATION_TYPE_ROWS, i.profile?.organizationType)
    },
    { source: "rate_limit_tier", origin: "credentials", match: (i) => matchRows(TIER_ROWS, i.credentialsTier) }
  ];
});

// src/source/index.ts
var exports_source = {};
__export(exports_source, {
  getReadingWith: () => getReadingWith,
  getReading: () => getReading
});
async function getReading(opts = {}) {
  try {
    return await getReadingWith(opts, defaultDeps2());
  } catch (e) {
    log("cache", () => `getReading failed: ${e?.message ?? String(e)}`);
    try {
      return present(readCache(), "error", "internal error", loadConfig(), Date.now() / 1000);
    } catch {
      return { snapshot: null, status: "error", ageSeconds: null, detail: "internal error" };
    }
  }
}
function present(cache, status, detail, c, nowS) {
  const snap = status === "no_credentials" ? null : cache.snapshot;
  const base = detail ? { detail } : {};
  if (!snap)
    return { snapshot: null, status, ageSeconds: null, ...base };
  const plan = detectPlan({ configPlan: c.plan, profile: cache.profile, credentialsTier: cache.credentialsTier });
  return { snapshot: { ...snap, plan }, status, ageSeconds: Math.floor(Math.max(0, nowS - snap.fetchedAt)), ...base };
}
function activeBackoff(cache, nowS, force, d) {
  const c = d.config;
  const reason = cache.backoffReason ?? "error";
  const longest = Math.max(BACKOFF_MAX_S, c.refreshSeconds) + CLOCK_SKEW_S;
  if (cache.backoffUntil <= nowS || cache.backoffUntil - nowS > longest)
    return null;
  if (force && FORCE_SKIPS.has(reason))
    return null;
  const stamp = stampFor(reason, d);
  if (stamp !== null && cache.backoffStamp !== stamp) {
    log("cache", () => `backoff (${reason}) ended: credentials changed`);
    return null;
  }
  const left = Math.ceil(cache.backoffUntil - nowS);
  log("cache", () => `backoff active (${reason}), ${left} s left`);
  return present(cache, BACKOFF_STATUS[reason], `${cache.lastError ?? reason}; retry in ${left} s`, c, nowS);
}
async function getReadingWith(opts, d) {
  const c = d.config;
  const force = opts.force === true;
  const nowS = d.nowMs() / 1000;
  const cache = readCache();
  const age = ageOf(cache, nowS);
  if (!force && isFresh(cache, nowS, c)) {
    log("cache", () => `hit, age ${Math.floor(age ?? 0)} s`);
    return present(cache, "cached", undefined, c, nowS);
  }
  log("cache", () => age === null ? "miss: no snapshot" : `expired, age ${Math.floor(age)} s`);
  const backoff = activeBackoff(cache, nowS, force, d);
  if (backoff)
    return backoff;
  if (cache.readOnly)
    return present(cache, ageStatus(cache, nowS, c), NEWER_VERSION, c, nowS);
  if (opts.allowFetch === false)
    return present(cache, ageStatus(cache, nowS, c), "fetch not allowed", c, nowS);
  const lookup = d.readCredentials();
  if (!lookup.creds) {
    if (!lookup.definitive)
      return present(cache, "error", "credentials unreadable", c, nowS);
    recordNoCredentials(d, nowS);
    return { snapshot: null, status: "no_credentials", ageSeconds: null, detail: "no OAuth login" };
  }
  const creds = lookup.creds;
  if (isExpired(creds, d.nowMs())) {
    log("fetch", () => "token expired; not fetching");
    return present(cache, "auth", "token expired", c, nowS);
  }
  const release = tryLock(fetchLockPath(), { staleMs: lockStaleMs(c) });
  if (!release)
    return waitForHolder(cache, d);
  try {
    const current = readCache();
    if (!force && isFresh(current, nowS, c)) {
      log("cache", () => "hit after lock: another session just fetched");
      return present(current, "cached", undefined, c, nowS);
    }
    const held = activeBackoff(current, nowS, force, d);
    if (held)
      return held;
    if (current.readOnly)
      return present(current, ageStatus(current, nowS, c), NEWER_VERSION, c, nowS);
    return await fetchAndStore(current, creds, d);
  } finally {
    release();
  }
}
async function waitForHolder(cache, d) {
  const c = d.config;
  if (cache.snapshot) {
    return present(cache, ageStatus(cache, d.nowMs() / 1000, c), "another session is fetching", c, d.nowMs() / 1000);
  }
  const deadline = Date.now() + c.fetchTimeoutMs;
  while (Date.now() < deadline && lockHeld(fetchLockPath()) && !readCache().snapshot)
    await d.sleep(WAIT_POLL_MS);
  const after = readCache();
  const nowS = d.nowMs() / 1000;
  const backoff = activeBackoff(after, nowS, false, d);
  if (backoff)
    return backoff;
  if (after.snapshot)
    return present(after, ageStatus(after, nowS, c), undefined, c, nowS);
  return { snapshot: null, status: "error", ageSeconds: null, detail: "another session is fetching" };
}
function recordNoCredentials(d, nowS) {
  const c = d.config;
  withLock(fetchLockPath(), { staleMs: lockStaleMs(c) }, () => {
    const current = readCache();
    const written = writeCache({
      ...current,
      backoffUntil: nowS + c.refreshSeconds,
      backoffReason: "no_credentials",
      backoffStamp: stampFor("no_credentials", d),
      failures: 0,
      lastError: "no OAuth login"
    });
    if (written)
      log("cache", () => `backoff set (no_credentials) for ${c.refreshSeconds} s`);
  });
}
function profileDue(cache, parts, nowS, c) {
  if (nowS < cache.profileRetryAt)
    return false;
  if (!cache.profile)
    return true;
  if (nowS - cache.profile.fetchedAt >= c.profileRefreshSeconds)
    return true;
  return windowSet(cache.snapshot?.windows) !== windowSet(parts.windows);
}
async function fetchAndStore(cache, creds, d) {
  const c = d.config;
  const started = Date.now();
  const fetchOpts = { base: d.apiBase, token: creds.token, timeoutMs: c.fetchTimeoutMs, fetchImpl: d.fetchImpl };
  const res = await fetchJson(USAGE_PATH, fetchOpts);
  const nowS = d.nowMs() / 1000;
  const parts = res.kind === "ok" ? parseUsage(res.body) : null;
  if (!parts)
    return recordFailure(cache, res.kind === "ok" ? { kind: "bad_body" } : res, d, nowS);
  let { profile, profileRetryAt } = cache;
  if (profileDue(cache, parts, nowS, c)) {
    const budget = c.fetchTimeoutMs - (Date.now() - started);
    if (budget < PROFILE_MIN_BUDGET_MS) {
      log("plan", () => `profile fetch deferred: ${budget} ms of the fetch budget left`);
    } else {
      const p = await fetchJson(PROFILE_PATH, { ...fetchOpts, timeoutMs: budget });
      const parsed = p.kind === "ok" ? parseProfile(p.body, Math.floor(d.nowMs() / 1000)) : null;
      if (parsed) {
        profile = parsed;
        profileRetryAt = 0;
      } else {
        profileRetryAt = Math.floor(nowS) + PROFILE_RETRY_S;
        log("plan", () => `profile fetch failed (${p.kind}); keeping the previous plan, retry in ${PROFILE_RETRY_S} s`);
      }
    }
  }
  const fetchedAt = Math.floor(nowS);
  const next = {
    ...cache,
    fetchedAt,
    snapshot: { fetchedAt, ...parts, plan: { id: "unknown", label: "Unknown", source: "none" } },
    profile,
    profileRetryAt,
    credentialsTier: creds.rateLimitTier,
    backoffUntil: 0,
    backoffReason: null,
    backoffStamp: null,
    failures: 0,
    lastError: null
  };
  writeCache(next);
  return present(next, "fresh", undefined, c, nowS);
}
function classify(res, d) {
  if (res.kind === "http" && res.status === 429) {
    const stated = parseRetryAfter(res.retryAfter, d.nowMs());
    const baseS = stated && stated > 0 ? stated : BACKOFF_BASE_S;
    return { reason: "rate_limit", status: "backoff", baseS, doubles: true, detail: "429 rate limited" };
  }
  if (res.kind === "http" && (res.status === 401 || res.status === 403)) {
    const detail2 = `${res.status} token rejected`;
    return { reason: "auth", status: "auth", baseS: d.config.refreshSeconds, doubles: false, detail: detail2 };
  }
  const detail = res.kind === "http" ? `HTTP ${res.status}` : res.kind === "network" ? `network: ${res.detail}` : res.kind === "timeout" ? "timeout" : "unrecognised response";
  return { reason: "error", status: "error", baseS: BACKOFF_BASE_S, doubles: true, detail };
}
function recordFailure(cache, res, d, nowS) {
  const f = classify(res, d);
  const streak = cache.backoffReason === f.reason ? cache.failures : 0;
  const delayS = f.doubles ? doubled(f.baseS, streak) : f.baseS;
  const next = {
    ...cache,
    backoffUntil: nowS + delayS,
    backoffReason: f.reason,
    backoffStamp: stampFor(f.reason, d),
    failures: streak + 1,
    lastError: f.detail
  };
  writeCache(next);
  log("cache", () => `backoff set (${f.reason}: ${f.detail}) for ${delayS} s, streak ${next.failures}`);
  return present(next, f.status, `${f.detail}; retry in ${Math.ceil(delayS)} s`, d.config, nowS);
}
var BACKOFF_BASE_S = 60, BACKOFF_MAX_S = 1800, WAIT_POLL_MS = 50, PROFILE_RETRY_S = 3600, PROFILE_MIN_BUDGET_MS = 250, NEWER_VERSION = "cache owned by a newer smart-usage", BACKOFF_STATUS, FORCE_SKIPS, STAMPED_PAUSES, stampFor = (reason, d) => {
  const opts = STAMPED_PAUSES[reason];
  return opts ? d.credentialsStamp(opts) : null;
}, defaultDeps2 = () => ({
  nowMs: Date.now,
  fetchImpl: (input, init) => fetch(input, init),
  config: loadConfig(),
  readCredentials: () => readCredentials(),
  credentialsStamp: (opts) => credentialsStamp(opts),
  apiBase: apiBase(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}), lockStaleMs = (c) => c.fetchTimeoutMs * 2 + 2000, ageOf = (cache, nowS) => cache.snapshot ? Math.max(0, nowS - cache.snapshot.fetchedAt) : null, ageStatus = (cache, nowS, c) => (ageOf(cache, nowS) ?? Infinity) > c.staleSeconds ? "stale" : "cached", CLOCK_SKEW_S = 60, isFresh = (cache, nowS, c) => {
  if (cache.fetchedAt <= 0)
    return false;
  const age = nowS - cache.fetchedAt;
  return age > -CLOCK_SKEW_S && age < c.refreshSeconds;
}, windowSet = (windows) => Object.keys(windows ?? {}).sort().join(","), doubled = (baseS, streak) => Math.min(BACKOFF_MAX_S, baseS * 2 ** Math.min(streak, 16));
var init_source = __esm(() => {
  init_config();
  init_fs_util();
  init_log();
  init_api();
  init_cache();
  init_credentials();
  init_plan();
  BACKOFF_STATUS = {
    rate_limit: "backoff",
    error: "backoff",
    auth: "auth",
    no_credentials: "no_credentials"
  };
  FORCE_SKIPS = new Set(["auth", "error", "no_credentials"]);
  STAMPED_PAUSES = {
    auth: { includeEnv: false },
    no_credentials: { includeEnv: true }
  };
});

// src/assessment.ts
init_config();

// src/override.ts
init_fs_util();
init_paths();
import { unlinkSync as unlinkSync2 } from "node:fs";
var overridePath = () => dataFile("override.json");
function readOverride() {
  const o = readJson(overridePath());
  if (!o || typeof o.cap !== "number" || typeof o.until !== "number")
    return null;
  return { cap: o.cap, until: o.until, ...typeof o.reason === "string" && o.reason ? { reason: o.reason } : {} };
}
var writeOverride = (o) => writeJsonAtomic(overridePath(), o);
function clearOverride() {
  try {
    unlinkSync2(overridePath());
    return true;
  } catch {
    return false;
  }
}

// src/policy.ts
init_log();
init_types();
var TIER_EPSILON = 0.000000001;
var levelCapFor = (rows, headroom) => rows.find((r) => headroom <= r.atMost + TIER_EPSILON)?.cap ?? null;
var paceCapFor = (rows, projected) => rows.find((r) => projected >= r.projected)?.cap ?? null;
var clampCap = (cap, normalCap) => Math.max(0, Math.min(normalCap, Math.floor(cap)));
var lowest = (...caps) => caps.reduce((min, c) => c === null ? min : min === null ? c : Math.min(min, c), null);
function multiplierFor(config, plan, kind) {
  return config.multipliers[plan?.id ?? "unknown"]?.[kind] ?? 1;
}
var levelCapAtZero = (config, plan, kind) => levelCapFor(config.tiers[kind] ?? [], 100 * multiplierFor(config, plan, kind));
function assessWindow(w, config, plan, stale, now) {
  const multiplier = multiplierFor(config, plan, w.kind);
  const normal = config.normalCap;
  const base = { kind: w.kind, resetsAt: w.resetsAt, multiplier };
  const atZero = levelCapAtZero(config, plan, w.kind);
  const none = { elapsed: null, projected: null, levelCap: atZero, paceCap: null, cap: clampCap(atZero ?? normal, normal) };
  if (w.resetsAt !== null && w.resetsAt <= now) {
    return { ...base, ...none, basis: "rolled_over", usedPct: 0, headroom: 100 * multiplier };
  }
  if (stale && w.resetsAt === null) {
    return { ...base, ...none, basis: "no_reading", usedPct: null, headroom: null };
  }
  const usedPct = Math.max(0, w.usedPct);
  const headroom = (100 - usedPct) * multiplier;
  const levelCap = levelCapFor(config.tiers[w.kind] ?? [], headroom);
  const len = WINDOW_SECONDS[w.kind];
  const startedAt = w.startedAt ?? (w.resetsAt !== null ? w.resetsAt - len : null);
  const elapsed = startedAt === null ? null : Math.min(1, Math.max(0, (now - startedAt) / len));
  const paceCounts = config.pace.enabled && elapsed !== null && elapsed > 0 && elapsed >= (config.pace.minElapsed[w.kind] ?? 1) && usedPct >= (config.pace.minUsedPct[w.kind] ?? 100);
  const projected = paceCounts ? usedPct / elapsed : null;
  const paceCap = projected === null ? null : paceCapFor(config.pace.rows[w.kind] ?? [], projected);
  return {
    ...base,
    basis: stale ? "floor" : "fresh",
    usedPct,
    headroom,
    elapsed,
    projected,
    levelCap,
    paceCap,
    cap: clampCap(lowest(levelCap, paceCap) ?? normal, normal)
  };
}
function baselineCap(config, plan, kinds) {
  let baseline = config.normalCap;
  for (const kind of kinds) {
    const atZero = levelCapAtZero(config, plan, kind);
    if (atZero !== null)
      baseline = Math.min(baseline, clampCap(atZero, config.normalCap));
  }
  return baseline;
}
function liveOverride(o, normalCap, now) {
  if (!o || !Number.isFinite(o.cap) || !Number.isFinite(o.until) || o.until <= now)
    return null;
  return { ...o, cap: clampCap(o.cap, normalCap) };
}
function scopedFor(reading, config, now) {
  const s = config.modelSteering;
  if (!s.enabled)
    return [];
  const out = [];
  for (const l of reading?.snapshot?.scoped ?? []) {
    if (l.resetsAt !== null && l.resetsAt <= now)
      continue;
    if (l.usedPct < s.scopedWarnPct)
      continue;
    out.push({
      model: l.model,
      usedPct: l.usedPct,
      resetsAt: l.resetsAt,
      level: l.usedPct >= s.scopedAvoidPct ? "avoid" : "warn"
    });
  }
  return out;
}
function assess(reading, config, now, override = null) {
  const normalCap = config.normalCap;
  const snap = reading?.snapshot ?? null;
  const ageSeconds = snap ? Math.max(0, now - snap.fetchedAt) : null;
  const stale = ageSeconds !== null && ageSeconds > config.staleSeconds;
  const plan = snap?.plan ?? null;
  const windows = [];
  for (const kind of WINDOW_KINDS) {
    const w = snap?.windows[kind];
    if (w)
      windows.push(assessWindow(w, config, plan, stale, now));
  }
  let binding = null;
  for (const w of windows) {
    if (!binding || w.cap < binding.cap || w.cap === binding.cap && (w.headroom ?? Infinity) < (binding.headroom ?? Infinity)) {
      binding = w;
    }
  }
  const computedCap = clampCap(binding?.cap ?? normalCap, normalCap);
  const live = liveOverride(override, normalCap, now);
  const cap = live ? live.cap : computedCap;
  const paceWarnings = windows.filter((w) => w.projected !== null && w.projected >= config.warnProjectedPct).map((w) => w.kind);
  const scoped = scopedFor(reading, config, now);
  const baseline = baselineCap(config, plan, windows.map((w) => w.kind));
  const capped = isBelowBaseline({ cap, baseline });
  const steerSmaller = config.modelSteering.enabled && (capped || paceWarnings.length > 0);
  const pressure = capped || paceWarnings.length > 0 || scoped.length > 0;
  const a = {
    now,
    plan,
    status: reading?.status ?? "error",
    ageSeconds,
    normalCap,
    baseline,
    windows,
    computedCap,
    cap,
    binding: binding?.kind ?? null,
    override: live,
    paceWarnings,
    scoped,
    steerSmaller,
    pressure
  };
  log("policy", () => describeAssessment(a));
  return a;
}
var isBelowBaseline = (a) => a.cap < a.baseline;
var hasReducedBaseline = (a) => a.baseline < a.normalCap;
var hasWindows = (a) => a.windows.length > 0;
var round1 = (n) => n === null ? null : Math.round(n * 10) / 10;
function describeAssessment(a) {
  const r1 = (n) => String(round1(n) ?? "-");
  const wins = a.windows.map((w) => `${w.kind}[${w.basis} used=${r1(w.usedPct)} x${w.multiplier} head=${r1(w.headroom)} ` + `el=${r1(w.elapsed)} proj=${r1(w.projected)} level=${w.levelCap ?? "-"} pace=${w.paceCap ?? "-"} cap=${w.cap}]`).join(" ");
  return `plan=${a.plan?.id ?? "none"}(${a.plan?.source ?? "-"}) status=${a.status} age=${a.ageSeconds === null ? "-" : Math.round(a.ageSeconds)}s ` + `${wins || "no windows"} computed=${a.computedCap} cap=${a.cap}/${a.normalCap} baseline=${a.baseline} binding=${a.binding ?? "-"}` + `${a.override ? ` override=${a.override.cap} until ${a.override.until}` : ""}` + ` pace=[${a.paceWarnings.join(",")}] scoped=[${a.scoped.map((s) => `${s.model}:${s.level}`).join(",")}]` + ` steer=${a.steerSmaller} pressure=${a.pressure}`;
}
var norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function avoidedModel(a, model) {
  if (typeof model !== "string" || !model.trim())
    return null;
  const m = norm(model);
  return a.scoped.find((s) => {
    if (s.level !== "avoid")
      return false;
    const name = norm(s.model);
    return name.length > 0 && (m.includes(name) || name.split(" ").includes(m));
  }) ?? null;
}

// src/reading.ts
import { readFileSync as readFileSync4 } from "node:fs";
async function currentReading(opts = {}) {
  const fixture = process.env.SMART_USAGE_READING_FILE;
  if (fixture)
    return JSON.parse(readFileSync4(fixture, "utf8"));
  const { getReading: getReading2 } = await Promise.resolve().then(() => (init_source(), exports_source));
  return getReading2(opts);
}

// src/assessment.ts
var nowSeconds = () => Date.now() / 1000;
async function currentState(opts = {}) {
  const config = loadConfig();
  const reading = await currentReading(opts);
  return { config, reading, assessment: assess(reading, config, nowSeconds(), readOverride()) };
}

// src/hooks/session-start.ts
init_log();

// src/trace.ts
init_fs_util();
init_log();
init_paths();
import { readFileSync as readFileSync5 } from "node:fs";
var TRACE_FILE = "trace.json";
var TRACE_TTL_MS = 7 * 24 * 3600 * 1000;
var LOCK = { staleMs: 5000, waitMs: 500 };
function conversationKey(input) {
  const session = nonEmptyString(input.session_id) ?? "shared";
  const agent = nonEmptyString(input.agent_id);
  return agent ? `${session}/${agent}` : session;
}
var FIELD_TYPES = {
  at: "string",
  cap: "number",
  baseline: "number",
  fired: "boolean",
  statedAt: "number",
  verdict: "string",
  gate: "string"
};
function sanitize(entry) {
  const out = {};
  if (!isObj(entry))
    return out;
  for (const [k, type] of Object.entries(FIELD_TYPES)) {
    const v = entry[k];
    if (typeof v === type && (type !== "number" || Number.isFinite(v)))
      out[k] = v;
  }
  return out;
}
function readTrace(key) {
  const all = readJson(dataFile(TRACE_FILE));
  return sanitize(isObj(all) ? all[key] : undefined);
}
function loadForWrite(path) {
  let text;
  try {
    text = readFileSync5(path, "utf8");
  } catch (e) {
    return e?.code === "ENOENT" ? { ok: true, all: {} } : { ok: false };
  }
  try {
    const parsed = JSON.parse(text);
    if (isObj(parsed))
      return { ok: true, all: parsed };
  } catch {}
  try {
    renameWithRetry(path, `${path}.bad`);
    log("trace", () => "set aside an unparsable trace.json");
    return { ok: true, all: {} };
  } catch {
    return { ok: false };
  }
}
function updateTrace(key, update, nowMs = Date.now()) {
  const path = dataFile(TRACE_FILE);
  try {
    const result = withLock(`${path}.lock`, LOCK, () => {
      const loaded = loadForWrite(path);
      if (!loaded.ok)
        return false;
      const all = loaded.all;
      const cutoff = nowMs - TRACE_TTL_MS;
      for (const [k, e] of Object.entries(all)) {
        if (!(isObj(e) && Date.parse(e.at ?? "") > cutoff))
          delete all[k];
      }
      const prev = sanitize(all[key]);
      const patch = typeof update === "function" ? update(prev) : update;
      const next = { ...prev, ...patch, at: new Date(nowMs).toISOString() };
      for (const k of Object.keys(next))
        if (next[k] === undefined)
          delete next[k];
      all[key] = next;
      return writeJsonAtomic(path, all);
    });
    if (!result.acquired || !result.value)
      log("trace", () => `skipped write for ${key}`);
  } catch (e) {
    log("trace", () => `write for ${key} failed: ${String(e)}`);
  }
}

// src/wording.ts
var WINDOW_LABEL = {
  five_hour: "5-hour",
  seven_day: "weekly"
};
var stamp = (epochSeconds2) => new Date(epochSeconds2 * 1000).toISOString().replace(/:\d\d\.\d+Z$/, "Z");
function formatDuration(seconds) {
  const minutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  if (hours >= 48)
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
var pct = (value) => `${Math.floor(value)}%`;
var resetIn = (resetsAt, now) => resetsAt !== null && resetsAt > now ? `resets in ${formatDuration(resetsAt - now)}` : null;
function windowPart(w, a) {
  const label = `${WINDOW_LABEL[w.kind]} window`;
  if (w.basis === "rolled_over")
    return `${label} has reset`;
  if (w.basis === "no_reading" || w.usedPct === null)
    return `${label}: no current reading`;
  const used = w.basis === "floor" ? `at least ${pct(w.usedPct)} used as of ${Math.round((a.ageSeconds ?? 0) / 60)} min ago` : `${pct(w.usedPct)} used`;
  const extras = [
    resetIn(w.resetsAt, a.now),
    w.projected !== null ? `on pace for ${Math.round(w.projected)}% by reset` : null
  ].filter(Boolean);
  return [`${label} ${used}`, ...extras].join(", ");
}
function usageHead(a) {
  const plan = a.plan ? `${a.plan.label} plan` : "plan unknown";
  const parts = a.windows.map((w) => windowPart(w, a));
  const body = parts.length > 0 ? parts.join("; ") : "no usage reading";
  const floors = a.windows.some((w) => w.basis === "floor") ? ' Figures marked "at least" are from an older reading; within a window usage only rises.' : "";
  return `smart-usage, ${stamp(a.now)}: ${plan}; ${body}.${floors}`;
}
var CAP_LIMITS = "The cap limits new launches only; cutting verification or scope on budget grounds needs the user's approval.";
var CAP_RULE = {
  0: () => "no new subagents or workflows; finish and checkpoint current work, then continue inline",
  1: () => "at most 1 subagent in flight, a Workflow's agents included; run parallel stages one after another"
};
var defaultCapRule = (cap) => `at most ${cap} subagents in flight, a Workflow's agents included`;
function capSource(a) {
  if (a.override) {
    const reason = a.override.reason ? `: ${a.override.reason}` : "";
    return ` (set by the user's override until ${stamp(a.override.until)}${reason})`;
  }
  return a.binding && isBelowBaseline(a) ? ` (from the ${WINDOW_LABEL[a.binding]} window)` : "";
}
var planName = (a) => a.plan ? `the ${a.plan.label} plan` : "this plan";
function capText(a, config, prevCap) {
  const note = config.capNotes[String(a.cap)] ? ` ${config.capNotes[String(a.cap)]}` : "";
  const fromZero = prevCap === 0 && a.cap > 0 && config.liftedFromZeroNote ? ` ${config.liftedFromZeroNote}` : "";
  const lifted = prevCap !== undefined && prevCap < a.cap && !isBelowBaseline(a);
  const rule = (CAP_RULE[a.cap] ?? defaultCapRule)(a.cap);
  const planNormal = hasReducedBaseline(a) && a.cap !== a.baseline ? ` Up to ${a.baseline} in flight is normal for ${planName(a)}.` : "";
  if (isBelowBaseline(a)) {
    return `Subagent cap ${a.cap}${capSource(a)}: ${rule}.${fromZero} ${CAP_LIMITS}${planNormal}${note}`;
  }
  if (a.cap < a.normalCap) {
    const why = a.override ? capSource(a) : ` (normal for ${planName(a)})`;
    const earlier = lifted ? ` Any lower cap stated earlier no longer applies.${fromZero}` : "";
    return `Subagent cap ${lifted ? "back to " : ""}${a.cap}${why}: ${rule}.${earlier} ${CAP_LIMITS}${planNormal}${note}`;
  }
  if (lifted) {
    return `Subagent cap lifted${capSource(a)}: back to normal, up to ${a.normalCap} in flight; ` + `any lower cap stated earlier no longer applies.${fromZero}${planNormal}`;
  }
  return `Subagent cap: normal${capSource(a)}, up to ${a.normalCap} in flight.${planNormal}`;
}
function scopedText(s, now) {
  const reset = resetIn(s.resetsAt, now);
  const head = `${s.model} weekly limit ${pct(s.usedPct)} used${reset ? ` (${reset})` : ""}`;
  return s.level === "avoid" ? `${head}: do not choose ${s.model} for new subagents.` : `${head}.`;
}
function modelAdvice(a) {
  return [
    a.steerSmaller ? "Prefer smaller models for subagents where the task allows." : "",
    ...a.scoped.map((s) => scopedText(s, a.now))
  ].filter(Boolean);
}
var SUPERSEDE = "This supersedes every earlier smart-usage line in this conversation.";
function usageLine(a, config, opts = {}) {
  const pace = a.paceWarnings.length > 0 ? `At the current rate the ${a.paceWarnings.map((k) => WINDOW_LABEL[k]).join(" and ")} ` + `${a.paceWarnings.length > 1 ? "windows run" : "window runs"} out before reset.` : "";
  return [
    usageHead(a),
    a.pressure ? "" : hasReducedBaseline(a) ? "Nothing is constrained beyond the plan's normal." : "Nothing is constrained.",
    capText(a, config, opts.prevCap),
    pace,
    ...modelAdvice(a),
    opts.extra ?? "",
    SUPERSEDE
  ].filter(Boolean).join(" ");
}
var avoidedModelNote = (s) => `This launch asked for ${s.model}, whose weekly limit is ${pct(s.usedPct)} used; ` + "choose another model for further subagents unless the user asked for this one.";

// src/hooks/common.ts
init_log();
var HOOK_STARTED_MS = Date.now() - process.uptime() * 1000;
var STDIN_TIMEOUT_MS = 1000;
async function readHookInput() {
  const chunks = [];
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      process.stdin.destroy();
      resolve();
    }, STDIN_TIMEOUT_MS);
  });
  const read = (async () => {
    for await (const chunk of process.stdin)
      chunks.push(Buffer.from(chunk));
  })();
  await Promise.race([read, timeout]);
  clearTimeout(timer);
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
var exit = () => process.exit(0);
function runHook(event, main) {
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
    if (!result)
      return exit();
    const body = JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...result.output }, suppressOutput: true });
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
  })().catch((e) => {
    log("hook", () => `${event} failed open: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    exit();
  });
}

// src/hooks/verdict.ts
var verdictSummary = (a) => `cap ${a.cap}/${a.normalCap}${hasReducedBaseline(a) ? ` base ${a.baseline}` : ""}` + `${isBelowBaseline(a) || a.override ? ` (${a.override ? "override" : a.binding ?? "-"})` : ""}, ` + `status ${a.status}` + `${a.paceWarnings.length ? `, pace ${a.paceWarnings.join("+")}` : ""}` + `${a.scoped.length ? `, scoped ${a.scoped.map((s) => `${s.model}:${s.level}`).join("+")}` : ""}`;
function recordStated(key, a, extra, startedMs = HOOK_STARTED_MS) {
  updateTrace(key, (prev) => {
    const concurrentLower = prev.statedAt !== undefined && prev.statedAt >= startedMs && prev.cap !== undefined && prev.cap < a.cap;
    return {
      ...extra,
      cap: concurrentLower ? prev.cap : a.cap,
      baseline: a.baseline,
      fired: a.pressure || concurrentLower && prev.fired === true,
      statedAt: Date.now()
    };
  });
}

// src/hooks/session-start.ts
var FORGETS_CONTEXT = new Set(["clear", "compact"]);
runHook("SessionStart", async (input) => {
  const key = conversationKey(input);
  const source = String(input.source);
  const forget = FORGETS_CONTEXT.has(input.source);
  if (forget) {
    updateTrace(key, { cap: undefined, baseline: undefined, fired: false, verdict: `forgot stated cap (${source})` });
  }
  const prev = forget ? {} : readTrace(key);
  const { config, assessment: a } = await currentState();
  const summary = verdictSummary(a);
  const worthSaying = a.pressure || hasReducedBaseline(a);
  const alreadyHeld = source === "resume" && prev.cap === a.cap && prev.baseline === a.baseline;
  const speak = hasWindows(a) && (source === "fork" || worthSaying && !alreadyHeld);
  if (!speak) {
    const why = !hasWindows(a) ? "no reading" : alreadyHeld ? "already stated" : "nothing to say";
    log("hook", () => `SessionStart ${key} (${source}): silent, ${why} -- ${summary}`);
    if (!forget)
      updateTrace(key, { verdict: `session start (${source}) silent, ${why} -- ${summary}` });
    return null;
  }
  log("hook", () => `SessionStart ${key} (${source}): briefing -- ${summary}`);
  return {
    output: { additionalContext: usageLine(a, config, { prevCap: prev.cap }) },
    record: () => recordStated(key, a, { verdict: `session start (${source}) briefing -- ${summary}` })
  };
});
