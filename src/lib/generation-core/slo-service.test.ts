import test from "node:test";
import assert from "node:assert/strict";

import {
  computeSloWindow,
  evaluateSloBreaches,
  type SloWindowRow,
} from "./slo-service.ts";
import type { GenerationSql } from "./database.ts";

// ─────────────────────────────────────────── evaluateSloBreaches（纯函式，无 DB）

function makeRow(overrides: Partial<SloWindowRow> = {}): SloWindowRow {
  return {
    tenantId: "tenant-a",
    modelId: "gpt-image-2",
    sampleSize: 100,
    successRate: 0.99,
    p50LatencyMs: 1000,
    p95LatencyMs: 5000,
    avgQueueAgeMs: 200,
    retryRate: 0.01,
    refundRate: 0.0,
    unitCostObserved: 0.01,
    ...overrides,
  };
}

const THRESHOLDS = { minSuccessRate: 0.95, maxP95LatencyMs: 10_000, maxRefundRate: 0.05 };

test("evaluateSloBreaches: 无违规时回空阵列", () => {
  const breaches = evaluateSloBreaches([makeRow()], THRESHOLDS);
  assert.deepEqual(breaches, []);
});

test("evaluateSloBreaches: 成功率低于门槛独立标记", () => {
  const row = makeRow({ successRate: 0.8 });
  const breaches = evaluateSloBreaches([row], THRESHOLDS);
  assert.equal(breaches.length, 1);
  assert.deepEqual(breaches[0].kinds, ["success_rate"]);
  assert.equal(breaches[0].tenantId, "tenant-a");
  assert.equal(breaches[0].modelId, "gpt-image-2");
});

test("evaluateSloBreaches: p95 延迟超过门槛独立标记", () => {
  const row = makeRow({ p95LatencyMs: 20_000 });
  const breaches = evaluateSloBreaches([row], THRESHOLDS);
  assert.equal(breaches.length, 1);
  assert.deepEqual(breaches[0].kinds, ["p95_latency"]);
});

test("evaluateSloBreaches: 退款率超过门槛独立标记", () => {
  const row = makeRow({ refundRate: 0.2 });
  const breaches = evaluateSloBreaches([row], THRESHOLDS);
  assert.equal(breaches.length, 1);
  assert.deepEqual(breaches[0].kinds, ["refund_rate"]);
});

test("evaluateSloBreaches: 多项门槛同时违规时合并回报", () => {
  const row = makeRow({ successRate: 0.5, p95LatencyMs: 50_000, refundRate: 0.5 });
  const breaches = evaluateSloBreaches([row], THRESHOLDS);
  assert.equal(breaches.length, 1);
  assert.deepEqual(breaches[0].kinds, ["success_rate", "p95_latency", "refund_rate"]);
});

test("evaluateSloBreaches: successRate/p95LatencyMs 为 null（样本不足）时不触发对应门槛", () => {
  const row = makeRow({ successRate: null, p95LatencyMs: null, refundRate: 0.0 });
  const breaches = evaluateSloBreaches([row], THRESHOLDS);
  assert.deepEqual(breaches, []);
});

test("evaluateSloBreaches: 多组群组各自独立评估", () => {
  const rows = [
    makeRow({ tenantId: "tenant-a", modelId: "model-1", successRate: 0.99 }),
    makeRow({ tenantId: "tenant-b", modelId: "model-2", successRate: 0.5 }),
  ];
  const breaches = evaluateSloBreaches(rows, THRESHOLDS);
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].tenantId, "tenant-b");
  assert.equal(breaches[0].modelId, "model-2");
});

// ─────────────────────────────────────────── computeSloWindow：未配置 Postgres 时回空阵列

/** 模拟 database.ts 的 getGenerationSql() 在未配置时抛出的确切错误讯息。 */
function makeNotConfiguredSql(): GenerationSql {
  const sql = (async () => {
    throw new Error("GENERATION_DATABASE_URL or DATABASE_URL is required for the generation control plane.");
  }) as unknown as GenerationSql;
  return sql;
}

test("computeSloWindow: 注入模拟「未配置 Postgres」的 sql 时回空阵列而非抛错", async () => {
  const rows = await computeSloWindow(
    { windowStart: new Date("2026-01-01T00:00:00Z"), windowEnd: new Date("2026-01-01T01:00:00Z") },
    makeNotConfiguredSql(),
  );
  assert.deepEqual(rows, []);
});

test("computeSloWindow: 未传入 sql 且环境变数未配置时，透过 getGenerationSql() 触发同一错误仍回空阵列", async () => {
  const previousGen = process.env.GENERATION_DATABASE_URL;
  const previousDb = process.env.DATABASE_URL;
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;

  try {
    const rows = await computeSloWindow({
      windowStart: new Date("2026-01-01T00:00:00Z"),
      windowEnd: new Date("2026-01-01T01:00:00Z"),
    });
    assert.deepEqual(rows, []);
  } finally {
    if (previousGen === undefined) delete process.env.GENERATION_DATABASE_URL;
    else process.env.GENERATION_DATABASE_URL = previousGen;
    if (previousDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDb;
  }
});

test("computeSloWindow: 非「未配置」的其他查询错误应照样往外抛，不被静默吞掉", async () => {
  const failingSql = (async () => {
    throw new Error("connection refused");
  }) as unknown as GenerationSql;

  await assert.rejects(
    computeSloWindow(
      { windowStart: new Date("2026-01-01T00:00:00Z"), windowEnd: new Date("2026-01-01T01:00:00Z") },
      failingSql,
    ),
    /connection refused/,
  );
});
