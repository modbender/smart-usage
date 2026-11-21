import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialsStamp, isExpired, keychainServices, readCredentials } from "../src/source/credentials.ts";
import { FAKE_TOKEN, goodLogin, LOGIN_EXPIRES_AT, NOW_MS, sandbox, type Sandbox } from "./source-helpers.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.cleanup());

const keychainDoc = JSON.stringify({ claudeAiOauth: { accessToken: "KEYCHAIN-FAKE", expiresAt: 1 } });
const notFound = () => {
  throw Object.assign(new Error("not found"), { status: 44 });
};
const timedOut = () => {
  throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT", signal: "SIGTERM", status: null });
};

describe("readCredentials", () => {
  test("reads the file in CLAUDE_CONFIG_DIR", () => {
    box.writeCredentials(goodLogin());
    expect(readCredentials({ platform: "linux" })).toEqual({
      creds: { token: FAKE_TOKEN, expiresAt: LOGIN_EXPIRES_AT, rateLimitTier: "default_claude_max_5x", store: "file" },
      definitive: true,
    });
  });

  test("no file, no keychain off macOS, no env: definitively none, no spawn", () => {
    let spawned = 0;
    const lookup = readCredentials({ platform: "win32", keychain: () => (spawned++, keychainDoc) });
    expect(lookup).toEqual({ creds: null, definitive: true });
    expect(spawned).toBe(0);
  });

  test("a file without claudeAiOauth (MCP OAuth only) is a definite none", () => {
    writeFileSync(join(box.dir, ".credentials.json"), JSON.stringify({ mcpOAuth: { x: { accessToken: "MCP-FAKE" } } }));
    expect(readCredentials({ platform: "linux" })).toEqual({ creds: null, definitive: true });
  });

  test("a torn file is not definitive", () => {
    writeFileSync(join(box.dir, ".credentials.json"), '{"claudeAiOauth":{"acc');
    expect(readCredentials({ platform: "linux" })).toEqual({ creds: null, definitive: false });
  });

  test("macOS keychain after the file, trying the config-dir entry first", () => {
    const asked: string[] = [];
    const lookup = readCredentials({
      platform: "darwin",
      keychain: (args) => {
        asked.push(args[2]!);
        return args[2] === "Claude Code-credentials" ? keychainDoc : notFound();
      },
    });
    expect(lookup.creds).toMatchObject({ token: "KEYCHAIN-FAKE", store: "keychain" });
    expect(asked).toEqual(keychainServices(process.env));
    expect(asked.length).toBe(2);
  });

  test("keychain not found under every name is a definite none", () => {
    expect(readCredentials({ platform: "darwin", keychain: notFound })).toEqual({ creds: null, definitive: true });
  });

  test("a keychain timeout is not definitive and stops after the first name", () => {
    let calls = 0;
    const lookup = readCredentials({ platform: "darwin", keychain: () => (calls++, timedOut()) });
    expect(lookup).toEqual({ creds: null, definitive: false });
    expect(calls).toBe(1);
  });

  test("keychain service name carries the config-dir hash when CLAUDE_CONFIG_DIR is set", () => {
    const dir = "/Users/x/.claude-work";
    const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
    expect(keychainServices({ CLAUDE_CONFIG_DIR: dir })).toEqual([`Claude Code-credentials-${hash}`, "Claude Code-credentials"]);
    expect(keychainServices({})).toEqual(["Claude Code-credentials"]);
  });

  test("env token last; a file with an empty token falls through", () => {
    box.writeCredentials({ accessToken: "" });
    expect(readCredentials({ platform: "linux", env: { CLAUDE_CODE_OAUTH_TOKEN: " ENV-FAKE " } })).toEqual({
      creds: { token: "ENV-FAKE", expiresAt: null, rateLimitTier: null, store: "env" },
      definitive: true,
    });
  });

  test("isExpired", () => {
    const base = { token: "t", rateLimitTier: null, store: "file" as const };
    expect(isExpired({ ...base, expiresAt: NOW_MS - 1 }, NOW_MS)).toBe(true);
    expect(isExpired({ ...base, expiresAt: NOW_MS + 1 }, NOW_MS)).toBe(false);
    expect(isExpired({ ...base, expiresAt: null }, NOW_MS)).toBe(false);
  });
});

describe("credentialsStamp", () => {
  test("changes with the file and the keychain db, never contains token material", () => {
    const mtimes = new Map<string, number>();
    const stamp = () =>
      credentialsStamp(
        { includeEnv: true },
        { platform: "darwin", home: "/h", env: { CLAUDE_CODE_OAUTH_TOKEN: "ENV-SECRET" }, mtime: (p) => mtimes.get(p) ?? null },
      );
    const a = stamp();
    mtimes.set(join(box.dir, ".credentials.json"), 1);
    const b = stamp();
    mtimes.set(join("/h", "Library", "Keychains", "login.keychain-db"), 2);
    const c = stamp();
    expect(new Set([a, b, c]).size).toBe(3);
    expect(c).not.toContain("ENV-SECRET");
  });

  test("env presence appears only when asked for", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "ENV-SECRET" };
    expect(credentialsStamp({ includeEnv: false }, { platform: "linux", env })).toBe(credentialsStamp({ includeEnv: false }, { platform: "linux", env: {} }));
    expect(credentialsStamp({ includeEnv: true }, { platform: "linux", env })).not.toBe(credentialsStamp({ includeEnv: true }, { platform: "linux", env: {} }));
  });
});
