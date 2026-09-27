import test from "node:test";
import assert from "node:assert/strict";

import { normalizeGenerationConfig, SUPPORTED_IMAGE_MODEL_IDS, isSupportedImageModel } from "./generation-model-catalog";
import { SupplierRequestError } from "./generation-core/failure-classifier";
import { generateWithOpenaiVideo } from "./generation-core/openai-video-upstream";
import {
  PAID_VIDEO_ALLOWED_RESOLUTIONS,
  PAID_VIDEO_MAX_SECONDS,
  PAID_VIDEO_MODEL_WHITELIST,
  PAID_VIDEO_PRICED_TRIPLES,
  assertPaidVideoSubmissionAllowed,
  evaluatePaidVideoSubmission,
} from "./generation-core/paid-video-cost-gate";
import type { SupplierGenerationInput, SupplierRecord } from "./generation-core/types";

// ─────────────────────────────────────────────────────────────────────────────
// 付費視頻上游硬閘（2026-09-27 ¥31.2857 事故）
// 陽性（expected-pass）：白名單 model + 顯式 ≤720p + ≤5s + 已核價三元組 → 放行。
// 陰性四條（缺一不可）：白名單外 model／缺 resolution／4k／未核價三元組 → 拒收。
// ─────────────────────────────────────────────────────────────────────────────

test("expected-pass：白名單 model + 顯式 720p + 5s + 已核價三元組 → 放行並回正確單價", () => {
  const decision = evaluatePaidVideoSubmission({
    supplierModelId: "seedance-2.0-900-特惠",
    resolution: "720p",
    seconds: 5,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed === true && decision.triple.unitCostCny, 0.7);
  assert.equal(decision.allowed === true && decision.triple.billingBasis, "per_call");

  // 480p/4s 亦已核價
  assert.equal(
    evaluatePaidVideoSubmission({ supplierModelId: "seedance-2.0-900-特惠", resolution: "480p", seconds: 4 }).allowed,
    true,
  );
  // 直接呼叫 assert 也不拋
  assert.equal(
    assertPaidVideoSubmissionAllowed({ supplierModelId: "minimax-h3-933-2k-支持真人", resolution: "720p", seconds: 5 }).unitCostCny,
    1.1,
  );
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
    const decision = evaluatePaidVideoSubmission({ supplierModelId: model, resolution: "720p", seconds: 5 });
    assert.equal(decision.allowed, false, `model ${model} 應被拒`);
    assert.equal(decision.allowed === false && decision.reason, "model_not_whitelisted");
  }

  assert.throws(
    () => assertPaidVideoSubmissionAllowed({ supplierModelId: "dreamina-seedance-2.0", resolution: "720p", seconds: 5 }),
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
      seconds: 5,
    });
    assert.equal(decision.allowed, false, `resolution ${JSON.stringify(resolution)} 應被拒`);
    assert.equal(decision.allowed === false && decision.reason, "resolution_missing");
  }

  assert.throws(
    () => assertPaidVideoSubmissionAllowed({ supplierModelId: "seedance-2.0-900-特惠", resolution: null, seconds: 5 }),
    (error: unknown) =>
      error instanceof SupplierRequestError && error.status === 400 && error.message.includes("resolution_missing"),
  );
});

test("陰性③：4K（及 2k/1080p 等高價檔位）無條件拒收", () => {
  for (const resolution of ["4k", "2k", "1080p", "4K", "540p", "360p"]) {
    const decision = evaluatePaidVideoSubmission({
      supplierModelId: "minimax-h3-933-2k-支持真人", // model 名帶 2k 也不許升檔
      resolution,
      seconds: 5,
    });
    assert.equal(decision.allowed, false, `resolution ${resolution} 應被拒`);
    assert.equal(decision.allowed === false && decision.reason, "resolution_not_allowed");
  }

  // ≤720p 白名單只有 480p/720p
  assert.deepEqual([...PAID_VIDEO_ALLOWED_RESOLUTIONS], ["480p", "720p"]);

  assert.throws(
    () => assertPaidVideoSubmissionAllowed({ supplierModelId: "minimax-h3-933-2k-支持真人", resolution: "4k", seconds: 5 }),
    (error: unknown) =>
      error instanceof SupplierRequestError && error.status === 400 && error.message.includes("resolution_not_allowed"),
  );
});

test("陰性④：未核價三元組拒收（model/resolution 各自合法但組合無核價記錄）", () => {
  // seedance-2.5-900-特惠 只核價 480p；720p 雖在全局白名單內，但該 model 無此核價記錄
  const decision = evaluatePaidVideoSubmission({
    supplierModelId: "seedance-2.5-900-特惠",
    resolution: "720p",
    seconds: 5,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.reason, "triple_not_priced");

  // seconds 超上限（30s 檔位）先被 seconds 檢查攔下
  for (const seconds of [30, 6, 0, -1, 4.5, Number.NaN, undefined, "abc", ""]) {
    const verdict = evaluatePaidVideoSubmission({
      supplierModelId: "seedance-2.0-900-特惠",
      resolution: "480p",
      seconds: seconds as number,
    });
    assert.equal(verdict.allowed, false, `seconds ${String(seconds)} 應被拒`);
    assert.equal(verdict.allowed === false && verdict.reason, "seconds_missing_or_invalid");
  }
  assert.equal(PAID_VIDEO_MAX_SECONDS, 5);

  assert.throws(
    () => assertPaidVideoSubmissionAllowed({ supplierModelId: "seedance-2.5-900-特惠", resolution: "720p", seconds: 5 }),
    (error: unknown) =>
      error instanceof SupplierRequestError && error.status === 400 && error.message.includes("triple_not_priced"),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 提交路徑行為驗證：拒收必須發生在 fetch（真實上游 POST）之前 ⇒ 零支出。
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
      () => generateWithOpenaiVideo(fakeSupplier("seedance-2.0-900-特惠"), fakeInput(null, 5)),
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
    await assert.rejects(() => generateWithOpenaiVideo(fakeSupplier("seedance-2.0-900-特惠"), fakeInput("4k", 5)));
    await assert.rejects(() => generateWithOpenaiVideo(fakeSupplier("dreamina-seedance-2.0"), fakeInput("720p", 5)));
    assert.equal(upstreamCalls, 0, "4k／白名單外 model 不得發出任何上游請求");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.XIAOYXIAO_API_KEY;
    else process.env.XIAOYXIAO_API_KEY = originalEnv;
  }
});

test("提交路徑 expected-pass：顯式 720p/5s 的請求把 resolution 寫進 body（不依賴上游缺省）", async () => {
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
    const output = await generateWithOpenaiVideo(fakeSupplier("seedance-2.0-900-特惠"), fakeInput("720p", 5));
    assert.equal(output.url, "https://cdn.example/x.mp4");
    const post = seen.find((entry) => entry.body);
    assert.ok(post, "應有一次 POST 提交");
    const payload = JSON.parse(post!.body) as Record<string, unknown>;
    assert.equal(payload.model, "seedance-2.0-900-特惠");
    assert.equal(payload.resolution, "720p", "resolution 必須顯式出現在 body");
    assert.equal(payload.duration, 5);
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
  assert.equal(PAID_VIDEO_PRICED_TRIPLES.length, PAID_VIDEO_MODEL_WHITELIST.length);
});

test("作用域：圖片路徑 2k/4k 檔位照常通過共用歸一化（閘不進共用層）", () => {
  assert.equal(isSupportedImageModel("gpt-image-2"), true);
  // 圖片 gpt-image-2 的 catalog 檔位含 2k/4k，歸一化必須原樣保留
  for (const resolution of ["2k", "4k"] as const) {
    const normalized = normalizeGenerationConfig("gpt-image-2", { outputResolution: resolution });
    assert.equal(normalized.config.outputResolution, resolution, `圖片 ${resolution} 不得被清除`);
  }
  const imageIds = PAID_VIDEO_MODEL_WHITELIST as readonly string[];
  assert.equal(imageIds.includes("gpt-image-2"), false);
  assert.equal(imageIds.includes("seedream-5.0-lite"), false);
  assert.equal(imageIds.includes("image-5-pro"), false);
});
