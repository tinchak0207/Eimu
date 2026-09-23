import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { emitJobEvent, getJobTimeline, classifyStuckCause, listStuckJobs } from "./job-events.ts";
import { commitGenerationBilling, refundGenerationBilling } from "./billing-ledger.ts";
import type { GenerationSql } from "./database.ts";
import type { GenerationJob } from "./types.ts";

type Call = { sql: string; values: unknown[] };

const root = process.cwd();

function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
  const now = new Date("2026-08-28T00:00:00.000Z");
  return {
    id: "job-1",
    tenantId: "biz:key-1",
    apiKeyId: "key-1",
    billingUserId: 7,
    source: "biz",
    idempotencyKey: "request-1",
    requestHash: "hash",
    kind: "image_generate",
    routingClass: "generic",
    modelId: "gpt-image-2",
    size: "1024x1024",
    ratio: "1:1",
    resolution: "1k",
    quality: "fast",
    promptCiphertext: "v1.a.b.c",
    workflow: {},
    responseFormat: "url",
    callbackUrl: null,
    status: "failed",
    requestedCount: 1,
    completedCount: 0,
    attemptCount: 1,
    billingAmount: 10,
    deadlineAt: now,
    availableAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    failureClass: "overloaded",
    failureDetail: "provider failed",
    result: null,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function recordingMock(respond?: (sql: string) => unknown[]) {
  const calls: Call[] = [];
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    calls.push({ sql, values });
    return respond?.(sql) ?? [];
  }) as unknown as GenerationSql;
  (tagged as unknown as { begin: (cb: (tx: GenerationSql) => Promise<unknown>) => Promise<unknown> }).begin =
    (cb) => cb(tagged);
  return { sql: tagged, calls };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("emitJobEvent appends one job_events row and never throws", async () => {
  const { sql, calls } = recordingMock();
  emitJobEvent({ jobId: "job-9", event: "billing_reserved", actor: "worker-a", detail: { amount: 10 } }, sql);
  await flush();
  const emitCalls = calls.filter((call) => call.sql.includes("INSERT INTO job_events"));
  assert.equal(emitCalls.length, 1);
  assert.deepEqual(emitCalls[0].values.slice(0, 3), ["job-9", "billing_reserved", "worker-a"]);
  assert.equal(emitCalls[0].values[4], JSON.stringify({ amount: 10 }));
});

test("emitJobEvent wraps scalar detail and tolerates unserializable detail", async () => {
  const { sql, calls } = recordingMock();
  emitJobEvent({ jobId: "job-9", event: "probe", detail: 42 }, sql);
  emitJobEvent({ jobId: "job-9", event: "probe", detail: { circular: null } }, sql);
  await flush();
  const emitCalls = calls.filter((call) => call.sql.includes("INSERT INTO job_events"));
  assert.equal(emitCalls.length, 2);
  assert.equal(emitCalls[0].values[4], JSON.stringify({ value: 42 }));
});

test("emitJobEvent swallows database failures (telemetry never blocks the main flow)", async () => {
  const failing = (async () => {
    throw new Error("connection refused");
  }) as unknown as GenerationSql;
  assert.doesNotThrow(() => emitJobEvent({ jobId: "job-9", event: "billing_reserved" }, failing));
  await flush();
});

test("getJobTimeline merges job lifecycle, events, and billing operations into one sorted timeline", async () => {
  const rows = [
    {
      kind: "job",
      at: "2026-08-28T00:00:00.000Z",
      label: "job_created",
      actor: null,
      upstream_raw: null,
      detail: { id: "job-1", kind: "image_generate" },
    },
    {
      kind: "billing_operation",
      at: "2026-08-28T00:01:00.000Z",
      label: "reserve:unknown",
      actor: "worker-a",
      upstream_raw: "upstream exploded",
      detail: { operation: "reserve", status: "unknown" },
    },
    {
      kind: "event",
      at: "2026-08-28T00:02:00.000Z",
      label: "billing_reserved",
      actor: "worker-a",
      upstream_raw: null,
      detail: { amount: 10 },
    },
    {
      kind: "job",
      at: "2026-08-28T00:05:00.000Z",
      label: "job_current:billing_unknown",
      actor: null,
      upstream_raw: null,
      detail: { id: "job-1", status: "billing_unknown", failure_class: "unknown" },
    },
  ];
  const { sql } = recordingMock(() => rows);
  const timeline = await getJobTimeline("job-1", sql);
  assert.ok(timeline);
  assert.deepEqual(timeline.job, { id: "job-1", status: "billing_unknown", failure_class: "unknown" });
  assert.deepEqual(
    timeline.timeline.map((entry) => entry.label),
    ["job_created", "reserve:unknown", "billing_reserved"],
  );
  const op = timeline.timeline.find((entry) => entry.kind === "billing_operation");
  assert.equal(op?.upstreamRaw, "upstream exploded");
});

test("getJobTimeline returns null when the job does not exist", async () => {
  const { sql } = recordingMock(() => []);
  assert.equal(await getJobTimeline("missing", sql), null);
});

test("classifyStuckCause separates pending billing, frozen billing, stalled runs, and unsettled terminals", () => {
  assert.equal(classifyStuckCause({ status: "pending_billing" }), "pending_billing");
  assert.equal(classifyStuckCause({ status: "billing_unknown" }), "billing_unknown");
  assert.equal(classifyStuckCause({ status: "running" }), "running_stalled");
  assert.equal(classifyStuckCause({ status: "submit_unknown" }), "running_stalled");
  assert.equal(classifyStuckCause({ status: "failed" }), "terminal_unsettled");
  assert.equal(classifyStuckCause({ status: "succeeded" }), "terminal_unsettled");
});

test("listStuckJobs attaches evidence with raw upstream errors and unsettled reasons", async () => {
  const { sql, calls } = recordingMock(() => [
    {
      id: "job-stuck-1",
      status: "pending_billing",
      kind: "video_generate",
      model_id: "hailuo",
      tenant_id: "biz:key-1",
      created_at: "2026-08-28T00:00:00.000Z",
      updated_at: "2026-08-28T00:00:00.000Z",
      finished_at: null,
      failure_class: null,
      failure_detail: null,
      lease_owner: null,
      lease_expires_at: null,
      billing_amount: 12,
      reserve_status: "pending",
      reserve_executor_id: null,
      reserve_last_error: "upstream 503",
      reserve_next_attempt_at: "2026-08-28T00:10:00.000Z",
      commit_status: null,
      refund_status: null,
      refund_amount: null,
      refund_last_error: null,
    },
    {
      id: "job-stuck-2",
      status: "failed",
      kind: "image_generate",
      model_id: "gpt-image-2",
      tenant_id: "biz:key-1",
      created_at: "2026-08-27T00:00:00.000Z",
      updated_at: "2026-08-27T12:00:00.000Z",
      finished_at: "2026-08-27T12:00:00.000Z",
      failure_class: "overloaded",
      failure_detail: "provider failed",
      lease_owner: null,
      lease_expires_at: null,
      billing_amount: 10,
      reserve_status: "applied",
      reserve_executor_id: "worker-a",
      reserve_last_error: null,
      reserve_next_attempt_at: null,
      commit_status: "applied",
      refund_status: "pending",
      refund_amount: 10,
      refund_last_error: "credit gateway timeout",
    },
  ]);
  const stuck = await listStuckJobs({ minutes: 30, sql });
  assert.equal(stuck.length, 2);
  assert.equal(stuck[0].cause, "pending_billing");
  assert.equal((stuck[0].evidence.reserve as Record<string, unknown>).lastError, "upstream 503");
  assert.equal(stuck[1].cause, "terminal_unsettled");
  assert.equal(stuck[1].evidence.reason, "refund_pending");
  assert.equal((stuck[1].evidence.refund as Record<string, unknown>).lastError, "credit gateway timeout");
  assert.ok(String(calls[0].sql).includes("job.updated_at < now()"));
});

test("OBS-1：已扣款結算失敗（succeeded＋commit failed）如實列為 terminal_unsettled，reason 不誤標成 refund_*", async () => {
  const { sql, calls } = recordingMock(() => [
    {
      id: "job-unsettled-commit",
      status: "succeeded",
      kind: "image_generate",
      model_id: "gpt-image-2",
      tenant_id: "biz:key-1",
      created_at: "2026-08-27T00:00:00.000Z",
      updated_at: "2026-08-27T12:00:00.000Z",
      finished_at: "2026-08-27T12:00:00.000Z",
      failure_class: null,
      failure_detail: null,
      lease_owner: null,
      lease_expires_at: null,
      billing_amount: 10,
      reserve_status: "applied",
      reserve_executor_id: "worker-a",
      reserve_last_error: null,
      reserve_next_attempt_at: null,
      commit_status: "failed",
      commit_last_error: "commit apply failed: upstream timeout",
      refund_status: null,
      refund_amount: null,
      refund_last_error: null,
    },
  ]);
  const stuck = await listStuckJobs({ minutes: 30, sql });
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].cause, "terminal_unsettled");
  assert.equal(stuck[0].evidence.reason, "commit_failed", "語義是結算失敗，不得被退款分支吞掉");
  assert.equal(
    stuck[0].evidence.commitLastError,
    "commit apply failed: upstream timeout",
    "誠實帶出結算失敗的原始錯誤（人工對帳第一手證據）",
  );
  // 變更探針（不計入「已驗證」）：WHERE 確實多了 commit failed 分支；真實撈行需真庫，列 pending。
  assert.match(String(calls[0].sql), /commit_op\.status = 'failed'/);
});

test("a newly applied refund emits billing_refunded with the raw error absent on retries", async () => {
  const calls: Call[] = [];
  let refundStatus = "pending";
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    calls.push({ sql, values });
    if (sql.includes("SELECT * FROM billing_operation")) {
      return [{ id: "refund-1", amount: 10, status: refundStatus, attempt_count: 0 }];
    }
    if (sql.includes("attempt_count = attempt_count + 1")) {
      return refundStatus === "pending" ? [{ id: "refund-1", amount: 10, status: "executing", attempt_count: 1 }] : [];
    }
    if (sql.includes("SET status = 'applied'")) {
      refundStatus = "applied";
      return [{ id: "refund-1" }];
    }
    return [];
  }) as unknown as GenerationSql;
  (tagged as unknown as { begin: (cb: (tx: GenerationSql) => Promise<unknown>) => Promise<unknown> }).begin =
    (cb) => cb(tagged);

  const result = await refundGenerationBilling({
    job: job(),
    executorId: "worker-a",
    adapter: { reserve: async () => {}, refund: async () => {} },
  }, tagged);
  assert.equal(result, "applied");
  await flush();
  const emitted = calls.filter((call) => call.sql.includes("INSERT INTO job_events"));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].values[1], "billing_refunded");
  assert.equal(emitted[0].values[2], "worker-a");
});

test("an ambiguous refund freezes with a billing_unknown event carrying the raw error", async () => {
  const calls: Call[] = [];
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    calls.push({ sql, values });
    if (sql.includes("SELECT * FROM billing_operation")) {
      return [{ id: "refund-1", amount: 10, status: "pending", attempt_count: 0 }];
    }
    if (sql.includes("attempt_count = attempt_count + 1")) {
      return [{ id: "refund-1", amount: 10, status: "executing", attempt_count: 1 }];
    }
    return [];
  }) as unknown as GenerationSql;
  (tagged as unknown as { begin: (cb: (tx: GenerationSql) => Promise<unknown>) => Promise<unknown> }).begin =
    (cb) => cb(tagged);

  const result = await refundGenerationBilling({
    job: job(),
    executorId: "worker-a",
    adapter: {
      reserve: async () => {},
      refund: async () => {
        throw new TypeError("network failed after send");
      },
    },
  }, tagged);
  assert.equal(result, "unknown");
  await flush();
  const emitted = calls.filter((call) => call.sql.includes("INSERT INTO job_events"));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].values[1], "billing_unknown");
  assert.equal(emitted[0].values[3], "network failed after send");
});

test("a landed commit emits billing_committed exactly once; a no-op commit stays silent", async () => {
  const landed = recordingMock(() => [{ id: "commit-1" }]);
  await commitGenerationBilling(job({ status: "succeeded" }), 10, landed.sql);
  await flush();
  const emitted = landed.calls.filter((call) => call.sql.includes("INSERT INTO job_events"));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].values[1], "billing_committed");

  const silent = recordingMock(() => []);
  await commitGenerationBilling(job({ status: "succeeded" }), 10, silent.sql);
  await flush();
  assert.equal(silent.calls.filter((call) => call.sql.includes("INSERT INTO job_events")).length, 0);
});

test("probe routes sit behind the admin session gate and never leak without it", () => {
  const timelineRoute = readFileSync(join(root, "src/app/api/probe/jobs/[id]/timeline/route.ts"), "utf8");
  const stuckRoute = readFileSync(join(root, "src/app/api/probe/stuck/route.ts"), "utf8");

  for (const [name, code, dataCall] of [
    ["timeline", timelineRoute, "getJobTimeline("],
    ["stuck", stuckRoute, "listStuckJobs("],
  ] as const) {
    assert.match(code, /requireAdminSession\(\)/, `${name} route must use the admin session gate`);
    const gate = code.indexOf("await requireAdminSession()");
    const data = code.indexOf(dataCall);
    assert.ok(gate !== -1 && data !== -1 && gate < data, `${name} route must authenticate before touching data`);
    assert.match(code, /"UNAUTHORIZED"/, `${name} route must map the gate rejection to 401`);
    assert.match(code, /status: 401/, `${name} route must answer 401 for unauthorized callers`);
  }
});
