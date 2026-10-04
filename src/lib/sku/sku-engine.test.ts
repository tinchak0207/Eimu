// SKU 展开与 run 视图的确定性锁——纯函数测试（无 DB/env 依赖）。
//
// 这些测试锁的是 B 端契约的核心性质：同一份输入永远展开出逐字节相同的镜头
// 计划（prompt/顺序/数量），缺参数报可判等错误码，角度轮换按池取模循环。

import test from "node:test";
import assert from "node:assert/strict";

import { SKU_CATALOG, VARIANT_ANGLE_POOL, getSkuById } from "./catalog.ts";
import { expandSkuShots, renderPromptTemplate } from "./expand.ts";
import type { GenerationJob } from "../generation-core/types.ts";
import {
  buildSkuRunStatusView,
  buildSkuShotCommandPlans,
  generateRunId,
  normalizeRunId,
  shotIndexFromIdempotencyKey,
  skuRunIdempotencyKey,
} from "./run-service.ts";
import { QUOTA_PER_COIN } from "../quota-constants.ts";

const ECOM = getSkuById("sku-ecommerce-15s")!;
const PAIN = getSkuById("sku-pain-point-ad")!;
const ANGLE = getSkuById("sku-multi-angle")!;

// ─────────────────────────────────────────── 电商带货 15s

test("ecommerce sku expands to adaptive shot plan by selling point count", () => {
  const two = expandSkuShots(ECOM, {
    product: "轻量折叠登机箱 20 寸",
    selling_points: ["整机仅 2.6kg", "一键前开盖秒取电脑"],
  });
  assert.equal(two.ok, true);
  if (!two.ok) return;
  assert.deepEqual(
    two.shots.map((shot) => shot.shotId),
    ["hook", "feature-1", "feature-2", "scene-demo", "cta"],
  );
  // 4-6 镜头随卖点数自适应
  assert.equal(expandSkuShots(ECOM, { product: "x", selling_points: ["a"] }).shots?.length, 4);
  assert.equal(
    expandSkuShots(ECOM, { product: "x", selling_points: ["a", "b", "c"] }).shots?.length,
    6,
  );
});

test("ecommerce prompts inject product and per-index selling point variables", () => {
  const result = expandSkuShots(ECOM, {
    product: "轻量折叠登机箱",
    selling_points: ["整机仅 2.6kg", "静音万向轮"],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const [hook, feature1, feature2] = result.shots;
  assert.match(hook.prompt, /轻量折叠登机箱/);
  assert.match(feature1.prompt, /整机仅 2\.6kg/);
  assert.match(feature1.prompt, /轻量折叠登机箱/);
  assert.match(feature2.prompt, /静音万向轮/);
  // 模板变量必须全部被替换——不留 {{...}} 进生成 prompt
  for (const shot of result.shots) {
    assert.equal(shot.prompt.includes("{{"), false, shot.shotId + " 残留未展开变量");
  }
});

test("ecommerce missing required fields produce param-addressed errors", () => {
  const noProduct = expandSkuShots(ECOM, { selling_points: ["a"] });
  assert.equal(noProduct.ok, false);
  if (noProduct.ok) return;
  assert.equal(noProduct.issues[0].code, "missing_field");
  assert.equal(noProduct.issues[0].param, "product");

  const noPoints = expandSkuShots(ECOM, { product: "x" });
  assert.equal(noPoints.ok, false);
  if (noPoints.ok) return;
  assert.equal(noPoints.issues.some((item) => item.param === "selling_points"), true);
});

test("ecommerce rejects selling point lists beyond schema max", () => {
  const result = expandSkuShots(ECOM, {
    product: "x",
    selling_points: ["a", "b", "c", "d"],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issues[0].code, "invalid_field");
  assert.equal(result.issues[0].param, "selling_points");
});

// ─────────────────────────────────────────── 痛点广告

test("pain point sku always expands to the five-act structure", () => {
  const result = expandSkuShots(PAIN, {
    pain_point: "行李箱轮子噪音大",
    solution: "静音万向轮行李箱",
    audience: "通勤上班族",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.shots.map((shot) => shot.shotId),
    ["problem-hook", "amplify", "turn", "proof", "cta"],
  );
  for (const shot of result.shots) {
    assert.equal(shot.prompt.includes("{{"), false);
  }
  assert.match(result.shots[2].prompt, /静音万向轮行李箱/);
});

test("pain point sku errors on missing audience", () => {
  const result = expandSkuShots(PAIN, { pain_point: "p", solution: "s" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issues.some((item) => item.param === "audience"), true);
});

// ─────────────────────────────────────────── 多角度变体（轮换注入）

test("multi-angle sku defaults to 3 variants injected from rotation pools", () => {
  const result = expandSkuShots(ANGLE, { base_subject: "磨砂黑便携保温杯" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.shots.length, 3);
  for (let i = 0; i < 3; i += 1) {
    assert.match(result.shots[i].prompt, /磨砂黑便携保温杯/);
    assert.match(result.shots[i].prompt, new RegExp(VARIANT_ANGLE_POOL[i]));
  }
  assert.equal(result.shots.some((shot) => shot.prompt.includes("{{")), false);
});

test("multi-angle rotation cycles custom angle pools by index modulo", () => {
  const result = expandSkuShots(ANGLE, {
    base_subject: "保温杯",
    variant_count: 3,
    angles: ["仰视英雄视角", "平贴桌面俯拍"],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // 自定义角度池 2 档循环：[0,1,0]
  assert.match(result.shots[0].prompt, /仰视英雄视角/);
  assert.match(result.shots[1].prompt, /平贴桌面俯拍/);
  assert.match(result.shots[2].prompt, /仰视英雄视角/);
  // 光线仍按内建池轮换（0/1/2 各不相同）
  assert.notEqual(result.shots[0].prompt, result.shots[1].prompt);
});

test("multi-angle sku validates variant_count bounds", () => {
  assert.equal(expandSkuShots(ANGLE, { base_subject: "x", variant_count: 0 }).ok, false);
  assert.equal(expandSkuShots(ANGLE, { base_subject: "x", variant_count: 9 }).ok, false);
  assert.equal(expandSkuShots(ANGLE, { base_subject: "x", variant_count: 2.5 }).ok, false);
});

test("sku expansion is deterministic for identical inputs", () => {
  const input = { base_subject: "磨砂黑便携保温杯", variant_count: 5 };
  assert.deepEqual(expandSkuShots(ANGLE, input), expandSkuShots(ANGLE, input));
  const ecomInput = { product: "登机箱", selling_points: ["轻", "静音轮"] };
  assert.deepEqual(expandSkuShots(ECOM, ecomInput), expandSkuShots(ECOM, ecomInput));
});

test("catalog exposes exactly the three launch SKUs with honest image-kind output", () => {
  assert.deepEqual(
    SKU_CATALOG.map((sku) => sku.id),
    ["sku-ecommerce-15s", "sku-pain-point-ad", "sku-multi-angle"],
  );
  for (const sku of SKU_CATALOG) {
    assert.equal(sku.outputSpec.kind, "image");
    assert.equal(sku.expansion, "deterministic");
    assert.equal(sku.pricingMode, "per_shot");
  }
});

// ─────────────────────────────────────────── 模板变量渲染

test("renderPromptTemplate replaces repeated variables and rejects unknown ones", () => {
  const ok = renderPromptTemplate("{{a}} 和 {{a}} 与 {{b}}", { a: "甲", b: "乙" });
  assert.deepEqual(ok, { prompt: "甲 和 甲 与 乙" });
  const missing = renderPromptTemplate("{{a}} {{c}}", { a: "甲" });
  assert.equal("error" in missing, true);
});

// ─────────────────────────────────────────── run 幂等键与 run_id

test("run idempotency keys round-trip shot indexes", () => {
  const key = skuRunIdempotencyKey("skurun_abc", 7);
  assert.equal(key, "skurun:skurun_abc:7");
  assert.equal(shotIndexFromIdempotencyKey(key), 7);
  assert.equal(shotIndexFromIdempotencyKey("batch:other:1"), null);
  assert.equal(shotIndexFromIdempotencyKey(null), null);
});

test("normalizeRunId enforces the safe charset", () => {
  assert.equal(normalizeRunId("skurun_abc").ok, true);
  assert.equal(normalizeRunId("run-12345").ok, true);
  assert.equal(normalizeRunId("short").ok, false);
  assert.equal(normalizeRunId("has space in it").ok, false);
  assert.equal(normalizeRunId("%LIKE%inject").ok, false);
  const generated = generateRunId();
  assert.equal(normalizeRunId(generated).ok, true, generated);
});

// ─────────────────────────────────────────── 镜头 → 提交计划

test("buildSkuShotCommandPlans maps aspect ratio to size and prices per shot", () => {
  const expansion = expandSkuShots(ANGLE, { base_subject: "保温杯", variant_count: 2 });
  assert.equal(expansion.ok, true);
  if (!expansion.ok) return;
  const plans = buildSkuShotCommandPlans(ANGLE, expansion.shots, { runId: "skurun_test", modelId: "gpt-image-2" });
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    assert.equal(plan.kind, "image_generate");
    assert.equal(plan.size, "1024x1024"); // 1:1 → 1024x1024
    assert.equal(plan.ratio, "1:1");
    assert.equal(plan.workflow.metadata?.sku?.runId, "skurun_test");
    // 幂等键不进计划——由发射器按 run_id + shot_index 派生（见 skuRunIdempotencyKey）
  }
  // gpt-image-2 1k fast = 1 币/张
  assert.equal(plans[0].billingAmount, 1 * QUOTA_PER_COIN);
});

test("buildSkuShotCommandPlans maps 9:16 storyboard shots to portrait size", () => {
  const expansion = expandSkuShots(ECOM, { product: "登机箱", selling_points: ["轻"] });
  assert.equal(expansion.ok, true);
  if (!expansion.ok) return;
  const plans = buildSkuShotCommandPlans(ECOM, expansion.shots, { runId: "r", modelId: "gpt-image-2" });
  for (const plan of plans) {
    assert.equal(plan.size, "1024x1792");
    assert.equal(plan.ratio, "9:16");
  }
});

// ─────────────────────────────────────────── run 聚合视图

function fakeJob(
  overrides: Partial<GenerationJob> & Pick<GenerationJob, "id" | "idempotencyKey" | "status" | "billingAmount">,
): GenerationJob {
  const now = new Date("2026-08-21T00:00:00Z");
  return {
    tenantId: "biz:key",
    apiKeyId: "key",
    billingUserId: 1,
    source: "biz",
    requestHash: "hash",
    kind: "image_generate",
    routingClass: "generic",
    modelId: "gpt-image-2",
    size: "1024x1024",
    ratio: "1:1",
    resolution: "1k",
    quality: "fast",
    promptCiphertext: "cipher",
    workflow: { metadata: { sku: { skuId: "sku-multi-angle", runId: "r", shotIndex: 0, shotId: "variant-1" } } },
    responseFormat: "url",
    callbackUrl: null,
    retryOfTaskId: null,
    primaryResultId: null,
    requestedCount: 1,
    completedCount: 0,
    attemptCount: 0,
    deadlineAt: now,
    availableAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    failureClass: null,
    failureDetail: null,
    result: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

test("buildSkuRunStatusView aggregates counts, billing and shot order", () => {
  const jobs: GenerationJob[] = [
    fakeJob({
      id: "task-succeeded",
      idempotencyKey: "skurun:r:0",
      status: "succeeded",
      billingAmount: 500_000,
      primaryResultId: "art-1",
    }),
    fakeJob({
      id: "task-queued",
      idempotencyKey: "skurun:r:1",
      status: "queued",
      billingAmount: 500_000,
    }),
    fakeJob({
      id: "task-failed",
      idempotencyKey: "skurun:r:10",
      status: "failed",
      billingAmount: 500_000,
      failureClass: "upstream_failed",
      failureDetail: "boom",
    }),
  ];
  const view = buildSkuRunStatusView("r", jobs);
  assert.equal(view.object, "sku.run.status");
  assert.equal(view.sku_id, "sku-multi-angle");
  assert.equal(view.all_terminal, false);
  assert.equal(view.counts.total, 3);
  assert.equal(view.counts.succeeded, 1);
  assert.equal(view.counts.pending, 1);
  assert.equal(view.counts.failed, 1);
  assert.equal(view.billing.charged_total, 500_000);
  assert.equal(view.billing.refunded_total, 500_000);
  assert.equal(view.billing.pending_total, 500_000);
  // shot_index >= 10 的任务按数字序排在 1 之后（不是字典序的 0,1,10）
  assert.deepEqual(
    view.items.map((item) => item.shot_index),
    [0, 1, 10],
  );
  assert.equal(view.items[0].result_url, "/v1/images/task-succeeded/result");
  assert.equal(view.items[1].result_url, null);
  assert.equal(view.items[2].failure_class, "upstream_failed");
});

test("buildSkuRunStatusView reports completed when all shots are terminal", () => {
  const jobs: GenerationJob[] = [
    fakeJob({ id: "a", idempotencyKey: "skurun:r:0", status: "succeeded", billingAmount: 100 }),
    fakeJob({ id: "b", idempotencyKey: "skurun:r:1", status: "refunded", billingAmount: 100 }),
  ];
  const view = buildSkuRunStatusView("r", jobs);
  assert.equal(view.all_terminal, true);
  assert.equal(view.status, "completed");
});
