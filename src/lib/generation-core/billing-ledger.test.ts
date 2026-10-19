import assert from "node:assert/strict";
import test from "node:test";

import {
  billingRetryAt,
  classifyBillingFailure,
  commitGenerationBilling,
  refundGenerationBilling,
  reserveGenerationBilling,
  retryStrandedRefundOperations,
} from "./billing-ledger.ts";
import { resolveReplayPolicy } from "./operation-registry.ts";
import { ImageBillingGatewayError, ImageBillingRevertedError } from "@/lib/image-billing";
import type { GenerationSql } from "./database.ts";
import type { GenerationJob } from "./types.ts";

type Call = { sql: string; values: unknown[] };

function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
  const now = new Date("2026-07-29T00:00:00.000Z");
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

function mockSql(initialRefundStatus: string, claimed = true) {
  const calls: Call[] = [];
  let refundStatus = initialRefundStatus;
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    calls.push({ sql, values });
    if (sql.includes("SELECT * FROM billing_operation")) {
      return [{ id: "refund-1", amount: 10, status: refundStatus, attempt_count: 0 }];
    }
    if (sql.includes("attempt_count = attempt_count + 1")) {
      return claimed && refundStatus === "pending"
        ? [{ id: "refund-1", amount: 10, status: "executing", attempt_count: 1 }]
        : [];
    }
    if (sql.includes("SET status = 'applied'")) {
      refundStatus = "applied";
      return [{ id: "refund-1" }];
    }
    if (sql.includes("SET status = 'unknown'")) {
      refundStatus = "unknown";
      return [];
    }
    if (sql.includes("SET status = 'pending'")) {
      refundStatus = "pending";
      return [];
    }
    return [];
  }) as unknown as GenerationSql;
  (tagged as unknown as { begin: (cb: (tx: GenerationSql) => Promise<unknown>) => Promise<unknown> }).begin =
    (cb) => cb(tagged);
  return { sql: tagged, calls };
}

test("only explicit client rejections or 429 are safe billing retries", () => {
  assert.equal(classifyBillingFailure(new ImageBillingGatewayError("rate limited", 429, "45")), "retry");
  assert.equal(classifyBillingFailure(new ImageBillingGatewayError("insufficient quota", 402)), "rejected");
  assert.equal(classifyBillingFailure(new ImageBillingGatewayError("gateway unavailable", 503)), "unknown");
  assert.equal(classifyBillingFailure(new TypeError("fetch failed")), "unknown");
  assert.equal(classifyBillingFailure(new ImageBillingRevertedError("compensated")), "retry");
});

test("429 retry timing honors Retry-After and retry delay is bounded", () => {
  const now = new Date("2026-07-29T00:00:00.000Z");
  assert.equal(
    billingRetryAt(new ImageBillingGatewayError("rate limited", 429, "120"), 1, now).toISOString(),
    "2026-07-29T00:02:00.000Z",
  );
  assert.ok(billingRetryAt(new ImageBillingGatewayError("rate limited", 429), 99, now).getTime() - now.getTime() <= 300_000);
});

test("full refund transitions the job once and never repeats a successful external credit", async () => {
  const { sql, calls } = mockSql("pending");
  let refunds = 0;
  const result = await refundGenerationBilling({
    job: job(),
    executorId: "worker-a",
    adapter: {
      reserve: async () => {},
      refund: async () => { refunds += 1; },
    },
  }, sql);
  assert.equal(result, "applied");
  assert.equal(refunds, 1);
  assert.ok(calls.some((call) => call.sql.includes("status = 'refunded'")));

  const alreadyApplied = mockSql("applied");
  const second = await refundGenerationBilling({
    job: job(),
    executorId: "worker-b",
    adapter: {
      reserve: async () => {},
      refund: async () => { throw new Error("must not call gateway again"); },
    },
  }, alreadyApplied.sql);
  assert.equal(second, "applied");
});

test("an ambiguous refund is frozen and a later retry does not issue a second credit", async () => {
  const { sql } = mockSql("pending");
  let refunds = 0;
  const adapter = {
    reserve: async () => {},
    refund: async () => {
      refunds += 1;
      throw new TypeError("network failed after send");
    },
  };
  const first = await refundGenerationBilling({ job: job(), executorId: "worker-a", adapter }, sql);
  assert.equal(first, "unknown");
  const second = await refundGenerationBilling({ job: job(), executorId: "worker-b", adapter }, sql);
  assert.equal(second, "unknown");
  assert.equal(refunds, 1);
});

test("commit is recorded only against an applied reserve operation", async () => {
  const calls: Call[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join(" "), values });
    return [];
  }) as unknown as GenerationSql;

  await commitGenerationBilling(job({ status: "succeeded" }), 10, sql);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /reserve\.status = 'applied'/);
  assert.match(calls[0].sql, /ON CONFLICT \(job_id, operation, sequence\) DO NOTHING/);
});

/**
 * FG-b（2026-09-23）接线回归：计费重放的预算由 operation registry 决定。
 * 全部走真实服务函式，断言可观测的外部效果（adapter 呼叫次数／金额、回传值、状态转移），
 * 不是查常数、不是看原始码字串。
 */

/** 计费 op mock：claim（attempt_count+1）后回传指定的「这次尝试」序号。 */
function mockBillingSql(input: {
  claimedAttemptNo: number;
  status?: string;
  jobRow?: Record<string, unknown> | null;
  strandedRefund?: boolean;
  amount?: number;
}) {
  const calls: Call[] = [];
  const amount = input.amount ?? 10;
  let opStatus = input.status ?? "pending";
  let jobStatus = String(input.jobRow?.status ?? "");
  const tagged = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    calls.push({ sql, values });
    if (input.strandedRefund && sql.includes("refund_op.amount AS refund_amount")) {
      return [{ id: "job-1", refund_amount: 10 }];
    }
    if (sql.includes("SELECT * FROM billing_operation")) {
      return [{ id: "refund-1", amount, status: opStatus, attempt_count: input.claimedAttemptNo - 1 }];
    }
    if (sql.includes("FROM generation_job job WHERE job.id =")) {
      return input.jobRow ? [{ ...input.jobRow, status: jobStatus }] : [];
    }
    if (sql.includes("attempt_count = attempt_count + 1")) {
      return opStatus === "pending"
        ? [{ id: "refund-1", amount, status: "executing", attempt_count: input.claimedAttemptNo }]
        : [];
    }
    if (sql.includes("SET status = 'applied'")) { opStatus = "applied"; return [{ id: "refund-1" }]; }
    if (sql.includes("SET status = 'unknown'")) { opStatus = "unknown"; return []; }
    if (sql.includes("SET status = 'failed'")) { opStatus = "failed"; return []; }
    if (sql.includes("SET status = 'pending'")) { opStatus = "pending"; return []; }
    // job 侧转移（reserve 被冻结时 job → billing_unknown）
    if (sql.includes("status = 'billing_unknown'")) { jobStatus = "billing_unknown"; return []; }
    if (sql.includes("status = 'queued'")) { jobStatus = "queued"; return []; }
    return [];
  };
  (tagged as unknown as { begin: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).begin = (cb) => cb(tagged);
  return { sql: tagged as unknown as GenerationSql, calls, status: () => opStatus };
}

/** 把 GenerationJob fixture 映成 DB 行（reserve 路径的 freshJob 会直接读 DB）。 */
function jobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const j = job();
  return {
    id: j.id, tenant_id: j.tenantId, api_key_id: j.apiKeyId, billing_user_id: j.billingUserId,
    source: j.source, idempotency_key: j.idempotencyKey, request_hash: j.requestHash, kind: j.kind,
    routing_class: j.routingClass, model_id: j.modelId, size: j.size, ratio: j.ratio,
    resolution: j.resolution, quality: j.quality, prompt_ciphertext: j.promptCiphertext,
    workflow_json: j.workflow, response_format: j.responseFormat, callback_url: j.callbackUrl,
    status: j.status, requested_count: j.requestedCount, completed_count: j.completedCount,
    attempt_count: j.attemptCount, billing_amount: j.billingAmount, deadline_at: j.deadlineAt,
    available_at: j.availableAt, lease_owner: j.leaseOwner, lease_expires_at: j.leaseExpiresAt,
    failure_class: j.failureClass, failure_detail: j.failureDetail, result_json: j.result,
    created_at: j.createdAt, started_at: j.startedAt, finished_at: j.finishedAt, updated_at: j.updatedAt,
    ...overrides,
  };
}

/** 计费 op 预算的 registry 值（billing.reserve / billing.refund），当 oracle 用。 */
const RESERVE_REFUND_BUDGET = resolveReplayPolicy("billing.refund").maxReplayAttempts;
const COMMIT_BUDGET = resolveReplayPolicy("billing.commit").maxReplayAttempts;

test("FG-b：退款重放预算内（第 64 次）照旧落地一次，金额等于应退额", async () => {
  const { sql } = mockBillingSql({ claimedAttemptNo: RESERVE_REFUND_BUDGET });
  const amounts: number[] = [];
  const result = await refundGenerationBilling({
    job: job(),
    amount: 10,
    executorId: "worker-a",
    adapter: {
      reserve: async () => { throw new Error("reserve must not run on the refund path"); },
      refund: async (input) => { amounts.push(input.amount); },
    },
  }, sql);

  assert.equal(result, "applied", "预算内的重试必须照旧执行");
  assert.deepEqual(amounts, [10], "外部 credit 恰好一次、金额等于应退额");
});

test("FG-b：退款重放预算耗尽（第 65 次）→ 一次外部 credit 都不发，op 终结为 failed", async () => {
  const { sql, calls, status } = mockBillingSql({ claimedAttemptNo: RESERVE_REFUND_BUDGET + 1 });
  let credits = 0;
  const result = await refundGenerationBilling({
    job: job(),
    amount: 10,
    executorId: "worker-a",
    adapter: {
      reserve: async () => {},
      refund: async () => { credits += 1; },
    },
  }, sql);

  assert.equal(credits, 0, "超预算的尝试不得发出外部 credit（重放不得放大成重复退款）");
  assert.equal(result, "failed", "回报 failed（不是 pending：pending 会让呼叫方以为还在跑）");
  assert.equal(status(), "failed", "op 终结为 failed（不再被 stranded 扫描捞起，也不被假装 applied）");
  assert.ok(
    !calls.some((call) => call.sql.includes("SET status = 'applied'")),
    "被拒的重放不得写入任何 applied 转移",
  );
  assert.ok(
    calls.some((call) => call.sql.includes("SET status = 'pending'") === false),
    "被拒的重放不得再排下一次重试（否则就是死循环）",
  );
  const denial = calls.find((call) => call.sql.includes("SET status = 'failed'"));
  assert.ok(denial, "必须写入终结转移");
  assert.ok(
    String(denial.values).includes("operation registry"),
    "last_error 必须留下拒绝理由（不是静默失败）",
  );
});

test("FG-b 对抗性：呼叫方自带 maxAttempts/retryCount/预算 999 一律无效（预算仍由 registry 决定）", async () => {
  const { sql } = mockBillingSql({ claimedAttemptNo: RESERVE_REFUND_BUDGET + 1 });
  let credits = 0;
  const adversarial = {
    job: job(),
    amount: 10,
    executorId: "worker-a",
    adapter: { reserve: async () => {}, refund: async () => { credits += 1; } },
    maxAttempts: 999,
    retries: 999,
    retryCount: 999,
    maxReplayAttempts: 999,
  } as unknown as Parameters<typeof refundGenerationBilling>[0];
  const result = await refundGenerationBilling(adversarial, sql);

  assert.equal(credits, 0, "呼叫方注入的 999 次预算不得让超额重放过关");
  assert.equal(result, "failed");

  // 预算内的同一份注入入参照旧放行（证明拒绝来自预算，不是因为多传栏位把裁决弄坏）。
  const within = mockBillingSql({ claimedAttemptNo: RESERVE_REFUND_BUDGET });
  let ok = 0;
  const withinResult = await refundGenerationBilling({
    ...adversarial,
    adapter: { reserve: async () => {}, refund: async () => { ok += 1; } },
  } as unknown as Parameters<typeof refundGenerationBilling>[0], within.sql);
  assert.equal(withinResult, "applied");
  assert.equal(ok, 1);
});

test("FG-b：429 重放一次后成功——退款只落地一次、两次金额相同、已落地不再重复 credit", async () => {
  // 第一次：claim 序号 1 → 上游 429（可安全重放，op 退回 pending）
  const first = mockBillingSql({ claimedAttemptNo: 1 });
  const amounts: number[] = [];
  let attempt = 0;
  const adapter = {
    reserve: async () => {},
    refund: async (input: { amount: number }) => {
      attempt += 1;
      amounts.push(input.amount);
      if (attempt === 1) throw new ImageBillingGatewayError("rate limited", 429);
    },
  };
  const pending = await refundGenerationBilling({ job: job(), amount: 10, executorId: "worker-a", adapter }, first.sql);
  assert.equal(pending, "pending", "429 是可安全重放 → 退回 pending 等下一次");
  assert.equal(first.status(), "pending");

  // 第二次：claim 序号 2 → 成功。两次呼叫合计只有 1 笔 credit 落地。
  const second = mockBillingSql({ claimedAttemptNo: 2 });
  const applied = await refundGenerationBilling({ job: job(), amount: 10, executorId: "worker-b", adapter }, second.sql);
  assert.equal(applied, "applied");
  assert.deepEqual(amounts, [10, 10], "重试前后金额不得漂移");

  // 第三次（已 applied）：短路，不得再发一次 credit。
  const third = mockBillingSql({ claimedAttemptNo: 3, status: "applied" });
  const again = await refundGenerationBilling({
    job: job(),
    amount: 10,
    executorId: "worker-c",
    adapter: { reserve: async () => {}, refund: async () => { amounts.push(-1); } },
  }, third.sql);
  assert.equal(again, "applied");
  assert.deepEqual(amounts, [10, 10], "已落地的退款不得再 credit 一次（帐面只准一笔）");
  assert.ok(
    !third.calls.some((call) => call.sql.includes("attempt_count = attempt_count + 1")),
    "已 applied 的 op 不再被 claim（连预算都不消耗）",
  );
});

test("FG-b：quota_exhausted(402) fail-fast 后的应退额精确（退款语义不随裁决改变）", async () => {
  // 402 由 registry 原生硬停 fail-fast（暴君 08-29 裁定），退款立刻发生；
  // 金额仍是 billingAmount - committed：requested 3 完成 1 → 应退 30 - floor(30/3) = 20。
  const partial = mockBillingSql({ claimedAttemptNo: 1, amount: 20 });
  const partialAmounts: number[] = [];
  const partialResult = await refundGenerationBilling({
    job: job({ billingAmount: 30, requestedCount: 3, completedCount: 1 }),
    amount: 20,
    executorId: "worker-a",
    adapter: { reserve: async () => {}, refund: async (input) => { partialAmounts.push(input.amount); } },
  }, partial.sql);
  assert.equal(partialResult, "applied");
  assert.deepEqual(partialAmounts, [20], "应退额必须精确等于 billingAmount - committed");
  assert.ok(
    !partial.calls.some((call) => call.sql.includes("status = 'refunded'")),
    "部分退款不得把 job 标成 refunded（状态机语义不变）",
  );

  const full = mockBillingSql({ claimedAttemptNo: 1, amount: 30 });
  const fullAmounts: number[] = [];
  const fullResult = await refundGenerationBilling({
    job: job({ billingAmount: 30, requestedCount: 3, completedCount: 1 }),
    amount: 30,
    executorId: "worker-b",
    adapter: { reserve: async () => {}, refund: async (input) => { fullAmounts.push(input.amount); } },
  }, full.sql);
  assert.equal(fullResult, "applied");
  assert.deepEqual(fullAmounts, [30]);
  assert.ok(
    full.calls.some((call) => call.sql.includes("status = 'refunded'")),
    "全额退款才标 refunded（既有公开语义）",
  );
});

test("FG-b：reserve 超预算不扣款——冻结为 billing_unknown（不在此处退款；zombie 只标 needs_review）", async () => {
  const { sql, calls, status } = mockBillingSql({
    claimedAttemptNo: RESERVE_REFUND_BUDGET + 1,
    jobRow: jobRow({ status: "pending_billing" }),
  });
  let reserves = 0;
  const result = await reserveGenerationBilling({
    job: job({ status: "pending_billing" }),
    executorId: "worker-a",
    adapter: {
      reserve: async () => { reserves += 1; },
      refund: async () => {},
    },
  }, sql);

  assert.equal(reserves, 0, "超预算的 reserve 不得发出外部扣款");
  assert.equal(status(), "unknown", "reserve op 冻结为 unknown（金额不动；zombie 再标 needs_review，不自动退款）");
  assert.equal(result.status, "billing_unknown", "job 进 billing_unknown 供 probe 看见");
  assert.ok(
    calls.some((call) => call.sql.includes("SET status = 'unknown'") && String(call.values).includes("operation registry")),
    "冻结时留下 registry 拒绝理由",
  );
  assert.ok(
    !calls.some((call) => call.sql.includes("SET status = 'queued'")),
    "被拒的 reserve 不得把 job 放进 queued（否则等于没扣款就生成）",
  );
});

test("FG-b：搁浅退款通道（每 30s 跑）在预算耗尽后不得再 credit，且不自称重试成功", async () => {
  const { sql, calls, status } = mockBillingSql({
    claimedAttemptNo: RESERVE_REFUND_BUDGET + 1,
    jobRow: jobRow({ status: "refunded" }),
    strandedRefund: true,
  });
  let credits = 0;
  const retried = await retryStrandedRefundOperations({
    executorId: "worker-a",
    adapter: { reserve: async () => {}, refund: async () => { credits += 1; } },
    sql,
  });

  assert.equal(retried, 0, "被拒的重放不得计入 retried（summary 不许灌水）");
  assert.equal(credits, 0, "超预算的搁浅退款不得发出外部 credit");
  assert.equal(status(), "failed", "op 终结为 failed → 下一轮扫描（只捞 pending）不会再选中它");
  assert.ok(
    !calls.some((call) => call.sql.includes("SET status = 'applied'")),
    "被拒的搁浅重试不得写 applied",
  );
});

test("FG-b：预算常数 oracle——reserve/refund 各 64、commit 只许 1 次（政策不得互相借走）", () => {
  assert.deepEqual(
    [resolveReplayPolicy("billing.reserve").maxReplayAttempts, resolveReplayPolicy("billing.refund").maxReplayAttempts, COMMIT_BUDGET],
    [RESERVE_REFUND_BUDGET, RESERVE_REFUND_BUDGET, 1],
  );
  assert.equal(COMMIT_BUDGET, 1, "commit 的扣款无上游幂等契约 → 重放预算必须是 1（只准第一次）");
});

test("2026-08-30: stranded refund retry scans only pending ops, never failed (dead loop killed)", async () => {
  // failed refund op 是确定性拒绝（refundGenerationBilling 直接短路），再捞起来只会
  // 30s 死循环刷日志。回归针：扫描查询只能选 status='pending'，且 failed op 不触发 refund。
  const calls: Call[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join(" "), values });
    return [];
  }) as unknown as GenerationSql;

  let refundCalled = 0;
  const count = await retryStrandedRefundOperations({
    executorId: "worker-a",
    adapter: {
      reserve: async () => {},
      refund: async () => { refundCalled += 1; },
    },
    sql,
  });

  const scan = calls.find((call) => call.sql.includes("refund_op.amount AS refund_amount"));
  assert.ok(scan, "stranded refund scan query should run");
  assert.ok(scan.sql.includes("refund_op.status = 'pending'"), "scan must select only pending refund ops");
  assert.ok(!scan.sql.includes("'pending', 'failed'"), "scan must not include failed refund ops");
  assert.equal(count, 0, "no candidates -> no retries");
  assert.equal(refundCalled, 0, "failed refund op must never reach the external refund adapter");
});

