import assert from "node:assert/strict";
import test from "node:test";

import { cancelGenerationJob } from "./job-repository.ts";
import { JOB_EVENT } from "./job-events.ts";
import type { GenerationSql } from "./database.ts";
import { cancelGenerationJobWithRefund, type CancelServiceDeps } from "./cancel-service.ts";
import type { GenerationJob } from "./types.ts";
import type { BillingRefundResult } from "./billing-ledger.ts";

type Call = { sql: string; values: unknown[] };

// 照 billing-ledger.test.ts 的 mock GenerationSql 模式。
// cancelGenerationJob 全部语义压在一条 CTE UPDATE 上：可取消态写 cancel_requested_at 并回传
// { id, previous_status }，否则空集（上层 route 映射 409 already_terminal）。
// 新契约：排队/租约态直接置 cancelled；在飞态（submitting/running/submit_unknown）保留原状态，
// 只写 cancel_requested_at，交给对帐收尾（远端任务可能已提交，钱不能凭本地取消就退）。
function mockSql(options: { cancellable: boolean; previousStatus: string }) {
  const calls: Call[] = [];
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    calls.push({ sql: text, values });
    if (text.includes("cancel_requested_at")) {
      return options.cancellable
        ? [{ id: "job-1", previous_status: options.previousStatus }]
        : [];
    }
    return [];
  }) as unknown as GenerationSql;
  (tagged as unknown as { begin: (cb: (tx: GenerationSql) => Promise<unknown>) => Promise<unknown> }).begin =
    (cb) => cb(tagged);
  return { sql: tagged, calls };
}

test("cancel of a queued job succeeds, reports previous status and appends job_cancelled", async () => {
  const { sql, calls } = mockSql({ cancellable: true, previousStatus: "queued" });
  const result = await cancelGenerationJob("job-1", "web:7", sql);
  assert.deepEqual(result, { cancelled: true, previousStatus: "queued" });
  assert.ok(calls.some((call) =>
    call.sql.includes("INSERT INTO job_events") && call.values.includes(JOB_EVENT.jobCancelled)));
  // 排队/租约态没有在飞上游任务 → CASE 的 ELSE 分支直接置 cancelled。
  assert.ok(calls.some((call) =>
    call.sql.includes("SET cancel_requested_at = COALESCE(cancel_requested_at,now())")
      && call.sql.includes("ELSE 'cancelled' END")
      && call.sql.includes("'pending_billing', 'queued', 'leased', 'submitting', 'running','submit_unknown'")));
});

test("cancel of a running job is accepted but preserves in-flight status for reconciliation", async () => {
  const { sql, calls } = mockSql({ cancellable: true, previousStatus: "running" });
  const result = await cancelGenerationJob("job-1", "biz:key-1", sql);
  // 取消成功：客户端不必再等；但状态不得就地改成 cancelled（远端可能已提交）。
  assert.deepEqual(result, { cancelled: true, previousStatus: "running" });
  const update = calls.find((call) => call.sql.includes("SET cancel_requested_at = COALESCE"));
  assert.ok(update, "在飞取消必须写 cancel_requested_at");
  assert.ok(
    update.sql.includes("CASE WHEN status IN ('submitting','running','submit_unknown') THEN status ELSE 'cancelled' END"),
    "在飞态保留原状态，只记取消意图交给对帐",
  );
  assert.ok(update.sql.includes("finished_at = CASE WHEN status IN ('submitting','running','submit_unknown') THEN finished_at"));
  assert.ok(calls.some((call) => call.values.includes("biz:key-1")));
  assert.ok(calls.some((call) =>
    call.sql.includes("INSERT INTO job_events") && call.values.includes(JOB_EVENT.jobCancelled)));
});

test("cancel of a terminal (succeeded) job is rejected -> route maps to 409 already_terminal", async () => {
  const { sql, calls } = mockSql({ cancellable: false, previousStatus: "succeeded" });
  const result = await cancelGenerationJob("job-1", "web:7", sql);
  assert.deepEqual(result, { cancelled: false, previousStatus: null });
  assert.ok(!calls.some((call) => call.sql.includes("INSERT INTO job_events")));
});

// ── 生产平面门面 cancelGenerationJobWithRefund（V-01）：cancel + 条件退款 ──

function facadeDeps(options: {
  cancelled: boolean;
  previousStatus: GenerationJob["status"] | null;
  refundOutcome?: BillingRefundResult;
}) {
  const refundCalls: { job: GenerationJob; executorId: string }[] = [];
  const deps = {
    cancel: async () => ({ cancelled: options.cancelled, previousStatus: options.previousStatus }),
    refund: async (input: { job: GenerationJob; executorId: string }) => {
      refundCalls.push({ job: input.job, executorId: input.executorId });
      return options.refundOutcome ?? "applied";
    },
  } as unknown as CancelServiceDeps;
  return { deps, refundCalls };
}

const paidJob = { id: "job-1", status: "queued", billingAmount: 40, billingUserId: "7" } as unknown as GenerationJob;

test("facade: cancel of queued paid job refunds in full and reports refund", async () => {
  const { deps, refundCalls } = facadeDeps({ cancelled: true, previousStatus: "queued", refundOutcome: "applied" });
  const result = await cancelGenerationJobWithRefund("job-1", "web:7", paidJob, deps);
  assert.deepEqual(result, {
    cancelled: true, previousStatus: "queued", refund: { amount: 40, full: true }, refundState: "applied",
  });
  assert.equal(refundCalls.length, 1);
  assert.equal(refundCalls[0].executorId, "cancel:web:7");
  assert.equal(refundCalls[0].job, paidJob);
});

test("facade: refund not applied yet -> refund null, state surfaced, same log line", async () => {
  const { deps } = facadeDeps({ cancelled: true, previousStatus: "leased", refundOutcome: "pending" });
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const result = await cancelGenerationJobWithRefund("job-1", "biz:key-1", paidJob, deps);
    assert.deepEqual(result, { cancelled: true, previousStatus: "leased", refund: null, refundState: "pending" });
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged, [["[generation-jobs] cancel refund not applied yet job=job-1 state=pending"]]);
});

test("facade: running / pending_billing / zero-amount jobs do not touch the ledger", async () => {
  for (const [previousStatus, job] of [
    ["running", paidJob],
    ["submitting", paidJob],
    ["pending_billing", paidJob],
    ["queued", { ...paidJob, billingAmount: 0 } as GenerationJob],
  ] as const) {
    const { deps, refundCalls } = facadeDeps({ cancelled: true, previousStatus });
    const result = await cancelGenerationJobWithRefund("job-1", "web:7", job, deps);
    assert.deepEqual(result, { cancelled: true, previousStatus, refund: null, refundState: null });
    assert.equal(refundCalls.length, 0);
  }
});

test("facade: CAS lost (already terminal) -> not cancelled, no refund", async () => {
  const { deps, refundCalls } = facadeDeps({ cancelled: false, previousStatus: null });
  const result = await cancelGenerationJobWithRefund("job-1", "web:7", paidJob, deps);
  assert.deepEqual(result, { cancelled: false, previousStatus: null, refund: null, refundState: null });
  assert.equal(refundCalls.length, 0);
});
