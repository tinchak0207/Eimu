import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { GET } from "./route";

// 服务端 heavy 刀（2026-09-12 性能审计 P2）的运行时钉选：
// ① 上游 hang 死时 2.5s 硬超时快速 503，不再占满 maxDuration；
// ② 成功验证结果走 30s 微快取，同凭证第二次呼叫不再打控面；
// ③ 拒绝路径的日志只印凭证杂凑前缀，明文 token 不落日志。

function req(token: string, userId?: string): NextRequest {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (userId) headers.set("x-user-id", userId);
  return new NextRequest("http://localhost/api/auth/me", { headers });
}

test("auth/me fast-fails a hung upstream with 503 (hard 2.5s timeout)", async () => {
  delete process.env.ENABLE_MOCK_MODE;
  const original = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    const init = args[1];
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  }) as typeof fetch;
  try {
    const startedAt = Date.now();
    const response = await GET(req("tok-hang-1"));
    const elapsedMs = Date.now() - startedAt;
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { message?: string }).message, "服务暂时不可用");
    assert.ok(elapsedMs >= 2_000 && elapsedMs < 6_000, `超时应落在 ~2.5s，实测 ${elapsedMs}ms`);
  } finally {
    globalThis.fetch = original;
  }
});

test("auth/me caches the verified payload so the second call skips the gateway", async () => {
  delete process.env.ENABLE_MOCK_MODE;
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({ success: true, data: { id: 42, username: "cached-me" } });
  }) as unknown as typeof fetch;
  try {
    const first = await GET(req("tok-cache-1", "42"));
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { data?: { id?: number } }).data?.id, 42);
    assert.equal(calls, 1);

    const second = await GET(req("tok-cache-1", "42"));
    assert.equal(second.status, 200);
    assert.equal((await second.json() as { data?: { id?: number } }).data?.id, 42);
    assert.equal(calls, 1, "30s TTL 内命中微快取，不重复打控面");

    const otherCreds = await GET(req("tok-cache-1"));
    assert.equal(otherCreds.status, 200);
    assert.equal(calls, 2, "凭证组合不同（有无 x-user-id）即不同快取 key");
  } finally {
    globalThis.fetch = original;
  }
});

test("auth/me rejected-upstream log carries only the credential hash, never the token", async () => {
  delete process.env.ENABLE_MOCK_MODE;
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ success: false, message: "invalid token" }, { status: 401 })) as unknown as typeof fetch;
  const logged: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const secretToken = "tok-secret-never-log-me";
    const response = await GET(req(secretToken));
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { message?: string }).message, "session_expired");
    const dumped = JSON.stringify(logged);
    assert.ok(dumped.includes("[auth/me] upstream rejected"), "拒绝路径必须留诊断日志");
    assert.doesNotMatch(dumped, /tok-secret-never-log-me/, "明文 token 严禁进日志");
  } finally {
    console.error = originalError;
    globalThis.fetch = original;
  }
});

test("auth/me 新人礼挂点：验证通过后经签名通道发放，钱包 quota 当场加上；同实例同用户不再重问控面", async () => {
  delete process.env.ENABLE_MOCK_MODE;
  const saved = {
    origin: process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN,
    secret: process.env.GENERATION_BILLING_RELAY_SECRET,
    db: process.env.GENERATION_DATABASE_URL,
    dbFallback: process.env.DATABASE_URL,
  };
  process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN = "https://control.example";
  process.env.GENERATION_BILLING_RELAY_SECRET = "test-relay-secret";
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  const original = globalThis.fetch;
  const relayBodies: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://control.example/image-control/api/internal/welcome-gift") {
      relayBodies.push(String(init?.body));
      const headers = new Headers(init?.headers);
      assert.match(headers.get("X-Biz-Key-Sync-Signature") ?? "", /^sha256=[0-9a-f]{64}$/);
      return Response.json({ ok: true, result: { status: "granted", amountQuota: 2_500_000 } });
    }
    return Response.json({ success: true, data: { id: 9901, username: "fresh-user", quota: 0 } });
  }) as unknown as typeof fetch;
  try {
    const first = await GET(req("tok-welcome-1", "9901"));
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { data?: { quota?: number } }).data?.quota, 2_500_000);
    assert.deepEqual(relayBodies.map((body) => JSON.parse(body)), [{ op: "grant", userId: 9901 }]);

    // 换一组凭证（绕过 /me 微快取）再来：结案状态已记住，不再打控面。
    const second = await GET(req("tok-welcome-2", "9901"));
    assert.equal(second.status, 200);
    assert.equal(relayBodies.length, 1);
  } finally {
    globalThis.fetch = original;
    for (const [key, env] of [
      ["GENERATION_CONTROL_PLANE_PROXY_ORIGIN", saved.origin],
      ["GENERATION_BILLING_RELAY_SECRET", saved.secret],
      ["GENERATION_DATABASE_URL", saved.db],
      ["DATABASE_URL", saved.dbFallback],
    ] as const) {
      if (env === undefined) delete process.env[key];
      else process.env[key] = env;
    }
  }
});
