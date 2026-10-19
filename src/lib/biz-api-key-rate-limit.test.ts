import test from "node:test";
import assert from "node:assert/strict";

import { consumeBizApiKeyRateLimit, __resetBizRateLimitLogForTests } from "./biz-api-key-rate-limit.ts";
import type { RateWindow } from "./biz-api-keys.ts";
import type { GenerationSql } from "./generation-core/database.ts";

// ─────────────────────────────────────────── 内存回退（未配置 Postgres）

test("未配置 GENERATION_DATABASE_URL / DATABASE_URL 时退回内存滑动窗口", async () => {
  const previousGen = process.env.GENERATION_DATABASE_URL;
  const previousDb = process.env.DATABASE_URL;
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  __resetBizRateLimitLogForTests();

  try {
    const rateWindows = new Map<string, RateWindow>();

    const first = await consumeBizApiKeyRateLimit("key-a", 2, rateWindows);
    assert.equal(first.allowed, true);
    const second = await consumeBizApiKeyRateLimit("key-a", 2, rateWindows);
    assert.equal(second.allowed, true);
    const third = await consumeBizApiKeyRateLimit("key-a", 2, rateWindows);
    assert.equal(third.allowed, false, "第三次请求应被内存限流拒绝");
    assert.ok(third.retryAfterSeconds >= 1);

    // 内存窗口确实落到了传入的 Map 里，不是另起一份状态。
    assert.ok(rateWindows.has("key-a"));
  } finally {
    if (previousGen === undefined) delete process.env.GENERATION_DATABASE_URL;
    else process.env.GENERATION_DATABASE_URL = previousGen;
    if (previousDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDb;
  }
});

// ─────────────────────────────────────────── 分布式路径（模拟 Postgres 控制面）

/** 构造一个假的 GenerationSql：只实现 consumeDistributedRateLimit 用到的模板调用形状。 */
function makeMockSql(counts: Map<string, number>): GenerationSql {
  const sql = (async (
    ...args: unknown[]
  ): Promise<Array<{ request_count: number }>> => {
    void args;
    // 测试里唯一关心的调用是 INSERT ... RETURNING request_count，
    // 用一个跨调用共享的 counts 表模拟窗口内计数累加。
    const key = "only-window";
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return [{ request_count: next }];
  }) as unknown as GenerationSql;
  return sql;
}

test("Postgres 控制面已配置时，超过 rpm 后 allowed 变为 false", async () => {
  process.env.GENERATION_DATABASE_URL = "postgres://test/db";
  __resetBizRateLimitLogForTests();

  try {
    const counts = new Map<string, number>();
    const mockSql = makeMockSql(counts);
    const rateWindows = new Map<string, RateWindow>();
    const rpm = 2;
    const now = new Date("2026-01-01T00:00:00.000Z");

    const decisions = [];
    for (let i = 0; i < 3; i += 1) {
      decisions.push(
        await consumeBizApiKeyRateLimit("key-distributed", rpm, rateWindows, { sql: mockSql, now }),
      );
    }

    assert.equal(decisions[0].allowed, true);
    assert.equal(decisions[1].allowed, true);
    assert.equal(decisions[2].allowed, false, "第三次应超过 rpm=2 被拒绝");
    assert.ok(decisions[2].retryAfterSeconds >= 1);

    // 分布式路径不应污染内存窗口（不是回退路径）。
    assert.equal(rateWindows.size, 0);
  } finally {
    delete process.env.GENERATION_DATABASE_URL;
  }
});

test("分布式查询抛错时退回内存限流，而不是让请求失败", async () => {
  process.env.GENERATION_DATABASE_URL = "postgres://test/db";
  __resetBizRateLimitLogForTests();

  try {
    const failingSql = (async () => {
      throw new Error("connection refused");
    }) as unknown as GenerationSql;
    const rateWindows = new Map<string, RateWindow>();

    const decision = await consumeBizApiKeyRateLimit("key-fallback", 5, rateWindows, { sql: failingSql });
    assert.equal(decision.allowed, true, "数据库故障不应把请求直接拦死，应退回内存限流");
    assert.ok(rateWindows.has("key-fallback"), "退回时应写入内存窗口");
  } finally {
    delete process.env.GENERATION_DATABASE_URL;
  }
});
