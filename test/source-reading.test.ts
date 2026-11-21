import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cachePath, EMPTY_CACHE, fetchLockPath, NEWER_VERSION_HORIZON_MS, readCache, writeCache } from "../src/source/cache.ts";
import { credentialsStamp, readCredentials } from "../src/source/credentials.ts";
import type { PlanInfo } from "../src/types.ts";
import { getReadingWith, type SourceDeps } from "../src/source/index.ts";
import {
  clock,
  deps,
  FAKE_TOKEN,
  fakeFetch,
  fixture,
  goodLogin,
  json,
  NOW_MS,
  sandbox,
  ultraRoute,
  type Sandbox,
} from "./source-helpers.ts";

const USAGE = "/api/oauth/usage";
const PROFILE = "/api/oauth/profile";
const PLACEHOLDER: PlanInfo = { id: "unknown", label: "Unknown", source: "none" };

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
  box.writeCredentials(goodLogin());
});
afterEach(() => box.cleanup());

describe("getReading", () => {
  test("fresh fetch: Ultra snapshot, plan from profile, headers sent, token never in the cache", async () => {
    const f = fakeFetch(ultraRoute);
    const r = await getReadingWith({}, deps(f, clock()));
    expect(r.status).toBe("fresh");
    expect(r.ageSeconds).toBe(0);
    expect(r.snapshot?.windows.seven_day?.usedPct).toBe(11);
    expect(r.snapshot?.plan).toEqual({ id: "ultra", label: "Ultra", source: "display_name" });
    expect(f.count(USAGE)).toBe(1);
    expect(f.count(PROFILE)).toBe(1);
    expect(f.calls[0]!.headers.get("authorization")).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(f.calls[0]!.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    const raw = await Bun.file(cachePath()).text();
    expect(raw).not.toContain(FAKE_TOKEN);
  });

  test("the profile is refetched once profileRefreshSeconds (24 h) has passed", async () => {
    const f = fakeFetch(ultraRoute);
    const clk = clock();
    await getReadingWith({}, deps(f, clk));
    clk.advance(86400 - 1);
    await getReadingWith({}, deps(f, clk));
    expect(f.count(USAGE)).toBe(2);
    expect(f.count(PROFILE)).toBe(1);
    clk.advance(301);
    await getReadingWith({}, deps(f, clk));
    expect(f.count(USAGE)).toBe(3);
    expect(f.count(PROFILE)).toBe(2);
  });

  test("sessions with and without the env token do not end each other's auth pause", async () => {
    const f = fakeFetch(() => json({}, 401));
    const clk = clock();
    const withEnv: SourceDeps = {
      ...deps(f, clk),
      credentialsStamp: (opts) => credentialsStamp(opts, { platform: "linux", env: { CLAUDE_CODE_OAUTH_TOKEN: "ENV-FAKE" } }),
    };
    const without = deps(f, clk);
    expect((await getReadingWith({}, withEnv)).status).toBe("auth");
    for (const d of [without, withEnv, without]) {
      clk.advance(5);
      expect((await getReadingWith({}, d)).status).toBe("auth");
    }
    expect(f.count(USAGE)).toBe(1);
  });

  test("a session with the env token is not held by a no-login session's no_credentials pause", async () => {
    unlinkSync(join(box.dir, ".credentials.json"));
    const f = fakeFetch(ultraRoute);
    const clk = clock();
    expect((await getReadingWith({}, deps(f, clk))).status).toBe("no_credentials");
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "ENV-FAKE" };
    const withEnv: SourceDeps = {
      ...deps(f, clk),
      readCredentials: () => readCredentials({ platform: "linux", env }),
      credentialsStamp: (opts) => credentialsStamp(opts, { platform: "linux", env }),
    };
    expect((await getReadingWith({}, withEnv)).status).toBe("fresh");
    expect(f.calls[0]!.headers.get("authorization")).toBe("Bearer ENV-FAKE");
  });

  test("cache inside refreshSeconds is a hit with no request; force fetches again", async () => {
    const f = fakeFetch(ultraRoute);
    const clk = clock();
    await getReadingWith({}, deps(f, clk));
    clk.advance(299);
    const hit = await getReadingWith({}, deps(f, clk));
    expect(hit.status).toBe("cached");
    expect(hit.ageSeconds).toBe(299);
    expect(f.count(USAGE)).toBe(1);
    const forced = await getReadingWith({ force: true }, deps(f, clk));
    expect(forced.status).toBe("fresh");
    expect(f.count(USAGE)).toBe(2);
    // Profile is not refetched while it is young and the window set is unchanged.
    expect(f.count(PROFILE)).toBe(1);
  });

  test("past refreshSeconds refetches; the profile follows a change in the window set", async () => {
    let withFiveHour = false;
    const f = fakeFetch((path) => {
      if (path === PROFILE) return json(fixture("profile-ultra.json"));
      const body = fixture("usage-ultra.json") as Record<string, unknown>;
      if (withFiveHour) body.five_hour = { utilization: 5, resets_at: "2026-11-21T14:00:00Z" };
      return json(body);
    });
    const clk = clock();
    await getReadingWith({}, deps(f, clk));
    clk.advance(301);
    withFiveHour = true;
    const r = await getReadingWith({}, deps(f, clk));
    expect(r.status).toBe("fresh");
    expect(f.count(USAGE)).toBe(2);
    expect(f.count(PROFILE)).toBe(2);
  });

  test("allowFetch false never fetches", async () => {
    const f = fakeFetch(ultraRoute);
    const r = await getReadingWith({ allowFetch: false }, deps(f, clock()));
    expect(r.snapshot).toBeNull();
    expect(f.calls.length).toBe(0);
  });

  test("config plan override applies to a cached snapshot at once", async () => {
    const f = fakeFetch(ultraRoute);
    const clk = clock();
    await getReadingWith({}, deps(f, clk));
    const r = await getReadingWith({}, deps(f, clk, { plan: "max5" }));
    expect(r.status).toBe("cached");
    expect(r.snapshot?.plan).toEqual({ id: "max5", label: "Max 5x", source: "config" });
  });

  test("profile failure keeps the usage read and falls back to the credentials tier", async () => {
    const f = fakeFetch((path) => (path === USAGE ? json(fixture("usage-ultra.json")) : json({}, 500)));
    const r = await getReadingWith({}, deps(f, clock()));
    expect(r.status).toBe("fresh");
    expect(r.snapshot?.plan).toMatchObject({ id: "max5", source: "rate_limit_tier" });
  });

  test("429 with Retry-After seconds sets a backoff that is honoured, even by force", async () => {
    const f = fakeFetch(() => json({}, 429, { "retry-after": "120" }));
    const clk = clock();
    const r = await getReadingWith({}, deps(f, clk));
    expect(r.status).toBe("backoff");
    expect(readCache().backoffUntil).toBe(NOW_MS / 1000 + 120);
    clk.advance(119);
    expect((await getReadingWith({ force: true }, deps(f, clk))).status).toBe("backoff");
    expect(f.count(USAGE)).toBe(1);
    clk.advance(2);
    await getReadingWith({}, deps(f, clk));
    expect(f.count(USAGE)).toBe(2);
    // Second consecutive 429 doubles.
    expect(readCache().backoffUntil).toBe(clk.ms / 1000 + 240);
  });

  test("429 with an HTTP-date Retry-After", async () => {
    const f = fakeFetch(() => json({}, 429, { "retry-after": "Sat, 21 Nov 2026 10:40:00 GMT" }));
    await getReadingWith({}, deps(f, clock()));
    expect(readCache().backoffUntil).toBe(NOW_MS / 1000 + 600);
  });

  test("429 with Retry-After 0 or missing counts as 60 s, doubling to the 1800 s cap", async () => {
    const f = fakeFetch(() => json({}, 429, { "retry-after": "0" }));
    const clk = clock();
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) {
      await getReadingWith({}, deps(f, clk));
      const until = readCache().backoffUntil;
      seen.push(until - clk.ms / 1000);
      clk.ms = until * 1000 + 1000;
    }
    expect(seen).toEqual([60, 120, 240, 480, 960, 1800, 1800]);
    const missing = fakeFetch(() => json({}, 429));
    box.cleanup();
    box = sandbox();
    box.writeCredentials(goodLogin());
    await getReadingWith({}, deps(missing, clock()));
    expect(readCache().backoffUntil).toBe(NOW_MS / 1000 + 60);
  });

  test("success after failures clears the backoff", async () => {
    let fail = true;
    const f = fakeFetch((path) => (fail ? json({}, 503) : ultraRoute(path, new Headers())));
    const clk = clock();
    expect((await getReadingWith({}, deps(f, clk))).status).toBe("error");
    clk.advance(61);
    fail = false;
    expect((await getReadingWith({}, deps(f, clk))).status).toBe("fresh");
    expect(readCache()).toMatchObject({ backoffUntil: 0, failures: 0, lastError: null });
  });

  test("401 maps to auth and pauses for refreshSeconds, keeping the cached snapshot", async () => {
    let status = 200;
    const f = fakeFetch((path) => (status === 200 ? ultraRoute(path, new Headers()) : json({}, status)));
    const clk = clock();
    await getReadingWith({}, deps(f, clk));
    clk.advance(400);
    status = 401;
    const r = await getReadingWith({}, deps(f, clk));
    expect(r.status).toBe("auth");
    expect(r.snapshot?.windows.seven_day?.usedPct).toBe(11);
    expect(r.ageSeconds).toBe(400);
    clk.advance(100);
    expect((await getReadingWith({}, deps(f, clk))).status).toBe("auth");
    expect(f.count(USAGE)).toBe(2);
  });

  test("expired expiresAt is auth with zero requests", async () => {
    box.writeCredentials(goodLogin({ expiresAt: NOW_MS - 1 }));
    const f = fakeFetch(ultraRoute);
    const r = await getReadingWith({}, deps(f, clock()));
    expect(r.status).toBe("auth");
    expect(r.detail).toBe("token expired");
    expect(f.calls.length).toBe(0);
  });

  test("timeout is error, then backoff", async () => {
    const f = fakeFetch(
      (_p) =>
        new Promise<Response>(() => {
          /* never answers; the abort ends it */
        }),
    );
    // A fetch that ignores the signal would hang; wire the abort through like real fetch does.
    const impl = f.impl;
    f.impl = (input, init) =>
      new Promise((resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        impl(input, init).then(resolve, reject);
      });
    const clk = clock();
    const r = await getReadingWith({}, deps(f, clk, { fetchTimeoutMs: 50 }));
    expect(r.status).toBe("error");
    expect(r.detail).toStartWith("timeout");
    clk.advance(10);
    expect((await getReadingWith({}, deps(f, clk, { fetchTimeoutMs: 50 }))).status).toBe("backoff");
    expect(f.count(USAGE)).toBe(1);
  });

  test("network failure is error with backoff", async () => {
    const f = fakeFetch(() => {
      throw Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
    });
    const r = await getReadingWith({}, deps(f, clock()));
    expect(r).toMatchObject({ status: "error", snapshot: null });
    expect(r.detail).toStartWith("network: ECONNREFUSED");
  });

  test("no credentials: no_credentials, no request, and later calls skip the lookup", async () => {
    unlinkSync(join(box.dir, ".credentials.json"));
    const f = fakeFetch(ultraRoute);
    let lookups = 0;
    const d = deps(f, clock());
    const read = d.readCredentials;
    d.readCredentials = () => {
      lookups++;
      return read();
    };
    expect(await getReadingWith({}, d)).toEqual({
      snapshot: null,
      status: "no_credentials",
      ageSeconds: null,
      detail: "no OAuth login",
    });
    expect((await getReadingWith({}, d)).status).toBe("no_credentials");
    expect(lookups).toBe(1);
    expect(f.calls.length).toBe(0);
  });

  test("a credentials file with no OAuth login (MCP OAuth only) is paused like no file", async () => {
    writeFileSync(join(box.dir, ".credentials.json"), JSON.stringify({ mcpOAuth: { srv: { accessToken: "MCP-FAKE" } } }));
    const f = fakeFetch(ultraRoute);
    expect((await getReadingWith({}, deps(f, clock()))).status).toBe("no_credentials");
    expect(readCache().backoffReason).toBe("no_credentials");
  });

  test("an unreadable store (torn file, keychain timeout) keeps the snapshot and sets no pause", async () => {
    const f = fakeFetch(ultraRoute);
    const clk = clock();
    await getReadingWith({}, deps(f, clk));
    clk.advance(400);
    const d = { ...deps(f, clk), readCredentials: () => ({ creds: null, definitive: false }) };
    const r = await getReadingWith({}, d);
    expect(r).toMatchObject({ status: "error", detail: "credentials unreadable", ageSeconds: 400 });
    expect(r.snapshot?.windows.seven_day?.usedPct).toBe(11);
    expect(readCache().backoffUntil).toBe(0);
    expect((await getReadingWith({}, deps(f, clk))).status).toBe("fresh");
  });

  test("a no_credentials pause ends as soon as a login appears", async () => {
    unlinkSync(join(box.dir, ".credentials.json"));
    const f = fakeFetch(ultraRoute);
    const clk = clock();
    expect((await getReadingWith({}, deps(f, clk))).status).toBe("no_credentials");
    clk.advance(10);
    box.writeCredentials(goodLogin());
    expect((await getReadingWith({}, deps(f, clk))).status).toBe("fresh");
  });

  test("an auth pause ends when the credentials file changes (token refreshed)", async () => {
    let status = 401;
    const f = fakeFetch((path) => (status === 200 ? ultraRoute(path, new Headers()) : json({}, status)));
    const clk = clock();
    expect((await getReadingWith({}, deps(f, clk))).status).toBe("auth");
    clk.advance(10);
    expect((await getReadingWith({}, deps(f, clk))).status).toBe("auth");
    expect(f.count(USAGE)).toBe(1);
    status = 200;
    box.writeCredentials(goodLogin({ accessToken: "REFRESHED-FAKE" }));
    const later = (Date.now() + 5000) / 1000;
    utimesSync(join(box.dir, ".credentials.json"), later, later);
    expect((await getReadingWith({}, deps(f, clk))).status).toBe("fresh");
    expect(f.count(USAGE)).toBe(2);
  });

  test("429 doubling counts only consecutive 429s, not earlier auth failures", async () => {
    let status = 401;
    const f = fakeFetch(() => json({}, status, status === 429 ? { "retry-after": "0" } : {}));
    const clk = clock();
    for (let i = 0; i < 4; i++) {
      await getReadingWith({ force: true }, deps(f, clk));
      clk.advance(1);
    }
    expect(readCache()).toMatchObject({ backoffReason: "auth", failures: 4 });
    status = 429;
    await getReadingWith({ force: true }, deps(f, clk));
    expect(readCache().backoffUntil).toBe(clk.ms / 1000 + 60);
    expect(readCache().failures).toBe(1);
  });

  test("a failing profile fetch is retried only after an hour", async () => {
    let profileOk = false;
    const f = fakeFetch((path) =>
      path === USAGE ? json(fixture("usage-ultra.json")) : profileOk ? json(fixture("profile-ultra.json")) : json({}, 429),
    );
    const clk = clock();
    await getReadingWith({}, deps(f, clk));
    expect(f.count(PROFILE)).toBe(1);
    clk.advance(301);
    await getReadingWith({}, deps(f, clk));
    expect(f.count(USAGE)).toBe(2);
    expect(f.count(PROFILE)).toBe(1);
    clk.advance(3600);
    profileOk = true;
    const r = await getReadingWith({}, deps(f, clk));
    expect(f.count(PROFILE)).toBe(2);
    expect(r.snapshot?.plan.id).toBe("ultra");
  });

  test("the profile fetch gets only what the usage fetch left of fetchTimeoutMs", async () => {
    const f = fakeFetch(async (path) => {
      if (path === USAGE) {
        await Bun.sleep(180);
        return json(fixture("usage-ultra.json"));
      }
      return json(fixture("profile-ultra.json"));
    });
    const r = await getReadingWith({}, deps(f, clock(), { fetchTimeoutMs: 300 }));
    expect(r.status).toBe("fresh");
    expect(f.count(PROFILE)).toBe(0);
    expect(readCache().profileRetryAt).toBe(0);
  });

  test("a newer version's cache file untouched for 24 h is taken over (downgrade)", async () => {
    const f = fakeFetch(ultraRoute);
    const clk = clock();
    const nowS = clk.ms / 1000;
    writeFileSync(cachePath(), JSON.stringify({ v: 99, fetchedAt: nowS - 1000, backoffUntil: 0 }));
    const abandoned = (Date.now() - NEWER_VERSION_HORIZON_MS - 60_000) / 1000;
    utimesSync(cachePath(), abandoned, abandoned);
    const r = await getReadingWith({}, deps(f, clk));
    expect(r.status).toBe("fresh");
    expect(r.snapshot?.windows.seven_day?.usedPct).toBe(11);
    expect(JSON.parse(await Bun.file(cachePath()).text())).toMatchObject({ v: 1, fetchedAt: Math.floor(nowS) });
  });

  test("a cache file from a newer version: gates honoured, never fetched over, never overwritten", async () => {
    const f = fakeFetch(ultraRoute);
    const clk = clock();
    const nowS = clk.ms / 1000;
    const newer = { v: 99, fetchedAt: nowS - 10, backoffUntil: 0, shape: "unknown to v1" };
    writeFileSync(cachePath(), JSON.stringify(newer));
    expect((await getReadingWith({}, deps(f, clk))).status).toBe("cached");
    writeFileSync(cachePath(), JSON.stringify({ ...newer, fetchedAt: nowS - 1000, backoffUntil: nowS + 600, backoffReason: "rate_limit" }));
    expect((await getReadingWith({ force: true }, deps(f, clk))).status).toBe("backoff");
    writeFileSync(cachePath(), JSON.stringify({ ...newer, fetchedAt: nowS - 1000 }));
    const r = await getReadingWith({ force: true }, deps(f, clk));
    expect(r).toMatchObject({ snapshot: null, detail: "cache owned by a newer smart-usage" });
    unlinkSync(join(box.dir, ".credentials.json"));
    await getReadingWith({}, deps(f, clk));
    expect(f.calls.length).toBe(0);
    expect(JSON.parse(await Bun.file(cachePath()).text())).toEqual({ ...newer, fetchedAt: nowS - 1000 });
  });

  test("torn cache file is treated as missing", async () => {
    writeFileSync(cachePath(), '{"v":1,"snapshot":{"fetchedAt":17');
    const f = fakeFetch(ultraRoute);
    const r = await getReadingWith({}, deps(f, clock()));
    expect(r.status).toBe("fresh");
    expect(f.count(USAGE)).toBe(1);
  });

  test("lock held by a live holder with a stale cache: cache returned as is, no request", async () => {
    const f = fakeFetch(ultraRoute);
    const clk = clock();
    await getReadingWith({}, deps(f, clk));
    clk.advance(1000);
    writeFileSync(fetchLockPath(), "other-holder");
    const r = await getReadingWith({}, deps(f, clk));
    expect(r.status).toBe("stale");
    expect(r.ageSeconds).toBe(1000);
    expect(f.count(USAGE)).toBe(1);
  });

  test("lock held and no cache: waits for the holder, then reads what it wrote", async () => {
    writeFileSync(fetchLockPath(), "other-holder");
    setTimeout(() => {
      const fetchedAt = NOW_MS / 1000;
      writeCache({ ...EMPTY_CACHE, fetchedAt, snapshot: { fetchedAt, windows: {}, scoped: [], plan: PLACEHOLDER } });
      unlinkSync(fetchLockPath());
    }, 100);
    const f = fakeFetch(ultraRoute);
    const started = Date.now();
    const r = await getReadingWith({}, deps(f, clock(), { fetchTimeoutMs: 3000 }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(r.status).toBe("cached");
    expect(r.snapshot).not.toBeNull();
    expect(f.calls.length).toBe(0);
  });

  test("lock held and no cache: gives up after fetchTimeoutMs", async () => {
    writeFileSync(fetchLockPath(), "other-holder");
    const f = fakeFetch(ultraRoute);
    const r = await getReadingWith({}, deps(f, clock(), { fetchTimeoutMs: 150 }));
    expect(r).toMatchObject({ status: "error", snapshot: null, detail: "another session is fetching" });
    expect(f.calls.length).toBe(0);
  });

  test("a clock set back does not pin the cache as fresh or a backoff as active", async () => {
    const f = fakeFetch(ultraRoute);
    const clk = clock();
    await getReadingWith({}, deps(f, clk));
    clk.advance(-3600);
    expect((await getReadingWith({}, deps(f, clk))).status).toBe("fresh");
    writeCache({ ...readCache(), fetchedAt: 0, snapshot: null, backoffUntil: clk.ms / 1000 + 86400, backoffReason: "rate_limit" });
    expect((await getReadingWith({}, deps(f, clk))).status).toBe("fresh");
    expect(f.count(USAGE)).toBe(3);
  });

  test("a non-JSON 200 is an error, not a crash", async () => {
    const f = fakeFetch(() => new Response("<html>", { status: 200 }));
    const r = await getReadingWith({}, deps(f, clock()));
    expect(r.status).toBe("error");
    expect(r.detail).toStartWith("unrecognised response");
  });
});
