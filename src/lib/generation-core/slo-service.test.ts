import test from "node:test";
import assert from "node:assert/strict";

import {
  computeSloWindow,
  evaluateSloBreaches,
  type SloWindowRow,
} from "./slo-service.ts";
import type { GenerationSql } from "./database.ts";

// ─────────────────────────────────────────── evaluateSloBreaches（純函式，無 DB）

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

test("evaluateSloBreaches: 無違規時回空陣列", () => {
  const breaches = evaluateSloBreaches([makeRow()], THRESHOLDS);
  assert.deepEqual(breaches, []);
});

test("evaluateSloBreaches: 成功率低於門檻獨立標記", () => {
  const row = makeRow({ successRate: 0.8 });
  const breaches = evaluateSloBreaches([row], THRESHOLDS);
  assert.equal(breaches.length, 1);
  assert.deepEqual(breaches[0].kinds, ["success_rate"]);
  assert.equal(breaches[0].tenantId, "tenant-a");
  assert.equal(breaches[0].modelId, "gpt-image-2");
});

test("evaluateSloBreaches: p95 延遲超過門檻獨立標記", () => {
  const row = makeRow({ p95LatencyMs: 20_000 });
  const breaches = evaluateSloBreaches([row], THRESHOLDS);
  assert.equal(breaches.length, 1);
  assert.deepEqual(breaches[0].kinds, ["p95_latency"]);
});

test("evaluateSloBreaches: 退款率超過門檻獨立標記", () => {
  const row = makeRow({ refundRate: 0.2 });
  const breaches = evaluateSloBreaches([row], THRESHOLDS);
  assert.equal(breaches.length, 1);
  assert.deepEqual(breaches[0].kinds, ["refund_rate"]);
});

test("evaluateSloBreaches: 多項門檻同時違規時合併回報", () => {
  const row = makeRow({ successRate: 0.5, p95LatencyMs: 50_000, refundRate: 0.5 });
  const breaches = evaluateSloBreaches([row], THRESHOLDS);
  assert.equal(breaches.length, 1);
  assert.deepEqual(breaches[0].kinds, ["success_rate", "p95_latency", "refund_rate"]);
});

test("evaluateSloBreaches: successRate/p95LatencyMs 為 null（樣本不足）時不觸發對應門檻", () => {
  const row = makeRow({ successRate: null, p95LatencyMs: null, refundRate: 0.0 });
  const breaches = evaluateSloBreaches([row], THRESHOLDS);
  assert.deepEqual(breaches, []);
});

test("evaluateSloBreaches: 多組群組各自獨立評估", () => {
  const rows = [
    makeRow({ tenantId: "tenant-a", modelId: "model-1", successRate: 0.99 }),
    makeRow({ tenantId: "tenant-b", modelId: "model-2", successRate: 0.5 }),
  ];
  const breaches = evaluateSloBreaches(rows, THRESHOLDS);
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].tenantId, "tenant-b");
  assert.equal(breaches[0].modelId, "model-2");
});

// ─────────────────────────────────────────── computeSloWindow：未配置 Postgres 時回空陣列

/** 模擬 database.ts 的 getGenerationSql() 在未配置時拋出的確切錯誤訊息。 */
function makeNotConfiguredSql(): GenerationSql {
  const sql = (async () => {
    throw new Error("GENERATION_DATABASE_URL or DATABASE_URL is required for the generation control plane.");
  }) as unknown as GenerationSql;
  return sql;
}

test("computeSloWindow: 注入模擬「未配置 Postgres」的 sql 時回空陣列而非拋錯", async () => {
  const rows = await computeSloWindow(
    { windowStart: new Date("2026-01-01T00:00:00Z"), windowEnd: new Date("2026-01-01T01:00:00Z") },
    makeNotConfiguredSql(),
  );
  assert.deepEqual(rows, []);
});

test("computeSloWindow: 未傳入 sql 且環境變數未配置時，透過 getGenerationSql() 觸發同一錯誤仍回空陣列", async () => {
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

test("computeSloWindow: 非「未配置」的其他查詢錯誤應照樣往外拋，不被靜默吞掉", async () => {
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
