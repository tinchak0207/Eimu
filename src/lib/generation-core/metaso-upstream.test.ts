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

test("isMetasoModel 只认 minimax-h3", () => {
  assert.equal(isMetasoModel(MINIMAX_H3_MODEL_ID), true);
  assert.equal(isMetasoModel("gpt-image-2"), false);
});

test("D-3（2026-09-23）：上游真 400 被改写成 502，原生硬停仍必须挡住重放（adapter → native → registry 全链）", async () => {
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
    assert.ok(thrown instanceof SupplierRequestError, "上游 400 必须抛 SupplierRequestError");
    // 产品侧状态照旧改写成 502（供应商侧失败 → 隔离/冷却语义不动，本刀不改判）。
    assert.equal((thrown as SupplierRequestError).status, 502);
    // 原生记录必须是上游真实状态：否则确定性 400 会被硬停看成 502，重放到预算上限。
    const record = createFailureRecord({ error: thrown });
    assert.equal(record.native.status, 400, "native.status 必须是上游真实状态，不是被改写的 502");
    const replay = planGenerationAttemptReplay({ kind: "video_generate", lastAttemptNo: 0, nativeFailure: record.native });
    assert.equal(replay.allowed, false, "确定性 400 不得被重放（D-3 修复前：allowed=true，会烧满预算）");
    assert.equal(replay.denialReason, "native_hard_stop");
    assert.equal(replay.hardStop?.status, 400);

    // 对照组：暂时性 503（同样被改写成 502）仍必须可换道重放——硬停不得把暂时性一起挡掉。
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
    assert.equal(transientReplay.allowed, true, "503 是暂时性，仍可换道重放");

    // 同一类洗白（HTML 错误页）：非 JSON 回应原本连状态都丢成 502，真 400 一样要挡。
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
    assert.equal(htmlNative.status, 400, "HTML 错误页也要保留上游真实状态");
    assert.equal(
      planGenerationAttemptReplay({ kind: "video_generate", lastAttemptNo: 0, nativeFailure: htmlNative }).denialReason,
      "native_hard_stop",
    );
  } finally {
    delete process.env.METASO_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("成功：create → 轮询 queued/running → succeeded 出 URL", async () => {
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

test("create body 映射：resolution 720p→768P、duration、ratio、无参考图", async () => {
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

test("失败：任务 failed 抛 SupplierRequestError 带上游错误码", async () => {
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

test("上游 429 透传为 429", async () => {
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

test("输入校验：duration 超出 4-15 直接 400", async () => {
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
