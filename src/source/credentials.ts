// Read-only access to Claude Code's OAuth login. Never refreshes the token and never writes
// any credentials store: the refresh token rotates, and using it would sign Claude Code out.
// The token is never logged; only which store it came from.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { asObj, finiteNumber, nonEmptyString } from "../json.ts";
import { log } from "../log.ts";
import { claudeConfigDir } from "../paths.ts";

export type CredentialStore = "file" | "keychain" | "env";

export interface Credentials {
  token: string;
  /** Epoch milliseconds; null when the store does not say (the env var). */
  expiresAt: number | null;
  /** `rateLimitTier` as recorded at login; often stale, used only as a last plan hint. */
  rateLimitTier: string | null;
  store: CredentialStore;
}

/**
 * `definitive` is true only when every store answered "no OAuth entry" (as opposed to a store
 * that could not be read: a file mid-rewrite, a locked keychain, a `security` timeout).
 */
export type CredentialLookup = { creds: Credentials; definitive: true } | { creds: null; definitive: boolean };

export interface CredentialDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  configDir: string;
  home: string;
  readFile: (path: string) => string;
  /** Runs `security` with the given args and returns stdout. */
  keychain: (args: string[]) => string;
  /** File mtime in ms, or null when the file does not exist. */
  mtime: (path: string) => number | null;
}

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_TIMEOUT_MS = 2000;
/** `security find-generic-password` exit status for "item not found". */
const KEYCHAIN_NOT_FOUND = 44;

const defaultDeps = (): CredentialDeps => ({
  platform: process.platform,
  env: process.env,
  configDir: claudeConfigDir(),
  home: homedir(),
  readFile: (path) => readFileSync(path, "utf8"),
  keychain: (args) =>
    execFileSync("security", args, {
      timeout: KEYCHAIN_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  mtime: (path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  },
});

/** A store's answer: credentials, definitively none, or could not tell. */
type StoreResult = Credentials | "none" | "unknown";

/** The `{claudeAiOauth: {...}}` document both the file and the keychain entry hold. */
function parseOauthDoc(text: string, store: CredentialStore): StoreResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return "unknown";
  }
  // A parsed document without an OAuth login (e.g. only MCP OAuth entries) is a real "none".
  const oauth = asObj(asObj(doc)?.claudeAiOauth);
  const token = nonEmptyString(oauth?.accessToken);
  if (!oauth || !token) return "none";
  const expiresAt = finiteNumber(oauth.expiresAt);
  return { token, expiresAt, rateLimitTier: nonEmptyString(oauth.rateLimitTier), store };
}

/**
 * Keychain service names to try, most specific first. With CLAUDE_CONFIG_DIR set, Claude Code
 * keys its entry by the first 8 hex chars of sha256(config dir) (third-party reports; not
 * verified against Claude Code itself), so the plain name is kept as a fallback.
 */
export function keychainServices(env: NodeJS.ProcessEnv): string[] {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (!dir) return [KEYCHAIN_SERVICE];
  const suffix = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return [`${KEYCHAIN_SERVICE}-${suffix}`, KEYCHAIN_SERVICE];
}

export const credentialsFilePath = (configDir: string = claudeConfigDir()): string => join(configDir, ".credentials.json");

const keychainDbPath = (home: string): string => join(home, "Library", "Keychains", "login.keychain-db");

type Reader = (deps: CredentialDeps) => StoreResult;

const fromFile: Reader = (deps) => {
  try {
    return parseOauthDoc(deps.readFile(credentialsFilePath(deps.configDir)), "file");
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "none" : "unknown";
  }
};

const fromKeychain: Reader = (deps) => {
  if (deps.platform !== "darwin") return "none";
  for (const service of keychainServices(deps.env)) {
    let out: string;
    try {
      out = deps.keychain(["find-generic-password", "-s", service, "-w"]);
    } catch (e) {
      if ((e as { status?: unknown })?.status === KEYCHAIN_NOT_FOUND) continue;
      // Locked keychain or timeout: another name would likely cost another 2 s for nothing.
      return "unknown";
    }
    const result = parseOauthDoc(out.trim(), "keychain");
    if (result !== "none") return result;
  }
  return "none";
};

const fromEnv: Reader = (deps) => {
  const token = nonEmptyString(deps.env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
  return token ? { token, expiresAt: null, rateLimitTier: null, store: "env" } : "none";
};

/** First hit wins. */
const READERS: Reader[] = [fromFile, fromKeychain, fromEnv];

export function readCredentials(overrides: Partial<CredentialDeps> = {}): CredentialLookup {
  const deps = { ...defaultDeps(), ...overrides };
  let definitive = true;
  for (const read of READERS) {
    const result = read(deps);
    if (result === "unknown") definitive = false;
    else if (result !== "none") {
      log("fetch", () => `credentials from ${result.store}`);
      return { creds: result, definitive: true };
    }
  }
  log("fetch", () => (definitive ? "no OAuth credentials found" : "no OAuth credentials readable (a store could not be read)"));
  return { creds: null, definitive };
}

/**
 * A cheap fingerprint of the credential stores, with no token material and no process spawn:
 * the credentials file's mtime, the macOS login keychain's mtime (any keychain write, a token
 * refresh or a login included, touches it), and with `includeEnv` whether this process has the
 * env token. A change means the login may have changed, which ends an auth or no-credentials
 * pause early. The env part is per process while pauses are shared, so it belongs only in
 * stamps that sessions with and without the env token never both write (see index.ts).
 */
export function credentialsStamp(opts: { includeEnv: boolean }, overrides: Partial<CredentialDeps> = {}): string {
  const deps = { ...defaultDeps(), ...overrides };
  const parts = [`file:${deps.mtime(credentialsFilePath(deps.configDir)) ?? "-"}`];
  if (deps.platform === "darwin") parts.push(`keychain:${deps.mtime(keychainDbPath(deps.home)) ?? "-"}`);
  if (opts.includeEnv) parts.push(`env:${deps.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ? 1 : 0}`);
  return parts.join(" ");
}

/** An expired token means `auth` without a request; Claude Code refreshes it on its next call. */
export const isExpired = (creds: Credentials, nowMs: number): boolean =>
  creds.expiresAt !== null && creds.expiresAt <= nowMs;
