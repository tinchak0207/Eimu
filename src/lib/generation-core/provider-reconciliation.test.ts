import assert from "node:assert/strict";
import test from "node:test";

import type { GenerationSql } from "./database.ts";
import { recordArtifact } from "./artifact-service.ts";
import {
  failGenerationJobForReconciliation,
  freezeGenerationJobForReconciliation,
  markProviderTaskSubmitted,
  reviveGenerationJobWithArtifacts,
} from "./job-repository.ts";
import { runProviderReconciliation } from "./provider-reconciliation.ts";

type Call = { sql: string; values: unknown[] };

/**
 * INC-0831 对帐骨架回归针：上游提交锚点 durably 落行、冻结/复活/终结的 CAS 边界、
 * artifact canonical 幂等、对帐循环「确认失败才退款/窗口耗尽冻结人工」两条铁律。
 * mock 依查询内容分流（billing-projection.test.ts 同款），逐笔呼叫记录供断言。
 */
function mockSql(routes: Array<{ match: string; rows: Record<string, unknown>[] }> = []) {
  const calls: Call[] = [];
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    const call: Call = { sql: text, values };
    calls.push(call);
    for (const route of routes) {
      if (text.includes(route.match)) return route.rows;
    }
    return [];
  }) as unknown as GenerationSql;
  const withHelpers = tagged as unknown as Record<string, unknown>;
  withHelpers.json = (value: unknown) => JSON.stringify(value);
  withHelpers.begin = async (fn: (tx: GenerationSql) => Promise<unknown>) => fn(tagged);
  return { sql: tagged, calls };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** 事件名是绑定参数：断言 job_events INSERT 的 values 而非 SQL 字面量。 */
function emittedEvents(calls: Call[]): string[] {
  return calls
    .filter((call) => call.sql.includes("INSERT INTO job_events"))
    .flatMap((call) => call.values.map((value) => String(value)));
}

// ───────────────────────── markProviderTaskSubmitted

test("markProviderTaskSubmitted 落提交锚点：CAS 守卫齐全（同 id 幂等、状态白名单）", async () => {
  const { sql, calls } = mockSql([{ match: "UPDATE generation_attempt", rows: [{ id: "att-1" }] }]);
  const ok = await markProviderTaskSubmitted(
    { jobId: "job-1", attemptId: "att-1", providerTaskId: "task_X", protocol: "newapi_video" },
    sql,
  );
  assert.equal(ok, true);
  const update = calls.find((call) => call.sql.includes("UPDATE generation_attempt"));
  assert.ok(update, "should issue the anchor UPDATE");
  // 同 task id 重写允许（提交回调+失败保险双入口）、不同 task id 不覆盖。
  assert.ok(update.sql.includes("provider_task_id IS NULL OR provider_task_id ="));
  // 只允许挂在还没被判死的 attempt 上。
  assert.ok(update.sql.includes("status IN ('submitting', 'running', 'failed')"));
  // 落行即排程：state=running + 首轮轮询时间 + 对帐窗口。
  assert.ok(update.sql.includes("provider_state = 'running'"));
  assert.ok(update.sql.includes("provider_next_poll_at ="));
  assert.ok(update.sql.includes("provider_reconcile_deadline_at ="));
});

test("markProviderTaskSubmitted 行已易主/已被其他 task 占用 → false（不视为错误）", async () => {
  const { sql } = mockSql([{ match: "UPDATE generation_attempt", rows: [] }]);
  const ok = await markProviderTaskSubmitted(
    { jobId: "job-1", attemptId: "att-1", providerTaskId: "task_Y", protocol: "metaso" },
    sql,
  );
  assert.equal(ok, false);
});

// ───────────────────────── freeze / revive / fail 的 CAS 边界

test("freezeGenerationJobForReconciliation：活跃 job 冻结成 submit_unknown、清租约、补排对帐、发事件", async () => {
  const { sql, calls } = mockSql([{ match: "UPDATE generation_job", rows: [{ id: "job-1" }] }]);
  const frozen = await freezeGenerationJobForReconciliation(
    { jobId: "job-1", workerId: "worker-a", reason: "deadline exceeded with outstanding provider task" },
    sql,
  );
  assert.equal(frozen, true);
  const update = calls.find((call) => call.sql.includes("status = 'submit_unknown'"));
  assert.ok(update, "job should be CAS-frozen to submit_unknown");
  assert.ok(update.sql.includes("lease_owner = NULL"));
  assert.ok(update.sql.includes("lease_owner ="));
  // 已有排程的不覆盖（COALESCE），没排程的残留立刻补排。
  assert.ok(calls.some((call) => call.sql.includes("provider_next_poll_at = COALESCE(provider_next_poll_at, now())")));
  assert.ok(emittedEvents(calls).includes("reconcile_frozen"));
  await flushAsync();
});

test("reviveGenerationJobWithArtifacts：CAS 只复活非活跃 job；CAS 落空返回 null", async () => {
  const { sql, calls } = mockSql([{ match: "UPDATE generation_job", rows: [{ id: "job-1" }] }]);
  const artifacts = [{
    id: "art-1", outputIndex: 0, url: "https://cdn/x.mp4", mimeType: "video/mp4",
    sha256: "abc", width: 1280, height: 720, endpointLabel: "reconcile:newapi_video",
  }];
  const revived = await reviveGenerationJobWithArtifacts({ jobId: "job-1", workerId: "reconcile:test", artifacts }, sql);
  assert.ok(revived, "CAS hit should return the job result");
  assert.equal(revived.artifacts.length, 1);
  const update = calls.find((call) => call.sql.includes("status = 'succeeded'"));
  assert.ok(update, "revive should UPDATE the job to succeeded");
  assert.ok(update.sql.includes("status IN ('failed', 'refunded', 'submit_unknown', 'cancelled')"));
  assert.ok(update.sql.includes("requested_count <="));
  assert.ok(emittedEvents(calls).includes("reconcile_delivered"));

  const missed = mockSql([{ match: "UPDATE generation_job", rows: [] }]);
  const none = await reviveGenerationJobWithArtifacts(
    { jobId: "job-2", workerId: "reconcile:test", artifacts },
    missed.sql,
  );
  assert.equal(none, null);
});

test("failGenerationJobForReconciliation：只从冻结/活跃集合终结，发 reconcile_failed", async () => {
  const { sql, calls } = mockSql([{ match: "UPDATE generation_job", rows: [{ id: "job-1" }] }]);
  const terminated = await failGenerationJobForReconciliation(
    { jobId: "job-1", workerId: "reconcile:test", failureClass: "unknown", failureDetail: "upstream confirmed failure" },
    sql,
  );
  assert.equal(terminated, true);
  const update = calls.find((call) => call.sql.includes("SET status = 'failed'"));
  assert.ok(update, "should terminate the job as failed");
  assert.ok(update.sql.includes("status IN ('submit_unknown', 'queued', 'leased', 'submitting', 'running')"));
  assert.ok(emittedEvents(calls).includes("reconcile_failed"));
});

// ───────────────────────── artifact canonical 幂等

test("recordArtifact：canonical 唯一键命中 → DO NOTHING 回既有行（inserted=false）", async () => {
  const { sql, calls } = mockSql([
    { match: "INSERT INTO artifact", rows: [] },
    { match: "SELECT id FROM artifact", rows: [{ id: "canonical-row" }] },
  ]);
  const recorded = await recordArtifact({
    jobId: "job-1",
    attemptId: "att-1",
    role: "output",
    outputIndex: 0,
    objectKey: "generation/jobs/job-1/000-abc.mp4",
    deliveryUrl: "https://cdn/x.mp4",
    validated: { mimeType: "video/mp4", width: 1280, height: 720, sha256: "abc" },
    byteSize: 1024,
  }, sql);
  assert.deepEqual(recorded, { id: "canonical-row", inserted: false });
  const insert = calls.find((call) => call.sql.includes("INSERT INTO artifact"));
  assert.ok(insert);
  assert.ok(insert.sql.includes("ON CONFLICT (job_id, output_index) WHERE role = 'output'"));
  assert.ok(insert.sql.includes("DO NOTHING"));
});

test("recordArtifact：首次落列 → RETURNING 命中（inserted=true）", async () => {
  const { sql } = mockSql([{ match: "INSERT INTO artifact", rows: [{ id: "new-row" }] }]);
  const recorded = await recordArtifact({
    jobId: "job-1",
    attemptId: "att-1",
    role: "output",
    outputIndex: 0,
    validated: { mimeType: "video/mp4", width: 1280, height: 720, sha256: "abc" },
    byteSize: 1024,
  }, sql);
  assert.deepEqual(recorded, { id: "new-row", inserted: true });
});

// ───────────────────────── runProviderReconciliation 铁律

const CONTEXT_ROW: Record<string, unknown> = {
  attempt_id: "att-1",
  supplier_id: "sup-1",
  // 真实 SQL 为 COALESCE(attempt.provider_protocol, supplier.adapter_type)，恒非空。
  // V-06 起未知/缺失协议不再默认 newapi_video，夹具须与真实查询形状一致。
  protocol: "newapi_video",
  id: "sup-1",
  label: "cangyuansuanli",
  adapter_type: "newapi_video",
  supply_tier: "relay",
  failure_domain: "cangyuansuanli",
  base_url: "https://upstream.test",
  credential_ref: "CANGYUAN_API_KEY",
  configuration_json: {},
  priority: 1,
  concurrency_limit: 4,
  quality_score: 1,
  unit_cost: 0,
  health_status: "healthy",
  health_score: 1,
  latency_ewma_ms: null,
  supplier_model_id: null,
  capability_id: 1,
  capability_concurrency_limit: 4,
  contract_version: 1,
  capability_health_status: "healthy",
  account_id: "acc-1",
  account_label: "acc",
  account_credential_ref: "CANGYUAN_API_KEY",
  account_concurrency_limit: 4,
  account_health_status: "healthy",
  token_source: null,
  credential_expires_at: null,
  refresh_status: "healthy",
  success_rate_5m: 1,
  health_observed_at: null,
  account_configuration_json: {},
};

const SUBMIT_UNKNOWN_JOB_ROW: Record<string, unknown> = {
  id: "job-1",
  tenant_id: "t1",
  api_key_id: null,
  billing_user_id: 42,
  source: "biz",
  idempotency_key: null,
  request_hash: "hash",
  kind: "video_generate",
  routing_class: "generic",
  model_id: "seedance-2.5",
  size: null,
  ratio: null,
  resolution: "720p",
  quality: null,
  prompt_ciphertext: "enc",
  workflow_json: {},
  response_format: "url",
  callback_url: null,
  retry_of_job_id: null,
  primary_artifact_id: null,
  batch_id: null,
  batch_index: null,
  status: "submit_unknown",
  requested_count: 1,
  completed_count: 0,
  attempt_count: 1,
  billing_amount: 5000,
  deadline_at: new Date(),
  available_at: new Date(),
  lease_owner: null,
  lease_expires_at: null,
  failure_class: "deadline_exceeded",
  failure_detail: "deadline with outstanding provider task",
  result_json: null,
  created_at: new Date(),
  started_at: new Date(),
  finished_at: new Date(),
  updated_at: new Date(),
};

function claimRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "att-1",
    job_id: "job-1",
    output_index: 0,
    supplier_id: "sup-1",
    provider_task_id: "task_X",
    provider_poll_count: 0,
    provider_reconcile_deadline_at: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

test("runProviderReconciliation：窗口耗尽 → 退休轮询、发 reconcile_exhausted、不退款不宣判", async () => {
  const { sql, calls } = mockSql([
    { match: "provider_reconcile_deadline_at IS NOT NULL", rows: [{ id: "att-1", job_id: "job-1" }] },
    { match: "FOR UPDATE SKIP LOCKED", rows: [] },
  ]);
  const summary = await runProviderReconciliation({ executorId: "test", sql });
  assert.equal(summary.exhausted, 1);
  assert.equal(summary.claimed, 0);
  assert.equal(summary.delivered, 0);
  assert.equal(summary.confirmedFailed, 0);
  await flushAsync();
  // 退休 = provider_next_poll_at = NULL（退出轮询队列），不碰 provider_state（真相仍未明）。
  const retire = calls.find((call) => call.sql.includes("provider_next_poll_at = NULL"));
  assert.ok(retire, "exhausted attempt must leave the poll queue");
  assert.ok(!retire.sql.includes("provider_state = 'failed'"));
  assert.ok(!retire.sql.includes("provider_state = 'succeeded'"));
  assert.ok(emittedEvents(calls).includes("reconcile_exhausted"));
  assert.ok(!calls.some((call) => call.sql.includes("INSERT INTO billing_operation")), "no refund on exhausted window");
});

test("runProviderReconciliation：上游确认 FAILURE + job 冻结中且无其他未决 → fail + refund", async () => {
  process.env.NEWAPI_BASE_URL = "https://kernel.test";
  process.env.NEWAPI_API_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: "success",
    data: { task_id: "task_X", status: "FAILURE", fail_reason: "upstream render crashed" },
  }), { status: 200 })) as typeof fetch;

  try {
    const { sql, calls } = mockSql([
      { match: "FOR UPDATE SKIP LOCKED", rows: [claimRow()] },
      { match: "attempt.id = ANY", rows: [CONTEXT_ROW] },
      { match: "provider_reconcile_deadline_at IS NOT NULL", rows: [] },
      { match: "SELECT * FROM generation_job", rows: [SUBMIT_UNKNOWN_JOB_ROW] },
      { match: "SELECT * FROM billing_operation", rows: [{ id: "op-1", job_id: "job-1", status: "applied", amount: 5000, sequence: 1 }] },
      { match: "SET status = 'failed'", rows: [{ id: "job-1" }] },
      { match: "provider_state IN ('unknown', 'running')", rows: [] },
    ]);
    const summary = await runProviderReconciliation({ executorId: "test", sql });
    assert.equal(summary.claimed, 1);
    assert.equal(summary.confirmedFailed, 1);
    assert.equal(summary.delivered, 0);

    // attempt 行记录上游真相（provider_state = failed + 结果 JSON），退出轮询。
    const attemptUpdate = calls.find((call) => call.sql.includes("provider_state = 'failed'"));
    assert.ok(attemptUpdate, "attempt should record the upstream-confirmed failure");
    assert.ok(attemptUpdate.sql.includes("provider_next_poll_at = NULL"));

    // job 终结（仅在无其他未决真相后）+ 幂等退款操作落地。
    const jobFail = calls.find((call) => call.sql.includes("SET status = 'failed'"));
    assert.ok(jobFail, "frozen job should be terminated after upstream-confirmed failure");
    assert.ok(
      calls.some((call) => call.sql.includes("INSERT INTO billing_operation") && call.sql.includes("'refund'")),
      "refund billing operation must be issued only after upstream-confirmed failure",
    );
    await flushAsync();
    assert.ok(emittedEvents(calls).includes("reconcile_polled"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runProviderReconciliation：job 仍活跃（非 submit_unknown）→ 不动刀不退款", async () => {
  process.env.NEWAPI_BASE_URL = "https://kernel.test";
  process.env.NEWAPI_API_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: "success",
    data: { task_id: "task_X", status: "FAILURE", fail_reason: "upstream render crashed" },
  }), { status: 200 })) as typeof fetch;

  try {
    const { sql, calls } = mockSql([
      { match: "FOR UPDATE SKIP LOCKED", rows: [claimRow()] },
      { match: "attempt.id = ANY", rows: [CONTEXT_ROW] },
      { match: "provider_reconcile_deadline_at IS NOT NULL", rows: [] },
      { match: "SELECT * FROM generation_job", rows: [{ ...SUBMIT_UNKNOWN_JOB_ROW, status: "running" }] },
    ]);
    const summary = await runProviderReconciliation({ executorId: "test", sql });
    assert.equal(summary.claimed, 1);
    assert.equal(summary.confirmedFailed, 0, "active jobs are not the reconcile loop's to kill");
    assert.ok(!calls.some((call) => call.sql.includes("SET status = 'failed'")));
    assert.ok(!calls.some((call) => call.sql.includes("INSERT INTO billing_operation")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
