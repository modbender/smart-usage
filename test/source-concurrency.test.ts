import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, goodLogin, sandbox, type Sandbox } from "./source-helpers.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
  box.writeCredentials(goodLogin({ expiresAt: Date.now() + 3600_000 }));
});
afterEach(() => box.cleanup());

const CHILDREN = 5;
// Long enough that every child has started (and found the lock held) before the answer.
const USAGE_DELAY_MS = 1500;

test("concurrent sessions make exactly one usage request while the others wait on the lock", async () => {
  let usageRequests = 0;
  let answeredAt: number | null = null;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/oauth/usage") {
        usageRequests++;
        await Bun.sleep(USAGE_DELAY_MS);
        answeredAt = Date.now();
        return Response.json(fixture("usage-ultra.json"));
      }
      return Response.json(fixture("profile-ultra.json"));
    },
  });
  try {
    const env = { ...process.env, SMART_USAGE_API_BASE: `http://127.0.0.1:${server.port}`, SMART_USAGE_DEBUG: "1" };
    const children = Array.from({ length: CHILDREN }, () =>
      Bun.spawn([process.execPath, join(import.meta.dir, "source-child.ts")], { env, stdout: "pipe", stderr: "pipe" }),
    );
    const results = await Promise.all(
      children.map(async (child) => {
        const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        expect(code).toBe(0);
        return JSON.parse(out) as { status: string; used: number | null };
      }),
    );
    expect(usageRequests).toBe(1);
    expect(results.filter((r) => r.status === "fresh").length).toBe(1);
    for (const r of results) {
      expect(["fresh", "cached"]).toContain(r.status);
      expect(r.used).toBe(11);
    }

    // Prove the overlap: distinct processes found fetch.lock held before the single request
    // was answered, so they were waiting on the holder rather than arriving after it.
    const answered = answeredAt as number | null;
    expect(answered).not.toBeNull();
    const log = readFileSync(join(box.dir, "smart-usage", "debug.log"), "utf8");
    const waiters = new Set<string>();
    for (const line of log.split("\n")) {
      const m = /^(\S+) \[(\d+)\] \[lock\] fetch\.lock contended$/.exec(line);
      if (!m) continue;
      const at = Date.parse(m[1]!);
      if (at <= answered!) waiters.add(m[2]!);
    }
    expect(waiters.size).toBeGreaterThanOrEqual(2);
  } finally {
    server.stop(true);
  }
}, 30_000);
