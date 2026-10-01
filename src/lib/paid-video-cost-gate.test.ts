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
// 付費視頻上游硬閘（2026-09-27 ¥31.2857 事故）
// 陽性（expected-pass）：白名單 model + 顯式 ≤720p + catalog 內時長 + 已核價三元組。
// 陰性四條（缺一不可）：白名單外 model／缺 resolution／4k／未核價（未生成）三元組。
// 三元組＝catalog 生成（registry claims × catalog durations/resolutions），非手抄。
// ─────────────────────────────────────────────────────────────────────────────

test("expected-pass：白名單 model + 顯式 720p + catalog 內時長 + 已核價三元組 → 放行並回正確單價", () => {
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

test("expected-pass：每條映射 model 的 catalog 最長時長通過（10–30s 全放行，不增成本）", () => {
  // catalog 實值（現場核對，2026-09-27）：
  //   seedance-2.0      SEEDANCE_20_DURATIONS      = 10..15
  //   seedance-2.5-480p SEEDANCE_25_480P_DURATIONS = 10..30
  //   seedance-2.5-720p SEEDANCE_25_720P_DURATIONS = 10..29
  //   minimax-h3        SEEDANCE_DURATIONS         = 4..15
  const expected: Array<{ model: string; resolution: string; min: number; max: number }> = [
    { model: "seedance-2.0-900-特惠", resolution: "480p", min: 10, max: 15 },
    { model: "seedance-2.5-900-特惠", resolution: "480p", min: 10, max: 30 },
    { model: "seedance-2.5-1010-特惠", resolution: "720p", min: 10, max: 29 },
    { model: "minimax-h3-a", resolution: "720p", min: 4, max: 15 },
  ];
  for (const item of expected) {
    const entry = PAID_VIDEO_PRICED_TRIPLES.find((triple) => triple.supplierModelId === item.model);
    assert.ok(entry, `${item.model} 應有生成三元組`);
    assert.equal(Math.min(...entry!.seconds), item.min, `${item.model} 最短時長`);
    assert.equal(Math.max(...entry!.seconds), item.max, `${item.model} 最長時長`);
    assert.equal(entry!.resolutions.includes(item.resolution as never), true);
    // 最長時長本身必須通過
    const atMax = evaluatePaidVideoSubmission({
      supplierModelId: item.model,
      resolution: item.resolution,
      seconds: item.max,
    });
    assert.equal(atMax.allowed, true, `${item.model}@${item.max}s 應放行`);
  }
  assert.equal(PAID_VIDEO_MAX_SECONDS, 30);
});

test("陰性①：白名單外 model 一律拒收（含事故成因的動態價模型與被剔除檔位）", () => {
  // dreamina-seedance-2.0 = 事故當筆（6.25714288 * seconds 動態價，不在白名單）
  const offenders = [
    "dreamina-seedance-2.0",
    "seedance-2.5-3010-特惠",
    "sd-2.0-933-720-fast-原生真人",
    "seedance2.0-720-满血",
    "seedance2.0-mini-A",
    "minimax-h3-max",
    "minimax-h3-720p",
    "sd4-seedance-2.0",
    "",
  ];
  for (const model of offenders) {
    const decision = evaluatePaidVideoSubmission({ supplierModelId: model, resolution: "720p", seconds: 10 });
    assert.equal(decision.allowed, false, `model ${model} 應被拒`);
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

test("陰性②：resolution 缺省／空字串 → 拒收（上游缺省＝4k＝¥31.2857/5s）", () => {
  for (const resolution of [undefined, null, "", "   "]) {
    const decision = evaluatePaidVideoSubmission({
      supplierModelId: "seedance-2.0-900-特惠",
      resolution: resolution as string | null | undefined,
      seconds: 10,
    });
    assert.equal(decision.allowed, false, `resolution ${JSON.stringify(resolution)} 應被拒`);
    assert.equal(decision.allowed === false && decision.reason, "resolution_missing");
  }

  assert.throws(
    () => assertPaidVideoSubmissionAllowed({ supplierModelId: "seedance-2.0-900-特惠", resolution: null, seconds: 10 }),
    (error: unknown) =>
      error instanceof SupplierRequestError && error.status === 400 && error.message.includes("resolution_missing"),
  );
});

test("陰性③：4K（及 2k/1080p 等高價檔位）無條件拒收", () => {
  for (const resolution of ["4k", "2k", "1080p", "4K", "540p", "360p"]) {
    const decision = evaluatePaidVideoSubmission({
      supplierModelId: "minimax-h3-a", // 2k 等高價檔位無條件拒收
      resolution,
      seconds: 10,
    });
    assert.equal(decision.allowed, false, `resolution ${resolution} 應被拒`);
    assert.equal(decision.allowed === false && decision.reason, "resolution_not_allowed");
  }

  // ≤720p 白名單只有 480p/720p
  assert.deepEqual([...PAID_VIDEO_ALLOWED_RESOLUTIONS], ["480p", "720p"]);

  assert.throws(
    () => assertPaidVideoSubmissionAllowed({ supplierModelId: "minimax-h3-a", resolution: "4k", seconds: 10 }),
    (error: unknown) =>
      error instanceof SupplierRequestError && error.status === 400 && error.message.includes("resolution_not_allowed"),
  );
});

test("陰性④：未核價／未生成三元組拒收（含 catalog 最長時長之外、未映射 model）", () => {
  // (a) model/resolution 各自合法但組合未生成：seedance-2.5-900-特惠 只生成 480p
  const wrongResolution = evaluatePaidVideoSubmission({
    supplierModelId: "seedance-2.5-900-特惠",
    resolution: "720p",
    seconds: 10,
  });
  assert.equal(wrongResolution.allowed, false);
  assert.equal(wrongResolution.allowed === false && wrongResolution.reason, "triple_not_priced");

  // (b) 超過該 model 的 catalog 最長時長（seedance-2.0 最長 15s；16s ≤30 仍在硬上限內）
  const beyondCatalogMax = evaluatePaidVideoSubmission({
    supplierModelId: "seedance-2.0-900-特惠",
    resolution: "480p",
    seconds: 16,
  });
  assert.equal(beyondCatalogMax.allowed, false);
  assert.equal(beyondCatalogMax.allowed === false && beyondCatalogMax.reason, "triple_not_priced");

  // (c) 未映射上游 model（grok-video-1.5 在名單內但無公開 model id ⇒ 零三元組 ⇒ 拒收）
  for (const unmapped of ["grok-video-1.5", "minimax-h3-933-2k-支持真人", "seedance-2.0-933-特惠"]) {
    const verdict = evaluatePaidVideoSubmission({ supplierModelId: unmapped, resolution: "720p", seconds: 10 });
    assert.equal(verdict.allowed, false, `${unmapped} 未生成三元組應被拒`);
    assert.equal(verdict.allowed === false && verdict.reason, "triple_not_priced");
    assert.equal(PAID_VIDEO_PRICED_TRIPLES.some((triple) => triple.supplierModelId === unmapped), false);
  }
  assert.equal(PAID_VIDEO_PRICED_TRIPLES.length, 4, "只有 4 條 registry 映射生成三元組");

  // (d) seconds 硬上限 30 之外或非整數／缺省
  for (const seconds of [31, 45, 10.5, 0, -1, Number.NaN, undefined, "abc", ""]) {
    const verdict = evaluatePaidVideoSubmission({
      supplierModelId: "seedance-2.5-900-特惠",
      resolution: "480p",
      seconds: seconds as number,
    });
    assert.equal(verdict.allowed, false, `seconds ${String(seconds)} 應被拒`);
    assert.equal(verdict.allowed === false && verdict.reason, "seconds_missing_or_invalid");
  }

  assert.throws(
    () => assertPaidVideoSubmissionAllowed({ supplierModelId: "seedance-2.5-900-特惠", resolution: "720p", seconds: 10 }),
    (error: unknown) =>
      error instanceof SupplierRequestError && error.status === 400 && error.message.includes("triple_not_priced"),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 提交路徑行為驗證：拒收必須發生在 fetch（真實上游 POST）之前 ⇒ 零支出。
// V-03（2026-09-28）：閘已由 openai-video-upstream 移到生產平面 worker 的
// submitWithSupplyCostGate（取得租約後、呼叫供給前），故經 worker 入口驗證。
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

test("提交路徑：缺 resolution 的視頻請求在 fetch 之前被拒（上游拿不到缺省 4k）", async () => {
  const originalEnv = process.env.XIAOYXIAO_API_KEY;
  process.env.XIAOYXIAO_API_KEY = "test-key-not-real";
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    upstreamCalls += 1;
    throw new Error("上游不該被呼叫");
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => submitWithSupplyCostGate(fakeSupplier("seedance-2.0-900-特惠"), fakeInput(null, 10)),
      (error: unknown) =>
        error instanceof SupplierRequestError && error.status === 400 && error.message.includes("resolution_missing"),
    );
    assert.equal(upstreamCalls, 0, "缺 resolution 時不得發出任何上游請求");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.XIAOYXIAO_API_KEY;
    else process.env.XIAOYXIAO_API_KEY = originalEnv;
  }
});

test("提交路徑：4k 與白名單外 model 同樣在 fetch 之前被拒", async () => {
  const originalEnv = process.env.XIAOYXIAO_API_KEY;
  process.env.XIAOYXIAO_API_KEY = "test-key-not-real";
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    upstreamCalls += 1;
    throw new Error("上游不該被呼叫");
  }) as typeof fetch;
  try {
    await assert.rejects(() => submitWithSupplyCostGate(fakeSupplier("seedance-2.0-900-特惠"), fakeInput("4k", 10)));
    await assert.rejects(() => submitWithSupplyCostGate(fakeSupplier("dreamina-seedance-2.0"), fakeInput("720p", 10)));
    assert.equal(upstreamCalls, 0, "4k／白名單外 model 不得發出任何上游請求");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.XIAOYXIAO_API_KEY;
    else process.env.XIAOYXIAO_API_KEY = originalEnv;
  }
});

test("提交路徑 expected-pass：顯式 720p/10s 的請求把 resolution 寫進 body（不依賴上游缺省）", async () => {
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
    assert.ok(post, "應有一次 POST 提交");
    const payload = JSON.parse(post!.body) as Record<string, unknown>;
    assert.equal(payload.model, "seedance-2.0-900-特惠");
    assert.equal(payload.resolution, "720p", "resolution 必須顯式出現在 body");
    assert.equal(payload.duration, 10);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.XIAOYXIAO_API_KEY;
    else process.env.XIAOYXIAO_API_KEY = originalEnv;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 作用域：閘只審視頻。圖片路徑（4k 檔位）必須完全不受影響。
// ─────────────────────────────────────────────────────────────────────────────

test("作用域：白名單只含視頻上游 model，不含任何圖片 model id", () => {
  const imageIds = new Set<string>(SUPPORTED_IMAGE_MODEL_IDS as readonly string[]);
  for (const model of PAID_VIDEO_MODEL_WHITELIST) {
    assert.equal(imageIds.has(model), false, `白名單不得含圖片 model：${model}`);
  }
});

test("豁免作用域：退役渠道豁免，但在線/新渠道一律受閘（fail-closed，不洩漏）", () => {
  // 退役渠道（協議夾具）豁免：sd12-* 這類非白名單上游名不會被閘擋下，
  // 否則 openai-video-upstream 的協議回歸（sd4/sd7/napi/drama 請求體形狀）無法執行。
  const exempt = evaluatePaidVideoSubmission({
    supplierModelId: "sd12-seedance-2.0",
    resolution: "720p",
    seconds: 5,
    supplierId: "env:cangyuansuanli",
  });
  assert.equal(exempt.allowed, true);

  // xiaoyxiao（在線、成本閘的真正對象）：同一組參數必須被白名單擋下。
  const live = evaluatePaidVideoSubmission({
    supplierModelId: "sd12-seedance-2.0",
    resolution: "720p",
    seconds: 5,
    supplierId: "env:xiaoyxiao",
  });
  assert.equal(live.allowed, false);
  assert.equal(live.allowed === false ? live.reason : null, "model_not_whitelisted");

  // 未標明 supplierId（未來新渠道忘了帶）⇒ 同樣 fail-closed。
  const unknown = evaluatePaidVideoSubmission({
    supplierModelId: "sd12-seedance-2.0",
    resolution: "720p",
    seconds: 5,
  });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.allowed === false ? unknown.reason : null, "model_not_whitelisted");
});

test("作用域：圖片路徑 2k/4k 檔位照常通過共用歸一化（閘不進共用層）", () => {
  assert.equal(isSupportedImageModel("gpt-image-2"), true);
  // 圖片 gpt-image-2 的 catalog 檔位含 2k/4k，歸一化必須原樣保留
  for (const resolution of ["2k", "4k"] as const) {
    const normalized = normalizeGenerationConfig("gpt-image-2", { outputResolution: resolution });
    assert.equal(normalized.config.outputResolution, resolution, `圖片 ${resolution} 不得被清除`);
  }
  const whitelist = PAID_VIDEO_MODEL_WHITELIST as readonly string[];
  assert.equal(whitelist.includes("gpt-image-2"), false);
  assert.equal(whitelist.includes("seedream-5.0-lite"), false);
  assert.equal(whitelist.includes("image-5-pro"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// V-03：價格按（供給 label, 上游 model）取 claim；閘在 worker 對所有 video_generate 生效，
// 但只有 fail-closed 協議（openai_video）或白名單 model 才審。
// ─────────────────────────────────────────────────────────────────────────────

test("V-03 核價：gway 同名模型按 gway claim 價（0.6/0.8/1.5/1.0），xiaoyxiao 按自身價", () => {
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
  // 判定結果帶出的單價＝該供給的價（以 env:<label> 形狀 supplierId 推 label 亦同）。
  const viaGway = evaluatePaidVideoSubmission({ supplierModelId: "seedance-2.0-900-特惠", resolution: "720p", seconds: 10, supplierId: "env:gway" });
  assert.equal(viaGway.allowed === true && viaGway.triple?.unitCostCny, 0.6);
  const viaXiaoyxiao = evaluatePaidVideoSubmission({ supplierModelId: "seedance-2.0-900-特惠", resolution: "720p", seconds: 10, supplierLabel: "xiaoyxiao" });
  assert.equal(viaXiaoyxiao.allowed === true && viaXiaoyxiao.triple?.unitCostCny, 0.7);
});

test("V-03 兜底：claim 無價或未知供給 → 回退 PAID_VIDEO_UNIT_PRICE_CNY（兜底表保留）", () => {
  assert.equal(resolvePaidVideoUnitPrice("no-such-channel", "minimax-h3-a")?.unitCostCny, PAID_VIDEO_UNIT_PRICE_CNY["minimax-h3-a"]);
  assert.equal(resolvePaidVideoUnitPrice(null, "grok-video-1.5")?.unitCostCny, PAID_VIDEO_UNIT_PRICE_CNY["grok-video-1.5"]);
  assert.equal(resolvePaidVideoUnitPrice("gway", "dreamina-seedance-2.0"), null);
});

test("V-03 作用域：非 fail-closed 協議且 model 不在白名單 → 不審（metaso/filmera 等既有視頻路徑不被擋）", () => {
  assert.equal(enforcePaidVideoCostGate({ supplierModelId: "minimax-h3", resolution: null, seconds: null }, { failClosed: false }), null);
  assert.equal(enforcePaidVideoCostGate({ supplierModelId: "filmera-video", resolution: "1080p", seconds: 60 }, { failClosed: false }), null);
  // 同樣的非白名單 model 在 fail-closed 協議（openai_video）下照舊拒收。
  assert.throws(
    () => enforcePaidVideoCostGate({ supplierModelId: "minimax-h3", resolution: "720p", seconds: 5, supplierId: "env:xiaoyxiao" }, { failClosed: true }),
    (error: unknown) => error instanceof SupplierRequestError && error.status === 400 && error.message.includes("model_not_whitelisted"),
  );
  // 白名單 model 走非 fail-closed 協議 → 照樣套價檢（4k 拒收）。
  assert.throws(
    () => enforcePaidVideoCostGate({ supplierModelId: "seedance-2.0-900-特惠", resolution: "4k", seconds: 10 }, { failClosed: false }),
    (error: unknown) => error instanceof SupplierRequestError && error.message.includes("resolution_not_allowed"),
  );
});
