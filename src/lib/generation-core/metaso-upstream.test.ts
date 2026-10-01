import assert from "node:assert/strict";
import test from "node:test";

import { generateWithMetaso, isMetasoModel } from "./metaso-upstream.ts";
import { SupplierRequestError } from "./failure-classifier.ts";
import { createFailureRecord } from "./failure-record.ts";
import { planGenerationAttemptReplay } from "./operation-registry.ts";
import { MINIMAX_H3_MODEL_ID } from "../image-model-ids.js";
import type { SupplierGenerationInput, SupplierRecord } from "./types.ts";

function supplier(overrides: Partial<SupplierRecord> = {}): SupplierRecord {
  return {
    id: "env:metaso",
    label: "metaso",
    adapterType: "metaso",
    supplyTier: "managed_pool",
    failureDomain: "metaso.cn",
    baseUrl: "https://metaso.cn/api/minimax",
    credentialRef: "METASO_API_KEY",
    configuration: {},
    priority: 12,
    concurrencyLimit: 1,
    qualityScore: 1,
    unitCost: 0,
    healthStatus: "healthy",
    healthScore: 1,
    latencyEwmaMs: null,
    supplierModelId: null,
    capabilityId: 1,
    capabilityConcurrencyLimit: 1,
    contractVersion: 1,
    capabilityHealthStatus: "healthy",
    account: {
      id: "env:metaso:default",
      supplierId: "env:metaso",
      label: "metaso default account",
      credentialRef: "METASO_API_KEY",
      enabled: true,
      concurrencyLimit: 1,
      healthStatus: "healthy",
      cooldownUntil: null,
      tokenSource: "static",
      credentialExpiresAt: null,
      refreshStatus: "healthy",
      lastRefreshAt: null,
      lastRefreshFailureAt: null,
      attempts5m: 0,
      successes5m: 0,
      successRate5m: 1,
      healthObservedAt: null,
      lastSelectedAt: null,
      configuration: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    ...overrides,
  } as SupplierRecord;
}

function videoInput(overrides: Partial<SupplierGenerationInput> = {}): SupplierGenerationInput {
  return {
    jobId: "job-1",
    attemptId: "attempt-1",
    modelId: MINIMAX_H3_MODEL_ID,
    supplierModelId: null,
    prompt: "一只橘猫在窗台上打哈欠",
    kind: "video_generate",
    size: "16:9",
    ratio: "16:9",
    resolution: "720p",
    quality: null,
    workflow: {
      references: [],
      metadata: {},
      durationSeconds: 5,
      generateAudio: false,
    },
    ...overrides,
  } as SupplierGenerationInput;
}

const TASK_ID = "2092888943596797952";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("isMetasoModel 只認 minimax-h3", () => {
  assert.equal(isMetasoModel(MINIMAX_H3_MODEL_ID), true);
  assert.equal(isMetasoModel("gpt-image-2"), false);
});

test("D-3（2026-09-23）：上游真 400 被改寫成 502，原生硬停仍必須擋住重放（adapter → native → registry 全鏈）", async () => {
  const originalFetch = globalThis.fetch;
  try {
    process.env.METASO_API_KEY = "mk-test-key";

    globalThis.fetch = (async () => jsonResponse(400, { error: { message: "invalid prompt" } })) as typeof fetch;
    let thrown: unknown = null;
    try {
      await generateWithMetaso(supplier(), videoInput());
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof SupplierRequestError, "上游 400 必須拋 SupplierRequestError");
    // 產品側狀態照舊改寫成 502（供應商側失敗 → 隔離/冷卻語義不動，本刀不改判）。
    assert.equal((thrown as SupplierRequestError).status, 502);
    // 原生記錄必須是上游真實狀態：否則確定性 400 會被硬停看成 502，重放到預算上限。
    const record = createFailureRecord({ error: thrown });
    assert.equal(record.native.status, 400, "native.status 必須是上游真實狀態，不是被改寫的 502");
    const replay = planGenerationAttemptReplay({ kind: "video_generate", lastAttemptNo: 0, nativeFailure: record.native });
    assert.equal(replay.allowed, false, "確定性 400 不得被重放（D-3 修復前：allowed=true，會燒滿預算）");
    assert.equal(replay.denialReason, "native_hard_stop");
    assert.equal(replay.hardStop?.status, 400);

    // 對照組：暫時性 503（同樣被改寫成 502）仍必須可換道重放——硬停不得把暫時性一起擋掉。
    globalThis.fetch = (async () => jsonResponse(503, { error: { message: "temporarily unavailable" } })) as typeof fetch;
    let transient: unknown = null;
    try {
      await generateWithMetaso(supplier(), videoInput());
    } catch (error) {
      transient = error;
    }
    const transientReplay = planGenerationAttemptReplay({
      kind: "video_generate",
      lastAttemptNo: 0,
      nativeFailure: createFailureRecord({ error: transient }).native,
    });
    assert.equal(transientReplay.allowed, true, "503 是暫時性，仍可換道重放");

    // 同一類洗白（HTML 錯誤頁）：非 JSON 回應原本連狀態都丟成 502，真 400 一樣要擋。
    globalThis.fetch = (async () => new Response("<html>400 Bad Request</html>", {
      status: 400,
      headers: { "Content-Type": "text/html" },
    })) as typeof fetch;
    let htmlError: unknown = null;
    try {
      await generateWithMetaso(supplier(), videoInput());
    } catch (error) {
      htmlError = error;
    }
    const htmlNative = createFailureRecord({ error: htmlError }).native;
    assert.equal(htmlNative.status, 400, "HTML 錯誤頁也要保留上游真實狀態");
    assert.equal(
      planGenerationAttemptReplay({ kind: "video_generate", lastAttemptNo: 0, nativeFailure: htmlNative }).denialReason,
      "native_hard_stop",
    );
  } finally {
    delete process.env.METASO_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("成功：create → 輪詢 queued/running → succeeded 出 URL", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const method = String(init?.method ?? "GET");
    calls.push({ method, url: u });
    if (u.endsWith("/v2/video_generation")) {
      return jsonResponse(200, { task_id: TASK_ID });
    }
    if (u.includes(`/v2/query/video_generation/${TASK_ID}`)) {
      return jsonResponse(200, {
        task: { id: TASK_ID, status: calls.length <= 2 ? "queued" : "succeeded", content: { url: "https://files.metaso.cn/video.mp4" }, resolution: "768P", duration: 5, ratio: "16:9", modality: "video" },
      });
    }
    return jsonResponse(404, { error: { message: "not found" } });
  }) as typeof fetch;

  try {
    process.env.METASO_API_KEY = "mk-test-key";
    const output = await generateWithMetaso(supplier(), videoInput());
    assert.equal(output.url, "https://files.metaso.cn/video.mp4");
    assert.equal(output.providerTaskId, TASK_ID);
    assert.equal(output.httpStatus, 200);
    assert.equal(output.endpointLabel, "metaso");
    assert.equal(output.supplierModelId, MINIMAX_H3_MODEL_ID);
    const create = calls.find((c) => c.url.endsWith("/v2/video_generation"));
    assert.ok(create);
    assert.equal(create.method, "POST");
  } finally {
    delete process.env.METASO_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("create body 映射：resolution 720p→768P、duration、ratio、無參考圖", async () => {
  let captured: unknown = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/v2/video_generation")) {
      captured = init?.body;
      return jsonResponse(200, { task_id: TASK_ID });
    }
    return jsonResponse(200, { task: { id: TASK_ID, status: "succeeded", content: { url: "https://files.metaso.cn/video.mp4" } } });
  }) as typeof fetch;

  try {
    process.env.METASO_API_KEY = "mk-test-key";
    await generateWithMetaso(supplier(), videoInput());
    const body = JSON.parse(String(captured)) as Record<string, unknown>;
    assert.equal(body.model, "MiniMax-H3");
    assert.deepEqual(body.content, [{ type: "text", text: "一只橘猫在窗台上打哈欠" }]);
    assert.equal(body.resolution, "768P");
    assert.equal(body.duration, 5);
    assert.equal(body.ratio, "16:9");
  } finally {
    delete process.env.METASO_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("失敗：任務 failed 拋 SupplierRequestError 帶上游錯誤碼", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, _init?: RequestInit) => {
    if (String(url).endsWith("/v2/video_generation")) {
      return jsonResponse(200, { task_id: TASK_ID });
    }
    return jsonResponse(200, { task: { id: TASK_ID, status: "failed", error: { code: "1004", message: "login fail" } } });
  }) as typeof fetch;

  try {
    process.env.METASO_API_KEY = "mk-test-key";
    await assert.rejects(
      () => generateWithMetaso(supplier(), videoInput()),
      (error: Error) => error.message.includes("login fail") && error.name === "SupplierRequestError",
    );
  } finally {
    delete process.env.METASO_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("上游 429 透傳為 429", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(429, { error: { message: "rate limited" } })) as typeof fetch;
  try {
    process.env.METASO_API_KEY = "mk-test-key";
    await assert.rejects(
      () => generateWithMetaso(supplier(), videoInput()),
      (error: Error) => error.name === "SupplierRequestError" && (error as { status?: number }).status === 429,
    );
  } finally {
    delete process.env.METASO_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("輸入校驗：duration 超出 4-15 直接 400", async () => {
  process.env.METASO_API_KEY = "mk-test-key";
  try {
    await assert.rejects(
      () => generateWithMetaso(supplier(), videoInput({ workflow: { references: [], metadata: {}, durationSeconds: 20, generateAudio: false } })),
      (error: Error) => error.name === "SupplierRequestError" && (error as { status?: number }).status === 400,
    );
  } finally {
    delete process.env.METASO_API_KEY;
  }
});
