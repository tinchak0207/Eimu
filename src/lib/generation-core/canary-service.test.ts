import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateCanaryRun,
  listSellableCapabilities,
  STALE_NO_PICKUP_MS,
  STALE_STUCK_MS,
} from "./canary-service.ts";
import type { GenerationSql } from "./database.ts";

type Row = Record<string, unknown>;

/**
 * A minimal stand-in for the `postgres` tagged-template client. Each call to
 * `sql\`...\`` just pops the next canned response off a queue, in the exact
 * order the code under test is expected to issue queries. This is enough for
 * listSellableCapabilities/evaluateCanaryRun, which never use `.begin`/`.json`.
 */
function queueSql(responses: Row[][]): GenerationSql {
  const queue = [...responses];
  const fn = async (..._args: unknown[]): Promise<Row[]> => {
    void _args;
    const next = queue.shift();
    if (next === undefined) throw new Error("queueSql: no more queued responses.");
    return next;
  };
  return fn as unknown as GenerationSql;
}

function baseCanaryRunRow(overrides: Row = {}): Row {
  return {
    id: "canary-1",
    job_id: "job-1",
    supplier_id: "supplier-1",
    model_id: "model-1",
    kind: "image_generate",
    ratio: null,
    resolution: null,
    outcome: "pending",
    decoded_mime_type: null,
    decoded_width: null,
    decoded_height: null,
    decoded_sha256: null,
    first_hop_endpoint_label: null,
    failure_detail: null,
    started_at: new Date("2026-01-01T00:00:00.000Z"),
    finished_at: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function baseGenerationJobRow(overrides: Row = {}): Row {
  return {
    id: "job-1",
    tenant_id: "canary",
    api_key_id: null,
    billing_user_id: null,
    source: "canary",
    idempotency_key: null,
    request_hash: "hash",
    kind: "image_generate",
    routing_class: "generic",
    model_id: "model-1",
    size: null,
    ratio: null,
    resolution: null,
    quality: null,
    prompt_ciphertext: "ct",
    workflow_json: {},
    response_format: "b64_json",
    callback_url: null,
    status: "queued",
    requested_count: 1,
    completed_count: 0,
    attempt_count: 0,
    billing_amount: 0,
    deadline_at: new Date("2026-01-01T00:05:00.000Z"),
    available_at: new Date("2026-01-01T00:00:00.000Z"),
    lease_owner: null,
    lease_expires_at: null,
    failure_class: null,
    failure_detail: null,
    result_json: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    started_at: null,
    finished_at: null,
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

test("listSellableCapabilities expands a capability with multiple ratios/resolutions into one target per combination", async () => {
  const sql = queueSql([
    [
      {
        supplier_id: "supplier-1",
        model_id: "model-1",
        kind: "image_generate",
        ratios: ["1:1", "16:9"],
        resolutions: ["1k", "2k"],
      },
    ],
  ]);

  const targets = await listSellableCapabilities(sql);

  assert.equal(targets.length, 4);
  assert.deepEqual(
    new Set(targets.map((target) => `${target.ratio}:${target.resolution}`)),
    new Set(["1:1:1k", "1:1:2k", "16:9:1k", "16:9:2k"]),
  );
  for (const target of targets) {
    assert.equal(target.supplierId, "supplier-1");
    assert.equal(target.modelId, "model-1");
    assert.equal(target.kind, "image_generate");
  }
});

test("listSellableCapabilities treats an empty ratios/resolutions array as a single unconstrained target", async () => {
  const sql = queueSql([
    [
      {
        supplier_id: "supplier-2",
        model_id: "model-2",
        kind: "image_edit",
        ratios: [],
        resolutions: [],
      },
    ],
  ]);

  const targets = await listSellableCapabilities(sql);

  assert.deepEqual(targets, [
    { supplierId: "supplier-2", modelId: "model-2", kind: "image_edit", ratio: null, resolution: null },
  ]);
});

test("evaluateCanaryRun marks a queued job as stale_no_pickup once past the no-pickup threshold", async () => {
  const startedAt = new Date("2026-01-01T00:00:00.000Z");
  const now = new Date(startedAt.getTime() + STALE_NO_PICKUP_MS + 1_000);

  const sql = queueSql([
    [baseCanaryRunRow({ started_at: startedAt })],
    [baseGenerationJobRow({ status: "queued" })],
    [baseCanaryRunRow({ started_at: startedAt, outcome: "stale_no_pickup", finished_at: now })],
  ]);

  const result = await evaluateCanaryRun("canary-1", sql, now);

  assert.ok(result);
  assert.equal(result?.outcome, "stale_no_pickup");
});

test("evaluateCanaryRun marks a leased job as stale_stuck once past the stuck threshold", async () => {
  const startedAt = new Date("2026-01-01T00:00:00.000Z");
  const now = new Date(startedAt.getTime() + STALE_STUCK_MS + 1_000);

  const sql = queueSql([
    [baseCanaryRunRow({ started_at: startedAt })],
    [baseGenerationJobRow({ status: "leased" })],
    [baseCanaryRunRow({ started_at: startedAt, outcome: "stale_stuck", finished_at: now })],
  ]);

  const result = await evaluateCanaryRun("canary-1", sql, now);

  assert.ok(result);
  assert.equal(result?.outcome, "stale_stuck");
});

test("evaluateCanaryRun leaves a queued job pending before the no-pickup threshold elapses", async () => {
  const startedAt = new Date("2026-01-01T00:00:00.000Z");
  const now = new Date(startedAt.getTime() + STALE_NO_PICKUP_MS - 1_000);

  const sql = queueSql([
    [baseCanaryRunRow({ started_at: startedAt })],
    [baseGenerationJobRow({ status: "queued" })],
  ]);

  const result = await evaluateCanaryRun("canary-1", sql, now);

  assert.ok(result);
  assert.equal(result?.outcome, "pending");
});

test("evaluateCanaryRun leaves a leased job pending before the stuck threshold elapses", async () => {
  const startedAt = new Date("2026-01-01T00:00:00.000Z");
  const now = new Date(startedAt.getTime() + STALE_STUCK_MS - 1_000);

  const sql = queueSql([
    [baseCanaryRunRow({ started_at: startedAt })],
    [baseGenerationJobRow({ status: "leased" })],
  ]);

  const result = await evaluateCanaryRun("canary-1", sql, now);

  assert.ok(result);
  assert.equal(result?.outcome, "pending");
});
