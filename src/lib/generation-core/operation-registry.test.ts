import assert from "node:assert/strict";
import test from "node:test";

import { MAX_CALLBACK_DELIVERY_ATTEMPTS, planCallbackDeliveryReplay } from "./callback-outbox.ts";
import {
  DEFAULT_DENY_REPLAY_POLICY,
  isRegisteredReplayOperation,
  planBillingAttemptReplay,
  planGenerationAttemptReplay,
  planReplay,
  REPLAY_REGISTRY,
  replayOperationForJobKind,
  resolveReplayPolicy,
} from "./operation-registry.ts";
import { planReconcilePollReplay } from "./provider-reconciliation.ts";
import type { GenerationKind } from "./types.ts";

const ALL_KINDS: GenerationKind[] = ["image_generate", "image_edit", "video_generate", "tts", "avatar", "lipsync"];

/**
 * 对抗性注入：型别上看似合法的入参，执行期夹带产品分类／呼叫方预算。
 * 用来断言「这些东西不参与裁决」——不是查常数，是看决策有没有被改变。
 */
function withInjectedProductFields<T extends object>(input: T, extra: Record<string, unknown>): T {
  return { ...input, ...extra } as T;
}

test("FG-02：未宣告的动作 → 自动重放被拒（走 worker 的真实调用路径，不是查常数）", () => {
  // 真实路径：worker 用 planGenerationAttemptReplay 裁决换道重放。
  const unknownKind = planGenerationAttemptReplay({ kind: "image_upscale_v2" as GenerationKind, lastAttemptNo: 0 });
  assert.equal(unknownKind.allowed, false);
  assert.equal(unknownKind.denialReason, "unregistered_operation");
  assert.equal(unknownKind.operation, "generation.image_upscale_v2");
  assert.equal(unknownKind.maxReplayAttempts, 0);
  assert.equal(unknownKind.policy, DEFAULT_DENY_REPLAY_POLICY);

  // 未宣告的任意动作键同样被拒。
  const unknownOp = planReplay({ operation: "billing.void_invoice", nextAttemptNo: 1 });
  assert.equal(unknownOp.allowed, false);
  assert.equal(unknownOp.denialReason, "unregistered_operation");
  assert.equal(resolveReplayPolicy("billing.void_invoice").allowAutoReplay, false);
});

test("FG-02：已宣告允许的动作可重放；宣告禁止的动作被拒（各一例）", () => {
  const allowed = planGenerationAttemptReplay({ kind: "image_generate", lastAttemptNo: 0 });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.denialReason, null);
  assert.equal(allowed.operation, "generation.image_generate");

  const forbidden = planReplay({ operation: "agent.steer_deliver", nextAttemptNo: 1 });
  assert.equal(forbidden.allowed, false);
  assert.equal(forbidden.denialReason, "auto_replay_disabled");
  assert.equal(forbidden.maxReplayAttempts, 0);
});

test("FG-02/03 对抗性：把产品分类/类别塞进裁决输入，重放许可不得改变", () => {
  // 产品说「不可重试」（content_rejected: retryable=false, switchSupplier=false），
  // registry 说该动作可重放 → registry 胜（产品分类不参与裁决）。
  const productSaysNo = planGenerationAttemptReplay(withInjectedProductFields(
    { kind: "image_generate" as GenerationKind, lastAttemptNo: 0 },
    { failureClass: "content_rejected", retryable: false, switchSupplier: false, category: "CONTENT" },
  ));
  assert.equal(productSaysNo.allowed, true);

  // 反例：产品说「可重试」，但动作在 registry 里是禁的 → 拒绝。
  const productSaysYes = planReplay(withInjectedProductFields(
    { operation: "agent.steer_deliver", nextAttemptNo: 1 },
    { failureClass: "overloaded", retryable: true, switchSupplier: true },
  ));
  assert.equal(productSaysYes.allowed, false);
  assert.equal(productSaysYes.denialReason, "auto_replay_disabled");

  // 产品分类也不得影响预算判定。
  const atBudget = planGenerationAttemptReplay(withInjectedProductFields(
    { kind: "image_generate" as GenerationKind, lastAttemptNo: 20 },
    { retryable: true, failureClass: "overloaded" },
  ));
  assert.equal(atBudget.allowed, false);
  assert.equal(atBudget.denialReason, "attempt_budget_exhausted");
});

test("FG-03：呼叫方自带的重试次数/预算一律无效，重放次数由 registry 决定", () => {
  // 8 = 本刀动手前的生产常数（callback-outbox 的 MAX_CALLBACK_DELIVERY_ATTEMPTS），
  // 用它当 oracle（动手前的既知事实），而不是读被测实现算出来的值。
  const HISTORICAL_PRODUCTION_BUDGET = 8;

  const plan = planReplay(withInjectedProductFields(
    { operation: "callback.deliver", nextAttemptNo: 2 },
    { maxAttempts: 999, retries: 999, retryCount: 999, maxReplayAttempts: 999 },
  ));
  assert.equal(plan.allowed, true);
  assert.equal(plan.maxReplayAttempts, HISTORICAL_PRODUCTION_BUDGET, "呼叫方注入的预算必须被忽略");

  // 注入更大的预算也无法让超额重放过关：第 9 次投递仍被拒（registry 预算 8）。
  const ninth = planReplay(withInjectedProductFields(
    { operation: "callback.deliver", nextAttemptNo: HISTORICAL_PRODUCTION_BUDGET + 1 },
    { maxAttempts: 999, maxReplayAttempts: 999 },
  ));
  assert.equal(ninth.allowed, false);
  assert.equal(ninth.denialReason, "attempt_budget_exhausted");

  // 生产常量本身已是 registry 查询（一致性探针，不计入行为已验证）。
  assert.equal(MAX_CALLBACK_DELIVERY_ATTEMPTS, HISTORICAL_PRODUCTION_BUDGET);
  assert.equal(planCallbackDeliveryReplay(HISTORICAL_PRODUCTION_BUDGET).allowed, true);
  assert.equal(planCallbackDeliveryReplay(HISTORICAL_PRODUCTION_BUDGET + 1).allowed, false);
});

test("FG-02：原生硬停（400/422/451）拒绝重放；暂时性原生状态照旧允许", () => {
  const legal = planGenerationAttemptReplay({
    kind: "image_generate",
    lastAttemptNo: 0,
    nativeFailure: { name: "SupplierRequestError", message: "legal_error", status: 451 },
  });
  assert.equal(legal.allowed, false);
  assert.equal(legal.denialReason, "native_hard_stop");
  assert.equal(legal.hardStop?.status, 451);

  const invalidRequest = planGenerationAttemptReplay({
    kind: "video_generate",
    lastAttemptNo: 0,
    nativeFailure: { name: "SupplierRequestError", message: "invalid prompt", status: 422 },
  });
  assert.equal(invalidRequest.allowed, false);
  assert.equal(invalidRequest.denialReason, "native_hard_stop");

  // 402 = 暴君 2026-08-29 裁定 fail-fast（上游欠费重试无意义，立刻诚实失败＋退款；
  // 裁定原文见 failure-classifier.ts 的 quota_exhausted 分支）。D-4：registry 化不得
  // 静默把它改判成「可换道重放」——重放到预算/deadline 才退款是行为增量，且延后退款。
  const quota = planGenerationAttemptReplay({
    kind: "video_generate",
    lastAttemptNo: 0,
    nativeFailure: { name: "SupplierRequestError", message: "H3 积分余额不足 (1008)", status: 402 },
  });
  assert.equal(quota.allowed, false, "402 必须 fail-fast（08-29 裁定）");
  assert.equal(quota.denialReason, "native_hard_stop");
  assert.equal(quota.hardStop?.status, 402);

  // 429/503 等是暂时性原生状态：仍可换渠道重放（硬停只认确定性失败）。
  for (const status of [429, 500, 503, 408, 404, 401]) {
    const transient = planGenerationAttemptReplay({
      kind: "image_generate",
      lastAttemptNo: 0,
      nativeFailure: { name: "SupplierRequestError", message: `upstream ${status}`, status },
    });
    assert.equal(transient.allowed, true, `status=${status} 应允许换渠道重放`);
  }

  // 没有原生状态（词表猜出来的错，上游没给 status）不得被硬停挡掉。
  const noStatus = planGenerationAttemptReplay({
    kind: "image_generate",
    lastAttemptNo: 0,
    nativeFailure: { name: "Error", message: "451 unavailable for legal reasons", status: null },
  });
  assert.equal(noStatus.allowed, true);
});

test("FG-02：重放预算耗尽即拒（两个真实调用路径各一例）", () => {
  const generationAtBudget = planGenerationAttemptReplay({ kind: "tts", lastAttemptNo: 20 });
  assert.equal(generationAtBudget.allowed, false);
  assert.equal(generationAtBudget.denialReason, "attempt_budget_exhausted");
  assert.equal(generationAtBudget.nextAttemptNo, 21);
  assert.equal(planGenerationAttemptReplay({ kind: "tts", lastAttemptNo: 19 }).allowed, true);

  // provider.reconcile_poll 上限 128：24h 窗口最多只能喂约 99 次轮询
  // （60s 起指数退避到 15min 上限），故天花板不会先于窗口绑定。
  assert.equal(resolveReplayPolicy("provider.reconcile_poll").maxReplayAttempts, 128);
  assert.equal(planReconcilePollReplay(129).allowed, false);
  assert.equal(planReconcilePollReplay(129).denialReason, "attempt_budget_exhausted");
  assert.equal(planReconcilePollReplay(99).allowed, true);
  assert.equal(planReconcilePollReplay(1).allowed, true);
});

test("FG-b：只宣告未接线的两项已移除，三条计费政策改为已接线（不留误导性宣告）", () => {
  // supplier.health_refresh / account.recharge_ingest 是**节奏驱动的观察/入帐回圈**
  // （30s／10min 到点就跑），不是「失败动作的重放」：registry 的尝试序号模型表达不了
  // 节奏，宣告只会变成假契约（adjudicator:"none" + enforced:false）。
  for (const key of ["supplier.health_refresh", "account.recharge_ingest"]) {
    assert.equal(isRegisteredReplayOperation(key), false, `${key} 不得再宣告`);
    assert.equal(resolveReplayPolicy(key), DEFAULT_DENY_REPLAY_POLICY);
  }
  assert.equal(isRegisteredReplayOperation("generation.image_generate"), true, "生成族宣告不得被误删");

  // 计费三动作改为已接线，且各在自己的裁决落点。
  assert.deepEqual(
    ["billing.reserve", "billing.commit", "billing.refund"].map((key) => [key, resolveReplayPolicy(key).enforced]),
    [["billing.reserve", true], ["billing.commit", true], ["billing.refund", true]],
  );
  assert.equal(resolveReplayPolicy("billing.reserve").adjudicator, "billing-ledger");
  assert.equal(resolveReplayPolicy("billing.refund").adjudicator, "billing-ledger");
  assert.equal(resolveReplayPolicy("billing.commit").adjudicator, "billing-projection");
});

test("FG-b：billing 裁决只认 billing.* 三键（别族政策不得被借走；序号非法 fail closed）", () => {
  const unknown = planBillingAttemptReplay({ operation: "billing.void_invoice", nextAttemptNo: 1 });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.denialReason, "unregistered_operation");

  const borrowed = planBillingAttemptReplay({ operation: "generation.image_generate", nextAttemptNo: 1 });
  assert.equal(borrowed.allowed, false, "生成族政策不得被计费裁决借走");
  assert.equal(borrowed.maxReplayAttempts, 0);
  assert.equal(borrowed.policy, DEFAULT_DENY_REPLAY_POLICY);

  for (const ordinal of [undefined, null, Number.NaN, 0, -1]) {
    const plan = planBillingAttemptReplay({ operation: "billing.refund", nextAttemptNo: ordinal });
    assert.equal(plan.allowed, false, `nextAttemptNo=${String(ordinal)} 必须 fail closed`);
    assert.equal(plan.denialReason, "invalid_attempt_ordinal");
  }

  // 呼叫方自带预算无效：registry 的 64 才是唯一来源。
  const injected = planBillingAttemptReplay(
    withInjectedProductFields({ operation: "billing.reserve", nextAttemptNo: 65 }, { maxAttempts: 999, maxReplayAttempts: 999 }),
  );
  assert.equal(injected.allowed, false);
  assert.equal(injected.denialReason, "attempt_budget_exhausted");
  assert.equal(injected.maxReplayAttempts, 64);
});

test("探针：registry 封闭性与政策自洽（不计入行为已验证）", () => {
  for (const kind of ALL_KINDS) {
    const operation = replayOperationForJobKind(kind);
    assert.equal(isRegisteredReplayOperation(operation), true, `${kind} → ${operation} 必须已宣告`);
  }
  assert.equal(isRegisteredReplayOperation("generation.image_upscale_v2"), false);

  for (const [key, policy] of Object.entries(REPLAY_REGISTRY)) {
    assert.equal(policy.key, key, `${key} 的 key 栏位必须与键一致`);
    assert.ok(policy.reason.length > 10, `${key} 必须有可审查的理由`);
    if (!policy.allowAutoReplay) assert.equal(policy.maxReplayAttempts, 0, `${key} 禁止重放时预算必须为 0`);
    if (policy.adjudicator === "none") assert.equal(policy.enforced, false, `${key} 无裁决落点时不得宣称已接线`);
    if (policy.adjudicator !== "none" && policy.allowAutoReplay && policy.key.startsWith("generation.")) {
      assert.ok((policy.hardStops ?? []).length > 0, `${key} 生成动作必须宣告原生硬停`);
    }
  }
});

test("FG-02/03 对抗性：原型键/非法序号不得捡到政策或放行重放", () => {
  // 捡原型成员的路径（constructor/toString/__proto__）必须走 default-deny，
  // 而不是拿到 Object.prototype 上的东西。
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.equal(resolveReplayPolicy(key), DEFAULT_DENY_REPLAY_POLICY, `${key} 必须 default-deny`);
    const plan = planReplay({ operation: key, nextAttemptNo: 1 });
    assert.equal(plan.allowed, false);
    assert.equal(plan.denialReason, "unregistered_operation");
  }

  // 尝试序号算不出来（NaN/undefined/0/负数）→ fail closed，不得被当成第 1 次而放行。
  for (const ordinal of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -3, "3" as unknown as number]) {
    const plan = planReplay({ operation: "generation.image_generate", nextAttemptNo: ordinal });
    assert.equal(plan.allowed, false, `nextAttemptNo=${String(ordinal)} 必须拒绝`);
    assert.equal(plan.denialReason, "invalid_attempt_ordinal");
  }

  // 空字串/物件动作键同样被拒（不得因 String() 转换而误中已宣告动作）。
  assert.equal(planReplay({ operation: "", nextAttemptNo: 1 }).allowed, false);
  assert.equal(planReplay({ operation: {} as unknown as string, nextAttemptNo: 1 }).allowed, false);

  // 原生状态用字串写的 451 仍算硬停（上游 body 原样保留时状态常是字串）。
  const stringStatus = planGenerationAttemptReplay({
    kind: "image_generate",
    lastAttemptNo: 0,
    nativeFailure: { name: "SupplierRequestError", message: "legal_error", status: "451" },
  });
  assert.equal(stringStatus.allowed, false);
  assert.equal(stringStatus.denialReason, "native_hard_stop");
});

test("FG-03：对帐轮询的呼叫方不再能传重试次数（型别面 + 执行面）", async () => {
  const { runProviderReconciliation } = await import("./provider-reconciliation.ts");
  const emptySql = (async () => []) as unknown as Parameters<typeof runProviderReconciliation>[0]["sql"];
  const input = {
    executorId: "reconcile:test",
    // @ts-expect-error maxAttempts 已从入参移除（FG-03：呼叫方不得传 retry 次数）
    maxAttempts: 999,
    sql: emptySql,
  };
  // 执行面：多传的栏位被忽略，整轮仍然正常收敛（0 笔到期）。
  const summary = await runProviderReconciliation(input);
  assert.deepEqual(summary, { claimed: 0, delivered: 0, confirmedFailed: 0, exhausted: 0, pollErrors: 0 });
});
