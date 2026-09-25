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
 * 對抗性注入：型別上看似合法的入參，執行期夾帶產品分類／呼叫方預算。
 * 用來斷言「這些東西不參與裁決」——不是查常數，是看決策有沒有被改變。
 */
function withInjectedProductFields<T extends object>(input: T, extra: Record<string, unknown>): T {
  return { ...input, ...extra } as T;
}

test("FG-02：未宣告的動作 → 自動重放被拒（走 worker 的真實調用路徑，不是查常數）", () => {
  // 真實路徑：worker 用 planGenerationAttemptReplay 裁決換道重放。
  const unknownKind = planGenerationAttemptReplay({ kind: "image_upscale_v2" as GenerationKind, lastAttemptNo: 0 });
  assert.equal(unknownKind.allowed, false);
  assert.equal(unknownKind.denialReason, "unregistered_operation");
  assert.equal(unknownKind.operation, "generation.image_upscale_v2");
  assert.equal(unknownKind.maxReplayAttempts, 0);
  assert.equal(unknownKind.policy, DEFAULT_DENY_REPLAY_POLICY);

  // 未宣告的任意動作鍵同樣被拒。
  const unknownOp = planReplay({ operation: "billing.void_invoice", nextAttemptNo: 1 });
  assert.equal(unknownOp.allowed, false);
  assert.equal(unknownOp.denialReason, "unregistered_operation");
  assert.equal(resolveReplayPolicy("billing.void_invoice").allowAutoReplay, false);
});

test("FG-02：已宣告允許的動作可重放；宣告禁止的動作被拒（各一例）", () => {
  const allowed = planGenerationAttemptReplay({ kind: "image_generate", lastAttemptNo: 0 });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.denialReason, null);
  assert.equal(allowed.operation, "generation.image_generate");

  const forbidden = planReplay({ operation: "agent.steer_deliver", nextAttemptNo: 1 });
  assert.equal(forbidden.allowed, false);
  assert.equal(forbidden.denialReason, "auto_replay_disabled");
  assert.equal(forbidden.maxReplayAttempts, 0);
});

test("FG-02/03 對抗性：把產品分類/類別塞進裁決輸入，重放許可不得改變", () => {
  // 產品說「不可重試」（content_rejected: retryable=false, switchSupplier=false），
  // registry 說該動作可重放 → registry 勝（產品分類不參與裁決）。
  const productSaysNo = planGenerationAttemptReplay(withInjectedProductFields(
    { kind: "image_generate" as GenerationKind, lastAttemptNo: 0 },
    { failureClass: "content_rejected", retryable: false, switchSupplier: false, category: "CONTENT" },
  ));
  assert.equal(productSaysNo.allowed, true);

  // 反例：產品說「可重試」，但動作在 registry 裡是禁的 → 拒絕。
  const productSaysYes = planReplay(withInjectedProductFields(
    { operation: "agent.steer_deliver", nextAttemptNo: 1 },
    { failureClass: "overloaded", retryable: true, switchSupplier: true },
  ));
  assert.equal(productSaysYes.allowed, false);
  assert.equal(productSaysYes.denialReason, "auto_replay_disabled");

  // 產品分類也不得影響預算判定。
  const atBudget = planGenerationAttemptReplay(withInjectedProductFields(
    { kind: "image_generate" as GenerationKind, lastAttemptNo: 20 },
    { retryable: true, failureClass: "overloaded" },
  ));
  assert.equal(atBudget.allowed, false);
  assert.equal(atBudget.denialReason, "attempt_budget_exhausted");
});

test("FG-03：呼叫方自帶的重試次數/預算一律無效，重放次數由 registry 決定", () => {
  // 8 = 本刀動手前的生產常數（callback-outbox 的 MAX_CALLBACK_DELIVERY_ATTEMPTS），
  // 用它當 oracle（動手前的既知事實），而不是讀被測實現算出來的值。
  const HISTORICAL_PRODUCTION_BUDGET = 8;

  const plan = planReplay(withInjectedProductFields(
    { operation: "callback.deliver", nextAttemptNo: 2 },
    { maxAttempts: 999, retries: 999, retryCount: 999, maxReplayAttempts: 999 },
  ));
  assert.equal(plan.allowed, true);
  assert.equal(plan.maxReplayAttempts, HISTORICAL_PRODUCTION_BUDGET, "呼叫方注入的預算必須被忽略");

  // 注入更大的預算也無法讓超額重放過關：第 9 次投遞仍被拒（registry 預算 8）。
  const ninth = planReplay(withInjectedProductFields(
    { operation: "callback.deliver", nextAttemptNo: HISTORICAL_PRODUCTION_BUDGET + 1 },
    { maxAttempts: 999, maxReplayAttempts: 999 },
  ));
  assert.equal(ninth.allowed, false);
  assert.equal(ninth.denialReason, "attempt_budget_exhausted");

  // 生產常量本身已是 registry 查詢（一致性探針，不計入行為已驗證）。
  assert.equal(MAX_CALLBACK_DELIVERY_ATTEMPTS, HISTORICAL_PRODUCTION_BUDGET);
  assert.equal(planCallbackDeliveryReplay(HISTORICAL_PRODUCTION_BUDGET).allowed, true);
  assert.equal(planCallbackDeliveryReplay(HISTORICAL_PRODUCTION_BUDGET + 1).allowed, false);
});

test("FG-02：原生硬停（400/422/451）拒絕重放；暫時性原生狀態照舊允許", () => {
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

  // 402 = 暴君 2026-08-29 裁定 fail-fast（上游欠費重試無意義，立刻誠實失敗＋退款；
  // 裁定原文見 failure-classifier.ts 的 quota_exhausted 分支）。D-4：registry 化不得
  // 靜默把它改判成「可換道重放」——重放到預算/deadline 才退款是行為增量，且延後退款。
  const quota = planGenerationAttemptReplay({
    kind: "video_generate",
    lastAttemptNo: 0,
    nativeFailure: { name: "SupplierRequestError", message: "H3 积分余额不足 (1008)", status: 402 },
  });
  assert.equal(quota.allowed, false, "402 必須 fail-fast（08-29 裁定）");
  assert.equal(quota.denialReason, "native_hard_stop");
  assert.equal(quota.hardStop?.status, 402);

  // 429/503 等是暫時性原生狀態：仍可換渠道重放（硬停只認確定性失敗）。
  for (const status of [429, 500, 503, 408, 404, 401]) {
    const transient = planGenerationAttemptReplay({
      kind: "image_generate",
      lastAttemptNo: 0,
      nativeFailure: { name: "SupplierRequestError", message: `upstream ${status}`, status },
    });
    assert.equal(transient.allowed, true, `status=${status} 應允許換渠道重放`);
  }

  // 沒有原生狀態（詞表猜出來的錯，上游沒給 status）不得被硬停擋掉。
  const noStatus = planGenerationAttemptReplay({
    kind: "image_generate",
    lastAttemptNo: 0,
    nativeFailure: { name: "Error", message: "451 unavailable for legal reasons", status: null },
  });
  assert.equal(noStatus.allowed, true);
});

test("FG-02：重放預算耗盡即拒（兩個真實調用路徑各一例）", () => {
  const generationAtBudget = planGenerationAttemptReplay({ kind: "tts", lastAttemptNo: 20 });
  assert.equal(generationAtBudget.allowed, false);
  assert.equal(generationAtBudget.denialReason, "attempt_budget_exhausted");
  assert.equal(generationAtBudget.nextAttemptNo, 21);
  assert.equal(planGenerationAttemptReplay({ kind: "tts", lastAttemptNo: 19 }).allowed, true);

  // provider.reconcile_poll 上限 128：24h 窗口最多只能餵約 99 次輪詢
  // （60s 起指數退避到 15min 上限），故天花板不會先於窗口綁定。
  assert.equal(resolveReplayPolicy("provider.reconcile_poll").maxReplayAttempts, 128);
  assert.equal(planReconcilePollReplay(129).allowed, false);
  assert.equal(planReconcilePollReplay(129).denialReason, "attempt_budget_exhausted");
  assert.equal(planReconcilePollReplay(99).allowed, true);
  assert.equal(planReconcilePollReplay(1).allowed, true);
});

test("FG-b：只宣告未接線的兩項已移除，三條計費政策改為已接線（不留誤導性宣告）", () => {
  // supplier.health_refresh / account.recharge_ingest 是**節奏驅動的觀察/入帳迴圈**
  // （30s／10min 到點就跑），不是「失敗動作的重放」：registry 的嘗試序號模型表達不了
  // 節奏，宣告只會變成假契約（adjudicator:"none" + enforced:false）。
  for (const key of ["supplier.health_refresh", "account.recharge_ingest"]) {
    assert.equal(isRegisteredReplayOperation(key), false, `${key} 不得再宣告`);
    assert.equal(resolveReplayPolicy(key), DEFAULT_DENY_REPLAY_POLICY);
  }
  assert.equal(isRegisteredReplayOperation("generation.image_generate"), true, "生成族宣告不得被誤刪");

  // 計費三動作改為已接線，且各在自己的裁決落點。
  assert.deepEqual(
    ["billing.reserve", "billing.commit", "billing.refund"].map((key) => [key, resolveReplayPolicy(key).enforced]),
    [["billing.reserve", true], ["billing.commit", true], ["billing.refund", true]],
  );
  assert.equal(resolveReplayPolicy("billing.reserve").adjudicator, "billing-ledger");
  assert.equal(resolveReplayPolicy("billing.refund").adjudicator, "billing-ledger");
  assert.equal(resolveReplayPolicy("billing.commit").adjudicator, "billing-projection");
});

test("FG-b：billing 裁決只認 billing.* 三鍵（別族政策不得被借走；序號非法 fail closed）", () => {
  const unknown = planBillingAttemptReplay({ operation: "billing.void_invoice", nextAttemptNo: 1 });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.denialReason, "unregistered_operation");

  const borrowed = planBillingAttemptReplay({ operation: "generation.image_generate", nextAttemptNo: 1 });
  assert.equal(borrowed.allowed, false, "生成族政策不得被計費裁決借走");
  assert.equal(borrowed.maxReplayAttempts, 0);
  assert.equal(borrowed.policy, DEFAULT_DENY_REPLAY_POLICY);

  for (const ordinal of [undefined, null, Number.NaN, 0, -1]) {
    const plan = planBillingAttemptReplay({ operation: "billing.refund", nextAttemptNo: ordinal });
    assert.equal(plan.allowed, false, `nextAttemptNo=${String(ordinal)} 必須 fail closed`);
    assert.equal(plan.denialReason, "invalid_attempt_ordinal");
  }

  // 呼叫方自帶預算無效：registry 的 64 才是唯一來源。
  const injected = planBillingAttemptReplay(
    withInjectedProductFields({ operation: "billing.reserve", nextAttemptNo: 65 }, { maxAttempts: 999, maxReplayAttempts: 999 }),
  );
  assert.equal(injected.allowed, false);
  assert.equal(injected.denialReason, "attempt_budget_exhausted");
  assert.equal(injected.maxReplayAttempts, 64);
});

test("探針：registry 封閉性與政策自洽（不計入行為已驗證）", () => {
  for (const kind of ALL_KINDS) {
    const operation = replayOperationForJobKind(kind);
    assert.equal(isRegisteredReplayOperation(operation), true, `${kind} → ${operation} 必須已宣告`);
  }
  assert.equal(isRegisteredReplayOperation("generation.image_upscale_v2"), false);

  for (const [key, policy] of Object.entries(REPLAY_REGISTRY)) {
    assert.equal(policy.key, key, `${key} 的 key 欄位必須與鍵一致`);
    assert.ok(policy.reason.length > 10, `${key} 必須有可審查的理由`);
    if (!policy.allowAutoReplay) assert.equal(policy.maxReplayAttempts, 0, `${key} 禁止重放時預算必須為 0`);
    if (policy.adjudicator === "none") assert.equal(policy.enforced, false, `${key} 無裁決落點時不得宣稱已接線`);
    if (policy.adjudicator !== "none" && policy.allowAutoReplay && policy.key.startsWith("generation.")) {
      assert.ok((policy.hardStops ?? []).length > 0, `${key} 生成動作必須宣告原生硬停`);
    }
  }
});

test("FG-02/03 對抗性：原型鍵/非法序號不得撿到政策或放行重放", () => {
  // 撿原型成員的路徑（constructor/toString/__proto__）必須走 default-deny，
  // 而不是拿到 Object.prototype 上的東西。
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.equal(resolveReplayPolicy(key), DEFAULT_DENY_REPLAY_POLICY, `${key} 必須 default-deny`);
    const plan = planReplay({ operation: key, nextAttemptNo: 1 });
    assert.equal(plan.allowed, false);
    assert.equal(plan.denialReason, "unregistered_operation");
  }

  // 嘗試序號算不出來（NaN/undefined/0/負數）→ fail closed，不得被當成第 1 次而放行。
  for (const ordinal of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -3, "3" as unknown as number]) {
    const plan = planReplay({ operation: "generation.image_generate", nextAttemptNo: ordinal });
    assert.equal(plan.allowed, false, `nextAttemptNo=${String(ordinal)} 必須拒絕`);
    assert.equal(plan.denialReason, "invalid_attempt_ordinal");
  }

  // 空字串/物件動作鍵同樣被拒（不得因 String() 轉換而誤中已宣告動作）。
  assert.equal(planReplay({ operation: "", nextAttemptNo: 1 }).allowed, false);
  assert.equal(planReplay({ operation: {} as unknown as string, nextAttemptNo: 1 }).allowed, false);

  // 原生狀態用字串寫的 451 仍算硬停（上游 body 原樣保留時狀態常是字串）。
  const stringStatus = planGenerationAttemptReplay({
    kind: "image_generate",
    lastAttemptNo: 0,
    nativeFailure: { name: "SupplierRequestError", message: "legal_error", status: "451" },
  });
  assert.equal(stringStatus.allowed, false);
  assert.equal(stringStatus.denialReason, "native_hard_stop");
});

test("FG-03：對帳輪詢的呼叫方不再能傳重試次數（型別面 + 執行面）", async () => {
  const { runProviderReconciliation } = await import("./provider-reconciliation.ts");
  const emptySql = (async () => []) as unknown as Parameters<typeof runProviderReconciliation>[0]["sql"];
  const input = {
    executorId: "reconcile:test",
    // @ts-expect-error maxAttempts 已從入參移除（FG-03：呼叫方不得傳 retry 次數）
    maxAttempts: 999,
    sql: emptySql,
  };
  // 執行面：多傳的欄位被忽略，整輪仍然正常收斂（0 筆到期）。
  const summary = await runProviderReconciliation(input);
  assert.deepEqual(summary, { claimed: 0, delivered: 0, confirmedFailed: 0, exhausted: 0, pollErrors: 0 });
});
