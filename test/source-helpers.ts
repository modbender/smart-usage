// Shared setup for the source-layer tests: an isolated config dir with a fake login, a fake
// fetch that counts requests, and deps for getReadingWith.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config.ts";
import { credentialsStamp, readCredentials } from "../src/source/credentials.ts";
import type { SourceDeps } from "../src/source/index.ts";

export const FIXTURES = join(import.meta.dir, "fixtures");
export const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

export const FAKE_TOKEN = "sk-ant-oat-FAKE-TEST-TOKEN";
/** 2026-11-21T10:30:00Z, a few minutes after the Ultra fixture was captured. */
export const NOW_MS = Date.parse("2026-11-21T10:30:00Z");

const ENV_KEYS = ["CLAUDE_CONFIG_DIR", "SMART_USAGE_DATA_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "SMART_USAGE_API_BASE"] as const;

export interface Sandbox {
  dir: string;
  writeCredentials: (oauth: Record<string, unknown>) => void;
  cleanup: () => void;
}

/** Points CLAUDE_CONFIG_DIR and SMART_USAGE_DATA_DIR at a fresh temp dir; never the real ~/.claude. */
export function sandbox(): Sandbox {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const dir = mkdtempSync(join(tmpdir(), "smart-usage-src-"));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.CLAUDE_CONFIG_DIR = dir;
  process.env.SMART_USAGE_DATA_DIR = join(dir, "smart-usage");
  mkdirSync(process.env.SMART_USAGE_DATA_DIR, { recursive: true });
  return {
    dir,
    writeCredentials: (oauth) =>
      writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth })),
    cleanup: () => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Valid for a week from NOW_MS, so tests that advance the clock by hours keep a live token. */
export const LOGIN_EXPIRES_AT = NOW_MS + 7 * 86400_000;

export const goodLogin = (extra: Record<string, unknown> = {}) => ({
  accessToken: FAKE_TOKEN,
  refreshToken: "FAKE-REFRESH",
  expiresAt: LOGIN_EXPIRES_AT,
  rateLimitTier: "default_claude_max_5x",
  ...extra,
});

export type Route = (path: string, headers: Headers) => Response | Promise<Response>;

export interface FakeFetch {
  impl: SourceDeps["fetchImpl"];
  calls: { path: string; headers: Headers }[];
  count: (path: string) => number;
}

export function fakeFetch(route: Route): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  return {
    calls,
    count: (path) => calls.filter((c) => c.path === path).length,
    impl: async (input, init) => {
      const url = new URL(input);
      const headers = new Headers(init.headers);
      calls.push({ path: url.pathname, headers });
      return route(url.pathname, headers);
    },
  };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Serves the Ultra fixtures. */
export const ultraRoute: Route = (path) =>
  path === "/api/oauth/usage" ? json(fixture("usage-ultra.json")) : json(fixture("profile-ultra.json"));

export interface Clock {
  ms: number;
  advance: (seconds: number) => void;
}

export const clock = (start = NOW_MS): Clock => {
  const c: Clock = { ms: start, advance: (s) => (c.ms += s * 1000) };
  return c;
};

export function deps(f: FakeFetch, clk: Clock, config: Partial<SourceDeps["config"]> = {}): SourceDeps {
  return {
    nowMs: () => clk.ms,
    fetchImpl: f.impl,
    config: {
      refreshSeconds: DEFAULTS.refreshSeconds,
      staleSeconds: DEFAULTS.staleSeconds,
      fetchTimeoutMs: 500,
      profileRefreshSeconds: DEFAULTS.profileRefreshSeconds,
      plan: "auto",
      ...config,
    },
    readCredentials: () => readCredentials({ platform: "linux" }),
    credentialsStamp: (opts) => credentialsStamp(opts, { platform: "linux" }),
    apiBase: "http://127.0.0.1:1",
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
