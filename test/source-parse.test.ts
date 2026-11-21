import { describe, expect, test } from "bun:test";
import { apiBase, DEFAULT_API_BASE, networkErrorCode, parseProfile, parseRetryAfter, parseUsage } from "../src/source/api.ts";
import { detectPlan, type ProfileInfo } from "../src/source/plan.ts";
import { fixture } from "./source-helpers.ts";

const iso = (s: string) => Math.floor(Date.parse(s) / 1000);

describe("parseUsage", () => {
  test("Ultra fixture: no five_hour, seven_day 11%, real window start, Fable scoped inactive", () => {
    const parts = parseUsage(fixture("usage-ultra.json"))!;
    expect(parts.windows.five_hour).toBeUndefined();
    expect(parts.windows.seven_day).toEqual({
      kind: "seven_day",
      usedPct: 11,
      resetsAt: iso("2026-11-25T01:00:00.490Z"),
      startedAt: iso("2026-11-18T01:00:00.490Z"),
      severity: "normal",
    });
    expect(parts.scoped).toEqual([
      { model: "Fable", usedPct: 3, resetsAt: iso("2026-11-25T01:00:00.491Z"), active: false },
    ]);
  });

  test("Pro/Max payload: both windows, startedAt derived from resetsAt, legacy seven_day_opus", () => {
    const parts = parseUsage({
      five_hour: { utilization: 42.5, resets_at: "2026-11-21T12:00:00Z", whatever: 1 },
      seven_day: { utilization: 30, resets_at: "2026-11-24T00:00:00Z" },
      seven_day_opus: { utilization: 55, resets_at: "2026-11-24T00:00:00Z" },
      seven_day_sonnet: null,
      unknown_future_field: { nested: true },
    })!;
    expect(parts.windows.five_hour).toEqual({
      kind: "five_hour",
      usedPct: 42.5,
      resetsAt: iso("2026-11-21T12:00:00Z"),
      startedAt: iso("2026-11-21T07:00:00Z"),
      severity: null,
    });
    expect(parts.windows.seven_day?.startedAt).toBe(iso("2026-11-17T00:00:00Z"));
    expect(parts.scoped).toEqual([{ model: "Opus", usedPct: 55, resetsAt: iso("2026-11-24T00:00:00Z"), active: true }]);
  });

  test("resets_at null keeps the window with null times", () => {
    const parts = parseUsage({ five_hour: { utilization: 0, resets_at: null } })!;
    expect(parts.windows.five_hour).toMatchObject({ usedPct: 0, resetsAt: null, startedAt: null });
  });

  test("a malformed window drops that window only", () => {
    const parts = parseUsage({
      five_hour: { utilization: null, resets_at: "2026-11-21T12:00:00Z" },
      seven_day: { utilization: 20, resets_at: "not a date" },
      limits: [{ kind: "weekly_scoped", percent: "x", scope: { model: { display_name: "Fable" } } }, 7, null],
    })!;
    expect(parts.windows.five_hour).toBeUndefined();
    expect(parts.windows.seven_day).toMatchObject({ usedPct: 20, resetsAt: null, startedAt: null });
    expect(parts.scoped).toEqual([]);
  });

  test("a scoped limit from limits[] wins over the legacy field for the same model", () => {
    const parts = parseUsage({
      seven_day_opus: { utilization: 10, resets_at: null },
      limits: [{ kind: "weekly_scoped", percent: 80, is_active: true, scope: { model: { display_name: "Opus" } } }],
    })!;
    expect(parts.scoped).toEqual([{ model: "Opus", usedPct: 80, resetsAt: null, active: true }]);
  });

  test("a non-object body is unusable", () => {
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage([1, 2])).toBeNull();
    expect(parseUsage("x")).toBeNull();
  });
});

describe("plan detection", () => {
  const profile = (o: Partial<ProfileInfo>): ProfileInfo => ({
    fetchedAt: 0,
    displayName: null,
    rateLimitTier: null,
    organizationType: null,
    ...o,
  });
  const auto = { configPlan: "auto" as const, credentialsTier: null };

  test("Ultra display name wins over the max_20x tier", () => {
    const p = parseProfile(fixture("profile-ultra.json"), 1)!;
    expect(detectPlan({ ...auto, profile: p })).toEqual({ id: "ultra", label: "Ultra", source: "display_name" });
  });

  test.each([
    ["Max", "max5"],
    ["Max 5x", "max5"],
    ["Max 20x", "max20"],
    ["Ultra", "ultra"],
    ["Claude Pro", "pro"],
    ["Team", "team"],
    ["Enterprise", "enterprise"],
  ] as const)("display name %p -> %p", (displayName, id) => {
    expect(detectPlan({ ...auto, profile: profile({ displayName }) })).toMatchObject({ id, source: "display_name" });
  });

  test.each([
    ["Max (2026)", "max5"],
    ["Max 2025 promo", "max5"],
    ["Maximum", "unknown"],
    ["Claude Maxwell", "unknown"],
  ] as const)("display name %p -> %p (whole words only)", (displayName, id) => {
    expect(detectPlan({ ...auto, profile: profile({ displayName }) }).id).toBe(id);
  });

  test("tier default_claude_max_20x without a display name is ultra (Max 20x was renamed)", () => {
    const plan = detectPlan({ ...auto, profile: profile({ rateLimitTier: "default_claude_max_20x" }) });
    expect(plan).toEqual({ id: "ultra", label: "Ultra", source: "rate_limit_tier" });
  });

  test("tier max_5x and pro", () => {
    expect(detectPlan({ ...auto, profile: profile({ rateLimitTier: "default_claude_max_5x" }) }).id).toBe("max5");
    expect(detectPlan({ ...auto, profile: profile({ rateLimitTier: "default_claude_pro" }) }).id).toBe("pro");
  });

  test("organization_type: claude_team maps, claude_max alone falls through", () => {
    expect(detectPlan({ ...auto, profile: profile({ organizationType: "claude_team" }) })).toMatchObject({
      id: "team",
      source: "organization_type",
    });
    expect(detectPlan({ ...auto, profile: profile({ organizationType: "claude_max" }) })).toMatchObject({
      id: "unknown",
      source: "none",
    });
  });

  test("credentials tier is the last hint", () => {
    expect(detectPlan({ configPlan: "auto", profile: null, credentialsTier: "default_claude_max_20x" })).toMatchObject({
      id: "ultra",
      source: "rate_limit_tier",
    });
    expect(detectPlan({ configPlan: "auto", profile: null, credentialsTier: null })).toEqual({
      id: "unknown",
      label: "Unknown",
      source: "none",
    });
  });

  test("config override beats everything", () => {
    const p = parseProfile(fixture("profile-ultra.json"), 1)!;
    expect(detectPlan({ configPlan: "max5", profile: p, credentialsTier: null })).toEqual({
      id: "max5",
      label: "Max 5x",
      source: "config",
    });
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-11-21T10:30:00Z");
  test("seconds, HTTP date, junk", () => {
    expect(parseRetryAfter("120", now)).toBe(120);
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter("Sat, 21 Nov 2026 10:35:00 GMT", now)).toBe(300);
    expect(parseRetryAfter("Sat, 21 Nov 2026 10:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe("networkErrorCode", () => {
  test("bun puts the code on the error, node's undici on its cause; the message is never used", () => {
    expect(networkErrorCode(Object.assign(new Error("x"), { code: "ConnectionRefused" }))).toBe("ConnectionRefused");
    const undici = new TypeError("fetch failed https://api.example/secret", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    expect(networkErrorCode(undici)).toBe("ECONNREFUSED");
    expect(networkErrorCode(new TypeError("fetch failed https://api.example/secret"))).toBe("fetch failed");
    expect(networkErrorCode(null)).toBe("fetch failed");
  });
});

describe("apiBase", () => {
  test.each(["http://127.0.0.1:8123", "http://localhost:9/", "http://[::1]:7", "HTTP://LOCALHOST:9"])("loopback %p is honoured", (base) => {
    expect(apiBase({ SMART_USAGE_API_BASE: base })).toBe(base.replace(/\/+$/, ""));
  });
  test.each([
    "https://evil.example.com",
    "http://127.0.0.1.evil.com",
    "http://localhost@evil.com",
    "http://[::1]:80@x",
    "http://localhost.:9",
    "http://[::ffff:127.0.0.1]:9",
    "http://10.0.0.1",
    "file:///etc/passwd",
    "garbage",
  ])(
    "non-loopback %p is ignored",
    (base) => {
      expect(apiBase({ SMART_USAGE_API_BASE: base })).toBe(DEFAULT_API_BASE);
    },
  );
  test("unset gives the Anthropic host", () => {
    expect(apiBase({})).toBe(DEFAULT_API_BASE);
  });
});
