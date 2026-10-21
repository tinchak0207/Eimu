import test from "node:test";
import assert from "node:assert/strict";

import { normalizeGenerationConfig, SUPPORTED_IMAGE_MODEL_IDS, isSupportedImageModel } from "./generation-model-catalog";
import { SupplierRequestError } from "./generation-core/failure-classifier";
import { submitWithSupplyCostGate } from "./generation-core/worker-service";
import {
  PAID_VIDEO_ALLOWED_RESOLUTIONS,
  PAID_VIDEO_MAX_SECONDS,
  PAID_VIDEO_MODEL_WHITELIST,
  PAID_VIDEO_PRICED_TRIPLES,
  PAID_VIDEO_UNIT_PRICE_CNY,
  assertPaidVideoSubmissionAllowed,
  enforcePaidVideoCostGate,
  evaluatePaidVideoSubmission,
  resolvePaidVideoUnitPrice,
} from "./generation-core/paid-video-cost-gate";
import type { SupplierGenerationInput, SupplierRecord } from "./generation-core/types";

// ─────────────────────────────────────────────────────────────────────────────
// 付费视频上游硬闸（2026-09-27 ¥31.2857 事故）
// 阳性（expected-pass）：白名单 model + 显式 ≤720p + catalog 内时长 + 已核价三元组。
// 阴性四条（缺一不可）：白名单外 model／缺 resolution／4k／未核价（未生成）三元组。
// 三元组＝catalog 生成（registry claims × catalog durations/resolutions），非手抄。
// ─────────────────────────────────────────────────────────────────────────────

test("expected-pass：白名单 model + 显式 720p + catalog 内时长 + 已核价三元组 → 放行并回正确单价", () => {
  const minimax = evaluatePaidVideoSubmission({
    supplierModelId: "minimax-h3-a",
    resolution: "720p",
    seconds: 5,
  });
  assert.equal(minimax.allowed, true);
  assert.equal(minimax.allowed === true && minimax.triple.unitCostCny, 1.6);
  assert.equal(minimax.allowed === true && minimax.triple.billingBasis, "per_call");

  const seedance = evaluatePaidVideoSubmission({
    supplierModelId: "seedance-2.0-900-特惠",
    resolution: "720p",
    seconds: 10,
  });
  assert.equal(seedance.allowed, true);
  assert.equal(seedance.allowed === true && seedance.triple.unitCostCny, 0.7);

  assert.equal(
    assertPaidVideoSubmissionAllowed({ supplierModelId: "seedance-2.0-900-特惠", resolution: "480p", seconds: 12 }).unitCostCny,
    0.7,
  );
});

test("expected-pass：每条映射 model 的 catalog 最长时长通过（10–30s 全放行，不增成本）", () => {
  // catalog 实值（现场核对，2026-10-19；2026-10-18 上游改址后 minimax-h3 下限为 5s）：
  //   seedance-2.0      SEEDANCE_20_DURATIONS      = 10..15
  //   seedance-2.5-480p SEEDANCE_25_480P_DURATIONS = 10..30
  //   seedance-2.5-720p SEEDANCE_25_720P_DURATIONS = 10..29
  //   minimax-h3        MINIMAX_H3_DURATIONS       = 5..15
  const expected: Array<{ model: string; resolution: string; min: number; max: number }> = [
    { model: "seedance-2.0-900-特惠", resolution: "480p", min: 10, max: 15 },
    { model: "seedance-2.5-900-特惠", resolution: "480p", min: 10, max: 30 },
    { model: "seedance-2.5-1010-特惠", resolution: "720p", min: 10, max: 29 },
    { model: "minimax-h3-a", resolution: "720p", min: 5, max: 15 },
  ];
  for (const item of expected) {
    const entry = PAID_VIDEO_PRICED_TRIPLES.find((triple) => triple.supplierModelId === item.model);
    assert.ok(entry, `${item.model} 应有生成三元组`);
    assert.equal(Math.min(...entry!.seconds), item.min, `${item.model} 最短时长`);
    assert.equal(Math.max(...entry!.seconds), item.max, `${item.model} 最长时长`);
    assert.equal(entry!.resolutions.includes(item.resolution as never), true);
    // 最长时长本身必须通过
    const atMax = evaluatePaidVideoSubmission({
      supplierModelId: item.model,
      resolution: item.resolution,
      seconds: item.max,
    });
    assert.equal(atMax.allowed, true, `${item.model}@${item.max}s 应放行`);
  }
  assert.equal(PAID_VIDEO_MAX_SECONDS, 30);
});

test("阴性①：白名单外 model 一律拒收（含事故成因的动态价模型与被剔除档位）", () => {
  // dreamina-seedance-2.0 = 事故当笔（6.25714288 * seconds 动态价，不在白名单）
  const offenders = [
    "dreamina-seedance-2.0",
    "seedance-2.5-3010-特惠",
    "sd-2.0-933-720-fast-原生真人",
    "seedance2.0-720-满血",
    "seedance2.0-mini-A",
    "totally-unpriced-model",
    "minimax-h3-720p",
    "sd4-seedance-2.0",
    "",
  ];
  for (const model of offenders) {
    const decision = evaluatePaidVideoSubmission({ supplierModelId: model, resolution: "720p", seconds: 10 });
    assert.equal(decision.allowed, false, `model ${model} 应被拒`);
    assert.equal(decision.allowed === false && decision.reason, "model_not_whitelisted");
  }

  assert.throws(
    () => assertPaidVideoSubmissionAllowed({ supplierModelId: "dreamina-seedance-2.0", resolution: "720p", seconds: 10 }),
    (error: unknown) =>
      error instanceof SupplierRequestError
      && error.status === 400
      && error.message.includes("model_not_whitelisted"),
  );
});

test("阴性②：resolution 缺省／空字串 → 拒收（上游缺省＝4k＝¥31.2857/5s）", () => {
  for (const resolution of [undefined, null, "", "   "]) {
    const decision = evaluatePaidVideoSubmission({
      supplierModelId: "seedance-2.0-900-特惠",
      resolution: resolution as string | null | undefined,
      seconds: 10,
    });
    assert.equal(decision.allowed, false, `resolution ${JSON.stringify(resolution)} 应被拒`);
    assert.equal(decision.allowed === false && decision.reason, "resolution_missing");
  }

  assert.throws(
    () => assertPaidVideoSubmissionAllowed({ supplierModelId: "seedance-2.0-900-特惠", resolution: null, seconds: 10 }),
    (error: unknown) =>
      error instanceof SupplierRequestError && error.status === 400 && error.message.includes("resolution_missing"),
  );
});

test("阴性③：白名单外档位无条件拒收（540p/360p 等）", () => {
  // 2026-10-20 起 DMC auto-hd 实测四档全部出片，暴君明令放开 1080p/2k/4k 商品面
  // （commit 4c9eb36a）；本测试只守「白名单外档位一律拒收」这条不变式。
  for (const resolution of ["540p", "360p", "144p", "8k"]) {
    const decision = evaluatePaidVideoSubmission({
      supplierModelId: "minimax-h3-a",
      resolution,
      seconds: 10,
    });
    assert.equal(decision.allowed, false, `resolution ${resolution} 应被拒`);
    assert.equal(decision.allowed === false && decision.reason, "resolution_not_allowed");
  }

  assert.deepEqual([...PAID_VIDEO_ALLOWED_RESOLUTIONS], ["480p", "720p", "1080p", "2k", "4k"]);

  assert.throws(
    () => assertPaidVideoSubmissionAllowed({ supplierModelId: "minimax-h3-a", resolution: "540p", seconds: 10 }),
    (error: unknown) =>
      error instanceof SupplierRequestError && error.status === 400 && error.message.includes("resolution_not_allowed"),
  );
});

test("阴性④：未核价／未生成三元组拒收（含 catalog 最长时长之外、未映射 model）", () => {
  // (a) model/resolution 各自合法但组合未生成：seedance-2.5-900-特惠 只生成 480p
  const wrongResolution = evaluatePaidVideoSubmission({
    supplierModelId: "seedance-2.5-900-特惠",
    resolution: "720p",
    seconds: 10,
  });
  assert.equal(wrongResolution.allowed, false);
  assert.equal(wrongResolution.allowed === false && wrongResolution.reason, "triple_not_priced");

  // (b) 超过该 model 的 catalog 最长时长（seedance-2.0 最长 15s；16s ≤30 仍在硬上限内）
  const beyondCatalogMax = evaluatePaidVideoSubmission({
    supplierModelId: "seedance-2.0-900-特惠",
    resolution: "480p",
    seconds: 16,
  });
  assert.equal(beyondCatalogMax.allowed, false);
  assert.equal(beyondCatalogMax.allowed === false && beyondCatalogMax.reason, "triple_not_priced");

  // (c) 未映射上游 model（grok-video-1.5 在名单内但无公开 model id ⇒ 零三元组 ⇒ 拒收）
  for (const unmapped of ["grok-video-1.5", "minimax-h3-933-2k-支持真人", "seedance-2.0-933-特惠"]) {
    const verdict = evaluatePaidVideoSubmission({ supplierModelId: unmapped, resolution: "720p", seconds: 10 });
    assert.equal(verdict.allowed, false, `${unmapped} 未生成三元组应被拒`);
    assert.equal(verdict.allowed === false && verdict.reason, "triple_not_priced");
    assert.equal(PAID_VIDEO_PRICED_TRIPLES.some((triple) => triple.supplierModelId === unmapped), false);
  }
  assert.equal(PAID_VIDEO_PRICED_TRIPLES.length, 8, "当前 8 条 registry 映射生成三元组（按上游 model 去重）");

  // (d) seconds 硬上限 30 之外或非整数／缺省
  for (const seconds of [31, 45, 10.5, 0, -1, Number.NaN, undefined, "abc", ""]) {
    const verdict = evaluatePaidVideoSubmission({
      supplierModelId: "seedance-2.5-900-特惠",
      resolution: "480p",
      seconds: seconds as number,
    });
    assert.equal(verdict.allowed, false, `seconds ${String(seconds)} 应被拒`);
    assert.equal(verdict.allowed === false && verdict.reason, "seconds_missing_or_invalid");
  }

  assert.throws(
    () => assertPaidVideoSubmissionAllowed({ supplierModelId: "seedance-2.5-900-特惠", resolution: "720p", seconds: 10 }),
    (error: unknown) =>
      error instanceof SupplierRequestError && error.status === 400 && error.message.includes("triple_not_priced"),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 提交路径行为验证：拒收必须发生在 fetch（真实上游 POST）之前 ⇒ 零支出。
// V-03（2026-09-28）：闸已由 openai-video-upstream 移到生产平面 worker 的
// submitWithSupplyCostGate（取得租约后、呼叫供给前），故经 worker 入口验证。
// ─────────────────────────────────────────────────────────────────────────────

function fakeSupplier(supplierModelId: string): SupplierRecord {
  return {
    id: "env:xiaoyxiao",
    label: "xiaoyxiao",
    adapterType: "openai_video",
    supplyTier: "managed_pool",
    failureDomain: "https://api.xiaoyxiao.xyz",
    baseUrl: "https://api.xiaoyxiao.xyz/v1",
    credentialRef: "XIAOYXIAO_API_KEY",
    configuration: {},
    priority: 1,
    concurrencyLimit: 1,
    qualityScore: 1,
    unitCost: 0,
    healthStatus: "healthy",
    healthScore: 1,
    latencyEwmaMs: null,
    supplierModelId,
    capabilityId: 1,
    capabilityConcurrencyLimit: 1,
    contractVersion: 1,
    capabilityHealthStatus: "healthy",
    account: {
      id: "env:xiaoyxiao:default",
      label: "xiaoyxiao default account",
      credentialRef: "XIAOYXIAO_API_KEY",
      concurrencyLimit: 1,
      healthStatus: "healthy",
      tokenSource: "not_applicable",
      credentialExpiresAt: null,
      refreshStatus: "healthy",
      successRate5m: 1,
      healthObservedAt: new Date(),
      configuration: {},
    },
  } as SupplierRecord;
}

function fakeInput(resolution: string | null, seconds: number): SupplierGenerationInput {
  return {
    jobId: "job_gate_test",
    attemptId: "attempt_gate_test",
    modelId: "seedance-2.0",
    supplierModelId: "seedance-2.0-900-特惠",
    prompt: "a calm ocean at dawn",
    kind: "video_generate",
    size: null,
    ratio: "16:9",
    resolution,
    quality: null,
    workflow: { durationSeconds: seconds },
  };
}

test("提交路径：缺 resolution 的视频请求在 fetch 之前被拒（上游拿不到缺省 4k）", async () => {
  const originalEnv = process.env.XIAOYXIAO_API_KEY;
  process.env.XIAOYXIAO_API_KEY = "test-key-not-real";
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    upstreamCalls += 1;
    throw new Error("上游不该被呼叫");
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => submitWithSupplyCostGate(fakeSupplier("seedance-2.0-900-特惠"), fakeInput(null, 10)),
      (error: unknown) =>
        error instanceof SupplierRequestError && error.status === 400 && error.message.includes("resolution_missing"),
    );
    assert.equal(upstreamCalls, 0, "缺 resolution 时不得发出任何上游请求");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.XIAOYXIAO_API_KEY;
    else process.env.XIAOYXIAO_API_KEY = originalEnv;
  }
});

test("提交路径：4k 与白名单外 model 同样在 fetch 之前被拒", async () => {
  const originalEnv = process.env.XIAOYXIAO_API_KEY;
  process.env.XIAOYXIAO_API_KEY = "test-key-not-real";
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    upstreamCalls += 1;
    throw new Error("上游不该被呼叫");
  }) as typeof fetch;
  try {
    await assert.rejects(() => submitWithSupplyCostGate(fakeSupplier("seedance-2.0-900-特惠"), fakeInput("4k", 10)));
    await assert.rejects(() => submitWithSupplyCostGate(fakeSupplier("dreamina-seedance-2.0"), fakeInput("720p", 10)));
    assert.equal(upstreamCalls, 0, "4k／白名单外 model 不得发出任何上游请求");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.XIAOYXIAO_API_KEY;
    else process.env.XIAOYXIAO_API_KEY = originalEnv;
  }
});

test("提交路径 expected-pass：显式 720p/10s 的请求把 resolution 写进 body（不依赖上游缺省）", async () => {
  const originalEnv = process.env.XIAOYXIAO_API_KEY;
  process.env.XIAOYXIAO_API_KEY = "test-key-not-real";
  const seen: Array<{ url: string; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, body: String(init?.body ?? "") });
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ id: "task_gate_1", status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ id: "task_gate_1", status: "completed", progress: 100, url: "https://cdn.example/x.mp4" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const output = await submitWithSupplyCostGate(fakeSupplier("seedance-2.0-900-特惠"), fakeInput("720p", 10));
    assert.equal(output.url, "https://cdn.example/x.mp4");
    const post = seen.find((entry) => entry.body);
    assert.ok(post, "应有一次 POST 提交");
    const payload = JSON.parse(post!.body) as Record<string, unknown>;
    assert.equal(payload.model, "seedance-2.0-900-特惠");
    assert.equal(payload.resolution, "720p", "resolution 必须显式出现在 body");
    assert.equal(payload.duration, 10);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.XIAOYXIAO_API_KEY;
    else process.env.XIAOYXIAO_API_KEY = originalEnv;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 作用域：闸只审视频。图片路径（4k 档位）必须完全不受影响。
// ─────────────────────────────────────────────────────────────────────────────

test("作用域：白名单只含视频上游 model，不含任何图片 model id", () => {
  const imageIds = new Set<string>(SUPPORTED_IMAGE_MODEL_IDS as readonly string[]);
  for (const model of PAID_VIDEO_MODEL_WHITELIST) {
    assert.equal(imageIds.has(model), false, `白名单不得含图片 model：${model}`);
  }
});

test("白名单与已核价三元组＝生产当前真实集合（防再次删档迁就测试）", () => {
  assert.deepEqual([...PAID_VIDEO_MODEL_WHITELIST], [
    "minimax-h3-933-2k-支持真人",
    "minimax-h3-a",
    "minimax-h3-max",
    "seedance-2.0-900-特惠",
    "seedance-2.0-933-特惠",
    "seedance-2.5-1010-特惠",
    "seedance-2.5-900-特惠",
    "grok-video-1.5",
    "seedance-2.0-mini",
    "agnes-video-2.5-flash",
    "MiniMax-H3",
  ]);
  // 白名单内未映射/无 claim 的 3 条（minimax-h3-933-2k-支持真人、seedance-2.0-933-特惠、
  // grok-video-1.5）不生成三元组；其余 8 条按上游 model 去重后各一条。
  assert.deepEqual(
    [...new Set(PAID_VIDEO_PRICED_TRIPLES.map((triple) => triple.supplierModelId))].sort(),
    [
      "MiniMax-H3",
      "agnes-video-2.5-flash",
      "minimax-h3-a",
      "minimax-h3-max",
      "seedance-2.0-900-特惠",
      "seedance-2.0-mini",
      "seedance-2.5-1010-特惠",
      "seedance-2.5-900-特惠",
    ].sort(),
  );
});

test("豁免作用域：退役渠道豁免，但在线/新渠道一律受闸（fail-closed，不泄漏）", () => {
  // 退役渠道（协议夹具）豁免：sd12-* 这类非白名单上游名不会被闸挡下，
  // 否则 openai-video-upstream 的协议回归（sd4/sd7/napi/drama 请求体形状）无法执行。
  const exempt = evaluatePaidVideoSubmission({
    supplierModelId: "sd12-seedance-2.0",
    resolution: "720p",
    seconds: 5,
    supplierId: "env:cangyuansuanli",
  });
  assert.equal(exempt.allowed, true);

  // xiaoyxiao（在线、成本闸的真正对象）：同一组参数必须被白名单挡下。
  const live = evaluatePaidVideoSubmission({
    supplierModelId: "sd12-seedance-2.0",
    resolution: "720p",
    seconds: 5,
    supplierId: "env:xiaoyxiao",
  });
  assert.equal(live.allowed, false);
  assert.equal(live.allowed === false ? live.reason : null, "model_not_whitelisted");

  // 未标明 supplierId（未来新渠道忘了带）⇒ 同样 fail-closed。
  const unknown = evaluatePaidVideoSubmission({
    supplierModelId: "sd12-seedance-2.0",
    resolution: "720p",
    seconds: 5,
  });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.allowed === false ? unknown.reason : null, "model_not_whitelisted");
});

test("作用域：图片路径 2k/4k 档位照常通过共用归一化（闸不进共用层）", () => {
  assert.equal(isSupportedImageModel("gpt-image-2"), true);
  // 图片 gpt-image-2 的 catalog 档位含 2k/4k，归一化必须原样保留
  for (const resolution of ["2k", "4k"] as const) {
    const normalized = normalizeGenerationConfig("gpt-image-2", { outputResolution: resolution });
    assert.equal(normalized.config.outputResolution, resolution, `图片 ${resolution} 不得被清除`);
  }
  const whitelist = PAID_VIDEO_MODEL_WHITELIST as readonly string[];
  assert.equal(whitelist.includes("gpt-image-2"), false);
  assert.equal(whitelist.includes("seedream-5.0-lite"), false);
  assert.equal(whitelist.includes("image-5-pro"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// V-03：价格按（供给 label, 上游 model）取 claim；闸在 worker 对所有 video_generate 生效，
// 且不因协议标志放行（failClosed 已不再作为放行开关）。
// ─────────────────────────────────────────────────────────────────────────────

test("V-03 核价：gway 同名模型按 gway claim 价（0.6/0.8/1.5/1.0），xiaoyxiao 按自身价", () => {
  const gway: Array<[string, number]> = [
    ["seedance-2.0-900-特惠", 0.6],
    ["seedance-2.5-900-特惠", 0.8],
    ["seedance-2.5-1010-特惠", 1.5],
  ];
  for (const [model, price] of gway) {
    assert.equal(resolvePaidVideoUnitPrice("gway", model)?.unitCostCny, price, `gway ${model}`);
    assert.match(resolvePaidVideoUnitPrice("gway", model)?.source ?? "", /gway\.dev\/api\/pricing 2026-09-28/);
  }
  const xiaoyxiao: Array<[string, number]> = [
    ["seedance-2.0-900-特惠", 0.7],
    ["seedance-2.5-900-特惠", 0.9],
    ["seedance-2.5-1010-特惠", 1.6],
    ["minimax-h3-a", 1.6],
  ];
  for (const [model, price] of xiaoyxiao) {
    assert.equal(resolvePaidVideoUnitPrice("xiaoyxiao", model)?.unitCostCny, price, `xiaoyxiao ${model}`);
  }
  // 判定结果带出的单价＝该供给的价（以 env:<label> 形状 supplierId 推 label 亦同）。
  const viaGway = evaluatePaidVideoSubmission({ supplierModelId: "seedance-2.0-900-特惠", resolution: "720p", seconds: 10, supplierId: "env:gway" });
  assert.equal(viaGway.allowed === true && viaGway.triple?.unitCostCny, 0.6);
  const viaXiaoyxiao = evaluatePaidVideoSubmission({ supplierModelId: "seedance-2.0-900-特惠", resolution: "720p", seconds: 10, supplierLabel: "xiaoyxiao" });
  assert.equal(viaXiaoyxiao.allowed === true && viaXiaoyxiao.triple?.unitCostCny, 0.7);
});

test("V-03 兜底：claim 无价或未知供给 → 回退 PAID_VIDEO_UNIT_PRICE_CNY（兜底表保留）", () => {
  assert.equal(resolvePaidVideoUnitPrice("no-such-channel", "minimax-h3-a")?.unitCostCny, PAID_VIDEO_UNIT_PRICE_CNY["minimax-h3-a"]);
  assert.equal(resolvePaidVideoUnitPrice(null, "grok-video-1.5")?.unitCostCny, PAID_VIDEO_UNIT_PRICE_CNY["grok-video-1.5"]);
  assert.equal(resolvePaidVideoUnitPrice("gway", "dreamina-seedance-2.0"), null);
});

test("V-03 作用域：failClosed 标志不再放行，非白名单 model 一律拒收（fail-closed 不泄漏）", () => {
  // 生产现行为（paid-video-cost-gate.ts enforcePaidVideoCostGate）：无论协议标志，
  // 一律走 assertPaidVideoSubmissionAllowed；旧「非 fail-closed 协议不审」的放行语义已移除。
  assert.throws(
    () => enforcePaidVideoCostGate({ supplierModelId: "minimax-h3", resolution: null, seconds: null }, { failClosed: false }),
    (error: unknown) => error instanceof SupplierRequestError && error.status === 400 && error.message.includes("resolution_missing"),
  );
  // 1080p 自 4c9eb36a 起已进白名单；非白名单 model 仍须拒收（白名单先于时长/价检）。
  assert.throws(
    () => enforcePaidVideoCostGate({ supplierModelId: "filmera-video", resolution: "1080p", seconds: 60 }, { failClosed: false }),
    (error: unknown) => error instanceof SupplierRequestError && error.status === 400 && error.message.includes("model_not_whitelisted"),
  );
  // 同样的非白名单 model 在 fail-closed 协议（openai_video）下照旧拒收。
  assert.throws(
    () => enforcePaidVideoCostGate({ supplierModelId: "minimax-h3", resolution: "720p", seconds: 5, supplierId: "env:xiaoyxiao" }, { failClosed: true }),
    (error: unknown) => error instanceof SupplierRequestError && error.status === 400 && error.message.includes("model_not_whitelisted"),
  );
  // 白名单 model 走非 fail-closed 协议 → 照样套价检（4k 档位已开放，但该 model 未核价 ⇒ 拒收）。
  assert.throws(
    () => enforcePaidVideoCostGate({ supplierModelId: "seedance-2.0-900-特惠", resolution: "4k", seconds: 10 }, { failClosed: false }),
    (error: unknown) => error instanceof SupplierRequestError && error.message.includes("triple_not_priced"),
  );
});
