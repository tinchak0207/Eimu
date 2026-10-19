import assert from "node:assert/strict";
import test from "node:test";

import { generateWithOpenaiVideo, openaiVideoMaxWaitMs } from "./openai-video-upstream.ts";
import type { SupplierGenerationInput, SupplierRecord } from "./types.ts";

function supplier(overrides: Partial<SupplierRecord> = {}): SupplierRecord {
  return {
    id: "env:cangyuansuanli",
    label: "cangyuansuanli",
    adapterType: "openai_video",
    supplyTier: "managed_pool",
    failureDomain: "ai.cangyuansuanli.cn",
    baseUrl: "https://ai.cangyuansuanli.cn/v1",
    credentialRef: "CANGYUANSUANLI_API_KEY",
    configuration: {},
    priority: 8,
    concurrencyLimit: 2,
    qualityScore: 1,
    unitCost: 0,
    healthStatus: "healthy",
    healthScore: 1,
    latencyEwmaMs: null,
    supplierModelId: null,
    capabilityId: 1,
    capabilityConcurrencyLimit: 2,
    contractVersion: 1,
    capabilityHealthStatus: "healthy",
    account: {
      id: "env:cangyuansuanli:default",
      supplierId: "env:cangyuansuanli",
      label: "cangyuansuanli default account",
      credentialRef: "CANGYUANSUANLI_API_KEY",
      enabled: true,
      concurrencyLimit: 2,
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
    modelId: "seedance-2.0",
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

const TASK_ID = "task_video_01HZX8A2TEST";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("sd4 族成功：create → 轮询 queued → completed → data[0].url 出片", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const method = String(init?.method ?? "GET");
    calls.push({ method, url: u });
    if (u.endsWith("/videos") && method === "POST") {
      return jsonResponse(200, { id: TASK_ID, model: "sd12-seedance-2.0", status: "queued" });
    }
    if (u.includes(`/videos/${TASK_ID}`)) {
      return jsonResponse(200, {
        id: TASK_ID,
        status: calls.length <= 2 ? "queued" : "completed",
        data: [{ url: "https://cdn.cangyuansuanli.cn/video.mp4" }],
      });
    }
    return jsonResponse(404, { error: { message: "not found" } });
  }) as typeof fetch;

  try {
    process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
    const output = await generateWithOpenaiVideo(supplier(), videoInput());
    assert.equal(output.url, "https://cdn.cangyuansuanli.cn/video.mp4");
    assert.equal(output.providerTaskId, TASK_ID);
    assert.equal(output.httpStatus, 200);
    assert.equal(output.endpointLabel, "cangyuansuanli");
    assert.equal(output.supplierModelId, "sd12-seedance-2.0");
    const create = calls.find((c) => c.url.endsWith("/videos") && c.method === "POST");
    assert.ok(create);
  } finally {
    delete process.env.CANGYUANSUANLI_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("create body：model 按 720p→sd12、resolution/duration/ratio/generate_audio 透传", async () => {
  let captured: unknown = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/videos")) {
      captured = init?.body;
      return jsonResponse(200, { id: TASK_ID, status: "queued" });
    }
    return jsonResponse(200, { id: TASK_ID, status: "completed", data: [{ url: "https://cdn.cangyuansuanli.cn/video.mp4" }] });
  }) as typeof fetch;

  try {
    process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
    await generateWithOpenaiVideo(supplier(), videoInput({ workflow: { references: [], metadata: {}, durationSeconds: 8, generateAudio: true } }));
    const body = JSON.parse(String(captured)) as Record<string, unknown>;
    assert.equal(body.model, "sd12-seedance-2.0");
    assert.equal(body.prompt, "一只橘猫在窗台上打哈欠");
    assert.equal(body.aspect_ratio, "16:9");
    assert.equal(body.duration, 8);
    assert.equal(body.resolution, "720p");
    assert.equal(body.generate_audio, true);
  } finally {
    delete process.env.CANGYUANSUANLI_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("sd7 族成功：1080p 解析到 sd7-seedance-2.0-1080p、body 不含 resolution、metadata.video_url 出片", async () => {
  let captured: unknown = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/videos")) {
      captured = init?.body;
      return jsonResponse(200, { id: TASK_ID, status: "queued" });
    }
    return jsonResponse(200, {
      id: TASK_ID,
      status: "completed",
      metadata: { video_url: "https://ai.cangyuansuanli.cn/v1/videos/xxx/content" },
    });
  }) as typeof fetch;

  try {
    process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
    const output = await generateWithOpenaiVideo(supplier(), videoInput({ resolution: "1080p" }));
    const body = JSON.parse(String(captured)) as Record<string, unknown>;
    assert.equal(body.model, "sd7-seedance-2.0-1080p");
    assert.equal(body.resolution, undefined);
    assert.equal(body.generate_audio, false);
    assert.equal(output.url, "https://ai.cangyuansuanli.cn/v1/videos/xxx/content");
    assert.equal(output.supplierModelId, "sd7-seedance-2.0-1080p");
  } finally {
    delete process.env.CANGYUANSUANLI_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("seedance-2.5-480p：模型映射 + 30s 时长放行", async () => {
  let captured: unknown = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/videos")) {
      captured = init?.body;
      return jsonResponse(200, { id: TASK_ID, status: "queued" });
    }
    return jsonResponse(200, { id: TASK_ID, status: "completed", data: [{ url: "https://cdn.cangyuansuanli.cn/video.mp4" }] });
  }) as typeof fetch;

  try {
    process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
    const output = await generateWithOpenaiVideo(
      supplier(),
      videoInput({ modelId: "seedance-2.5-480p", resolution: "480p", workflow: { references: [], metadata: {}, durationSeconds: 30, generateAudio: true } }),
    );
    const body = JSON.parse(String(captured)) as Record<string, unknown>;
    assert.equal(body.model, "sd8-seedance-2.5");
    assert.equal(body.duration, 30);
    assert.equal(output.supplierModelId, "sd8-seedance-2.5");
  } finally {
    delete process.env.CANGYUANSUANLI_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("xiaoyxiao minimax-h3：supplierModelId 渠道级短路 + 顶层 url 出片 + 时长范围", async () => {
  let captured: unknown = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/videos")) {
      captured = init?.body;
      return jsonResponse(200, { id: TASK_ID, object: "video", status: "queued", progress: 0 });
    }
    // xiaoyxiao 形状：completed 只有顶层 url（无 video_url / metadata / data[]）
    return jsonResponse(200, {
      id: TASK_ID,
      object: "video",
      status: "completed",
      url: "https://dream-media.tos-cn-beijing.volces.com/videos/probe/0.mp4",
    });
  }) as typeof fetch;

  try {
    process.env.XIAOYXIAO_API_KEY = "xy-test-key";
    const output = await generateWithOpenaiVideo(
      supplier({
        id: "env:xiaoyxiao",
        label: "xiaoyxiao",
        baseUrl: "https://api.xiaoyxiao.xyz/v1",
        credentialRef: "XIAOYXIAO_API_KEY",
        supplierModelId: "minimax-h3-933-2k-支持真人",
      }),
      videoInput({ modelId: "minimax-h3", resolution: "720p" }),
    );
    const body = JSON.parse(String(captured)) as Record<string, unknown>;
    // 上游模型名走 capability 行显式携带，不落静态分辨率表
    assert.equal(body.model, "minimax-h3-933-2k-支持真人");
    assert.equal(body.resolution, "720p");
    assert.equal(body.duration, 5);
    assert.equal(output.supplierModelId, "minimax-h3-933-2k-支持真人");
    assert.equal(output.url, "https://dream-media.tos-cn-beijing.volces.com/videos/probe/0.mp4");
  } finally {
    delete process.env.XIAOYXIAO_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("xiaoyxiao minimax-h3：时长超出范围（16s）直接 400，不触发上游", async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return jsonResponse(200, { id: TASK_ID, status: "queued" });
  }) as typeof fetch;

  try {
    process.env.XIAOYXIAO_API_KEY = "xy-test-key";
    await assert.rejects(
      () =>
        generateWithOpenaiVideo(
          supplier({
            id: "env:xiaoyxiao",
            label: "xiaoyxiao",
            baseUrl: "https://api.xiaoyxiao.xyz/v1",
            credentialRef: "XIAOYXIAO_API_KEY",
            supplierModelId: "minimax-h3-933-2k-支持真人",
          }),
          videoInput({
            modelId: "minimax-h3",
            resolution: "720p",
            workflow: { references: [], metadata: {}, durationSeconds: 16, generateAudio: false },
          }),
        ),
      /duration must be an integer from 4 through 15 seconds/,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    delete process.env.XIAOYXIAO_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("INC-VIDEO-0927：平台 seedance 不再映射到已下架的 sd4-* 上游名", async () => {
  // 上游 2026-09-27 实查：sd4-* 整族下架，提交直接回
  // "model sd4-seedance-2.0 is not a public model name"。
  const cases: Array<{ modelId: string; resolution: string; expect: string }> = [
    { modelId: "seedance-2.0", resolution: "480p", expect: "sd12-seedance-2.0" },
    { modelId: "seedance-2.0", resolution: "720p", expect: "sd12-seedance-2.0" },
    { modelId: "seedance-2.0", resolution: "1080p", expect: "sd7-seedance-2.0-1080p" },
    { modelId: "seedance-2.0-fast", resolution: "720p", expect: "sd12-seedance-2.0-fast" },
    { modelId: "seedance-2.0-mini", resolution: "720p", expect: "sd13-seedance-2.0-mini" },
    { modelId: "seedance-2.5-480p", resolution: "480p", expect: "sd8-seedance-2.5" },
    { modelId: "seedance-2.5-720p", resolution: "720p", expect: "sd8-seedance-2.5" },
  ];
  for (const { modelId, resolution, expect } of cases) {
    let captured: unknown = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/videos")) {
        captured = init?.body;
        return jsonResponse(200, { id: TASK_ID, status: "queued" });
      }
      return jsonResponse(200, { id: TASK_ID, status: "completed", video_url: "https://cdn.cangyuansuanli.cn/video.mp4" });
    }) as typeof fetch;
    try {
      process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
      await generateWithOpenaiVideo(
        supplier(),
        videoInput({ modelId, resolution, workflow: { references: [], metadata: {}, durationSeconds: 4, generateAudio: false } }),
      );
      const body = JSON.parse(String(captured)) as Record<string, unknown>;
      assert.equal(body.model, expect, `${modelId}/${resolution} 应映射到 ${expect}`);
      assert.ok(!String(body.model).startsWith("sd4-"), `${modelId}/${resolution} 不得再用已下架的 sd4-* 名`);
    } finally {
      delete process.env.CANGYUANSUANLI_API_KEY;
      globalThis.fetch = originalFetch;
    }
  }
});

test("参考图透传 reference_image_urls（≤4）", async () => {
  let captured: unknown = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/videos")) {
      captured = init?.body;
      return jsonResponse(200, { id: TASK_ID, status: "queued" });
    }
    return jsonResponse(200, { id: TASK_ID, status: "completed", data: [{ url: "https://cdn.cangyuansuanli.cn/video.mp4" }] });
  }) as typeof fetch;

  try {
    process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
    await generateWithOpenaiVideo(
      supplier(),
      videoInput({
        workflow: {
          references: [
            { role: "general" as const, url: "https://img.example.com/a.png" },
            { role: "general" as const, url: "https://img.example.com/b.png" },
          ],
          metadata: {},
          durationSeconds: 5,
          generateAudio: false,
        },
      }),
    );
    const body = JSON.parse(String(captured)) as Record<string, unknown>;
    assert.deepEqual(body.reference_image_urls, ["https://img.example.com/a.png", "https://img.example.com/b.png"]);
  } finally {
    delete process.env.CANGYUANSUANLI_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("失败：任务 failed 抛 SupplierRequestError 带上游错误", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, _init?: RequestInit) => {
    if (String(url).endsWith("/videos")) {
      return jsonResponse(200, { id: TASK_ID, status: "queued" });
    }
    return jsonResponse(200, { id: TASK_ID, status: "failed", error: { message: "content policy violation" } });
  }) as typeof fetch;

  try {
    process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
    await assert.rejects(
      () => generateWithOpenaiVideo(supplier(), videoInput()),
      (error: Error) => error.message.includes("content policy violation") && error.name === "SupplierRequestError",
    );
  } finally {
    delete process.env.CANGYUANSUANLI_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("输入校验：duration 超出模型范围直接 400（2.0 上限 15）", async () => {
  process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
  try {
    await assert.rejects(
      () => generateWithOpenaiVideo(supplier(), videoInput({ workflow: { references: [], metadata: {}, durationSeconds: 20, generateAudio: false } })),
      (error: Error) => error.name === "SupplierRequestError" && (error as { status?: number }).status === 400,
    );
  } finally {
    delete process.env.CANGYUANSUANLI_API_KEY;
  }
});

test("输入校验：未注册的解析度（如 4k）直接 400", async () => {
  process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
  try {
    await assert.rejects(
      () => generateWithOpenaiVideo(supplier(), videoInput({ resolution: "4k" })),
      (error: Error) => error.name === "SupplierRequestError" && (error as { status?: number }).status === 400,
    );
  } finally {
    delete process.env.CANGYUANSUANLI_API_KEY;
  }
});

test("drama sd25-30s：body 带 seconds:30/duration:30/720p 且禁止 generate_audio", async () => {
  let captured: Record<string, unknown> | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/videos")) {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(200, { id: TASK_ID, model: "sd25-30s", status: "queued" });
    }
    return jsonResponse(200, {
      id: TASK_ID,
      status: "completed",
      video_url: "https://cdn.dafeiyangapi.top/drama.mp4",
    });
  }) as typeof fetch;

  try {
    process.env.DRAMA_API_KEY = "sk-drama-test";
    const output = await generateWithOpenaiVideo(
      supplier({ id: "env:drama", label: "drama", baseUrl: "https://drama.dafeiyangapi.top/v1", credentialRef: "DRAMA_API_KEY" }),
      videoInput({ modelId: "seedance-2.5-30s", workflow: { references: [], metadata: {}, durationSeconds: 30, generateAudio: true } }),
    );
    assert.equal(output.url, "https://cdn.dafeiyangapi.top/drama.mp4");
    assert.equal(output.supplierModelId, "sd25-30s");
    assert.ok(captured);
    assert.equal(captured.model, "sd25-30s");
    assert.equal(captured.seconds, 30);
    assert.equal(captured.duration, 30);
    assert.equal(captured.resolution, "720p");
    assert.equal("generate_audio" in captured, false, "drama 上游禁止 generate_audio 栏位");
  } finally {
    delete process.env.DRAMA_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("drama sd25-30s：duration ≠ 30 直接 400（30 秒固定档门禁）", async () => {
  process.env.DRAMA_API_KEY = "sk-drama-test";
  try {
    await assert.rejects(
      () =>
        generateWithOpenaiVideo(
          supplier({ id: "env:drama", label: "drama", baseUrl: "https://drama.dafeiyangapi.top/v1", credentialRef: "DRAMA_API_KEY" }),
          videoInput({ modelId: "seedance-2.5-30s", workflow: { references: [], metadata: {}, durationSeconds: 8, generateAudio: false } }),
        ),
      (error: Error) => error.name === "SupplierRequestError" && (error as { status?: number }).status === 400,
    );
  } finally {
    delete process.env.DRAMA_API_KEY;
  }
});

test("napi seed-2.0：body 带 ratio/seconds、无 aspect_ratio/resolution/generate_audio、30s 放行", async () => {
  let captured: Record<string, unknown> | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/videos")) {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(200, { id: TASK_ID, task_id: TASK_ID, model: "seed-2.0", status: "queued" });
    }
    return jsonResponse(200, {
      id: TASK_ID,
      status: "completed",
      video_url: "http://203.0.113.11/generated_videos/video_napi.mp4",
    });
  }) as typeof fetch;

  try {
    process.env.NAPI_API_KEY = "sk-napi-test";
    const output = await generateWithOpenaiVideo(
      supplier({ id: "env:napi", label: "napi", baseUrl: "https://napi.wanzij.cn/v1", credentialRef: "NAPI_API_KEY", supplierModelId: "seed-2.0" }),
      videoInput({ modelId: "seedance-2.5-30s", workflow: { references: [], metadata: {}, durationSeconds: 30, generateAudio: true } }),
    );
    assert.equal(output.url, "http://203.0.113.11/generated_videos/video_napi.mp4");
    assert.equal(output.supplierModelId, "seed-2.0");
    assert.ok(captured);
    assert.equal(captured.model, "seed-2.0");
    assert.equal(captured.ratio, "16:9");
    assert.equal(captured.seconds, "30", "napi seconds 必须是字串（上游 Go struct 拒收数字）");
    assert.equal(captured.duration, 30);
    assert.equal("aspect_ratio" in captured, false, "napi 族不带 aspect_ratio");
    assert.equal("resolution" in captured, false, "napi 族不带 resolution");
    assert.equal("generate_audio" in captured, false, "napi 族不带 generate_audio");
  } finally {
    delete process.env.NAPI_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("napi seed-2.5：参考图走 images 阵列、supplierModelId 渠道级短路", async () => {
  let captured: Record<string, unknown> | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/videos")) {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(200, { id: TASK_ID, task_id: TASK_ID, model: "seed-2.5", status: "queued" });
    }
    return jsonResponse(200, {
      id: TASK_ID,
      status: "completed",
      video_url: "http://203.0.113.11/generated_videos/video_napi25.mp4",
    });
  }) as typeof fetch;

  try {
    process.env.NAPI_API_KEY = "sk-napi-test";
    const output = await generateWithOpenaiVideo(
      supplier({ id: "env:napi", label: "napi", baseUrl: "https://napi.wanzij.cn/v1", credentialRef: "NAPI_API_KEY", supplierModelId: "seed-2.5" }),
      videoInput({
        modelId: "seedance-2.5-720p",
        workflow: {
          references: [
            { role: "general" as const, url: "https://img.example.com/a.png" },
            { role: "general" as const, url: "https://img.example.com/b.png" },
          ],
          metadata: {},
          durationSeconds: 15,
          generateAudio: false,
        },
      }),
    );
    assert.equal(output.supplierModelId, "seed-2.5");
    assert.ok(captured);
    assert.equal(captured.model, "seed-2.5");
    assert.deepEqual(captured.images, ["https://img.example.com/a.png", "https://img.example.com/b.png"]);
    assert.equal("reference_image_urls" in captured, false, "napi 参考图栏位是 images");
  } finally {
    delete process.env.NAPI_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("napi：completed 无公网 URL 时走 /content 鉴权下载回 base64", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/videos")) {
      return jsonResponse(200, { id: TASK_ID, task_id: TASK_ID, model: "seed-2.0", status: "queued" });
    }
    if (u.endsWith(`/videos/${TASK_ID}`)) {
      return jsonResponse(200, { id: TASK_ID, status: "completed", url: null, error: null });
    }
    if (u.endsWith(`/videos/${TASK_ID}/content`)) {
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      assert.equal(auth, "Bearer sk-napi-test", "content 下载必须带 Bearer 鉴权");
      return new Response(new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]), {
        status: 200,
        headers: { "Content-Type": "video/mp4" },
      });
    }
    return jsonResponse(404, { error: { message: "not found" } });
  }) as typeof fetch;

  try {
    process.env.NAPI_API_KEY = "sk-napi-test";
    const output = await generateWithOpenaiVideo(
      supplier({ id: "env:napi", label: "napi", baseUrl: "https://napi.wanzij.cn/v1", credentialRef: "NAPI_API_KEY", supplierModelId: "seed-2.0" }),
      videoInput({ modelId: "seedance-2.0", workflow: { references: [], metadata: {}, durationSeconds: 15, generateAudio: false } }),
    );
    assert.equal(output.url, null);
    assert.ok(output.base64 && output.base64.length > 0, "应回传 base64 成品");
    assert.equal(output.providerTaskId, TASK_ID);
  } finally {
    delete process.env.NAPI_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("drama sd25-30s：completed 无 URL 时走 /content 鉴权下载回 base64", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/videos")) {
      return jsonResponse(200, { id: TASK_ID, model: "sd25-30s", status: "queued" });
    }
    if (u.endsWith(`/videos/${TASK_ID}`)) {
      return jsonResponse(200, { id: TASK_ID, status: "completed", metadata: { aspect_ratio: "16:9", resolution: "720p" } });
    }
    if (u.endsWith(`/videos/${TASK_ID}/content`)) {
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      assert.equal(auth, "Bearer sk-drama-test", "content 下载必须带 Bearer 鉴权");
      return new Response(new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]), {
        status: 200,
        headers: { "Content-Type": "video/mp4" },
      });
    }
    return jsonResponse(404, { error: { message: "not found" } });
  }) as typeof fetch;

  try {
    process.env.DRAMA_API_KEY = "sk-drama-test";
    const output = await generateWithOpenaiVideo(
      supplier({ id: "env:drama", label: "drama", baseUrl: "https://drama.dafeiyangapi.top/v1", credentialRef: "DRAMA_API_KEY" }),
      videoInput({ modelId: "seedance-2.5-30s", workflow: { references: [], metadata: {}, durationSeconds: 30, generateAudio: false } }),
    );
    assert.equal(output.url, null);
    assert.ok(output.base64 && output.base64.length > 0, "应回传 base64 成品");
    assert.equal(output.providerTaskId, TASK_ID);
  } finally {
    delete process.env.DRAMA_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("openaiVideoMaxWaitMs：预设 20 分钟，可 OPENAI_VIDEO_MAX_WAIT_MS 覆写（下限 60s）", () => {
  // INC-VIDEO-0927：旧值 540s 会误杀慢而健康的影片上游（实录 timeout after 540s,
  // last status in_progress；napi 实测单次 attempt 最长 993.9s）。
  const original = process.env.OPENAI_VIDEO_MAX_WAIT_MS;
  try {
    delete process.env.OPENAI_VIDEO_MAX_WAIT_MS;
    assert.equal(openaiVideoMaxWaitMs(), 1_200_000);
    process.env.OPENAI_VIDEO_MAX_WAIT_MS = "1800000";
    assert.equal(openaiVideoMaxWaitMs(), 1_800_000);
    process.env.OPENAI_VIDEO_MAX_WAIT_MS = "1000";
    assert.equal(openaiVideoMaxWaitMs(), 1_200_000, "低于 60s 的下限值忽略，回预设");
    process.env.OPENAI_VIDEO_MAX_WAIT_MS = "abc";
    assert.equal(openaiVideoMaxWaitMs(), 1_200_000);
  } finally {
    if (original === undefined) delete process.env.OPENAI_VIDEO_MAX_WAIT_MS;
    else process.env.OPENAI_VIDEO_MAX_WAIT_MS = original;
  }
});

test("xiaoyxiao 实弹形状：completed 响应只有顶层 url（无 video_url/metadata/data）也能出片", async () => {
  // 2026-09-27 实查 xiaoyxiao /v1/videos/{id} completed 响应：
  // {"id":"task_…","object":"video","model":"seedance-2.0-mini-deal","status":"completed",
  //  "progress":100,"url":"https://dream-media.tos-cn-beijing.volces.com/videos/<uuid>/0.mp4"}
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/videos") && String(init?.method ?? "") === "POST") {
      return jsonResponse(200, { id: TASK_ID, object: "video", model: "sd12-seedance-2.0", status: "queued", progress: 0 });
    }
    return jsonResponse(200, {
      id: TASK_ID,
      object: "video",
      model: "sd12-seedance-2.0",
      status: "completed",
      progress: 100,
      url: "https://dream-media.tos-cn-beijing.volces.com/videos/19e7efa6-c6e8-410b-8b0e-d77a344b245e/0.mp4",
    });
  }) as typeof fetch;

  try {
    process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
    const output = await generateWithOpenaiVideo(supplier(), videoInput());
    assert.equal(output.url, "https://dream-media.tos-cn-beijing.volces.com/videos/19e7efa6-c6e8-410b-8b0e-d77a344b245e/0.mp4");
    assert.equal(output.providerTaskId, TASK_ID);
    assert.equal(output.httpStatus, 200);
  } finally {
    delete process.env.CANGYUANSUANLI_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

test("上游 403 HTML 页（nginx 封 IP）→ 401 鉴权失败让帐号冷却换道，不洗成 502 overloaded", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("<html><head><title>403 Forbidden</title></head></html>", {
      status: 403,
      headers: { "Content-Type": "text/html" },
    })) as typeof fetch;

  try {
    process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
    await assert.rejects(generateWithOpenaiVideo(supplier(), videoInput()), (error: { status?: number; message?: string }) => {
      assert.equal(error.status, 401);
      assert.match(String(error.message), /HTTP 403/);
      return true;
    });
  } finally {
    delete process.env.CANGYUANSUANLI_API_KEY;
    globalThis.fetch = originalFetch;
  }
});

for (const [label, resultUrls, expected] of [
  ["阵列", ["", "ftp://bad", "https://gway.example.com/out/a.mp4", "https://gway.example.com/out/b.mp4"], "https://gway.example.com/out/a.mp4"],
  ["字串", "https://gway.example.com/out/s.mp4", "https://gway.example.com/out/s.mp4"],
] as const) {
  test(`gway 形状：completed 只有 result_urls（${label}）也能出片`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/videos") && String(init?.method ?? "") === "POST") {
        return jsonResponse(200, { id: TASK_ID, object: "video", model: "sd12-seedance-2.0", status: "queued", progress: 0 });
      }
      return jsonResponse(200, { id: TASK_ID, object: "video", status: "completed", progress: 100, result_urls: resultUrls });
    }) as typeof fetch;
    try {
      process.env.CANGYUANSUANLI_API_KEY = "ck-test-key";
      const output = await generateWithOpenaiVideo(supplier(), videoInput());
      assert.equal(output.url, expected);
      assert.equal(output.providerTaskId, TASK_ID);
    } finally {
      delete process.env.CANGYUANSUANLI_API_KEY;
      globalThis.fetch = originalFetch;
    }
  });
}
