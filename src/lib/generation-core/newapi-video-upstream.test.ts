import assert from "node:assert/strict";
import test from "node:test";

import { generateWithNewApiVideo, isNewApiVideoKernelEnabled } from "./newapi-video-upstream.ts";
import { generateWithSupplier } from "./supplier-adapter.ts";
import { MINIMAX_H3_MODEL_ID } from "../image-model-ids.js";
import type { SupplierGenerationInput, SupplierRecord } from "./types.ts";

// 覆蓋 P1 視頻語義歸一開關（NEWAPI_VIDEO_KERNEL）：
//   提交請求形狀（路由 /video/generations、Bearer 鑑權、TaskSubmitReq payload）
//   輪詢三態映射（running / succeeded / failed+fail_reason）
//   開關兩態（on → new-api 原生；off → 現行 metaso 直調橋，影子期並存）

const NEWAPI_BASE = "http://newapi.test:3001/v1";
const NEWAPI_KEY = "sk-newapi-kernel-test";
const TASK_ID = "task_jdu56Qk753RXPDKhhexd6aVQ8iPoFGZE";
const RESULT_URL = "https://files.metaso.cn/video.mp4";

const ENV_KEYS = ["NEWAPI_VIDEO_KERNEL", "NEWAPI_BASE_URL", "NEWAPI_API_KEY", "NEWAPI_VIDEO_POLL_INTERVAL_MS", "NEWAPI_VIDEO_MAX_WAIT_MS", "METASO_API_KEY"] as const;

function withKernelEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => Promise<void>): Promise<void> {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface CapturedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function mockFetch(handler: (call: { method: string; url: string }, index: number) => Response | Promise<Response>): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = [];
  const originalFetch = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const call = { method: String(init?.method ?? "GET"), url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === "string" ? init.body : undefined };
    const i = index++;
    calls.push(call);
    return handler(call, i);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

function kernelInput(overrides: Partial<SupplierGenerationInput> = {}): SupplierGenerationInput {
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

function metasoSupplier(overrides: Partial<SupplierRecord> = {}): SupplierRecord {
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

function submitOk(): Response {
  return jsonResponse(200, { id: TASK_ID, task_id: TASK_ID, created_at: 1787839986, model: "minimax-h3", status: "queued" });
}

function taskDto(status: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse(200, {
    code: "success",
    message: "",
    data: {
      id: 1,
      task_id: TASK_ID,
      platform: "35",
      status,
      progress: status === "SUCCESS" ? "100%" : "30%",
      submit_time: 1787839986,
      finish_time: status === "SUCCESS" ? 1787840066 : 0,
      ...extra,
    },
  });
}

test("isNewApiVideoKernelEnabled：未設/0 關，1/true 開", () => {
  return withKernelEnv({}, async () => {
    assert.equal(isNewApiVideoKernelEnabled(), false);
    process.env.NEWAPI_VIDEO_KERNEL = "0";
    assert.equal(isNewApiVideoKernelEnabled(), false);
    process.env.NEWAPI_VIDEO_KERNEL = "1";
    assert.equal(isNewApiVideoKernelEnabled(), true);
    process.env.NEWAPI_VIDEO_KERNEL = "true";
    assert.equal(isNewApiVideoKernelEnabled(), true);
    process.env.NEWAPI_VIDEO_KERNEL = "TRUE";
    assert.equal(isNewApiVideoKernelEnabled(), true);
  });
});

test("提交請求形狀：/video/generations 路由、Bearer 鑑權、TaskSubmitReq payload", () => {
  return withKernelEnv({ NEWAPI_VIDEO_KERNEL: "1", NEWAPI_BASE_URL: NEWAPI_BASE, NEWAPI_API_KEY: NEWAPI_KEY, NEWAPI_VIDEO_POLL_INTERVAL_MS: "10" }, async () => {
    const { calls, restore } = mockFetch((call) => {
      if (call.method === "POST" && call.url === `${NEWAPI_BASE}/video/generations`) return submitOk();
      if (call.method === "GET" && call.url === `${NEWAPI_BASE}/video/generations/${TASK_ID}`) return taskDto("SUCCESS", { result_url: RESULT_URL });
      return jsonResponse(404, { code: "invalid_url", message: "Invalid URL", data: null });
    });
    try {
      const output = await generateWithNewApiVideo(kernelInput());
      assert.equal(output.url, RESULT_URL);
      assert.equal(output.providerTaskId, TASK_ID);
      assert.equal(output.endpointLabel, "new-api");
      assert.equal(output.supplierModelId, MINIMAX_H3_MODEL_ID);
      assert.equal((output.evidence as { adapter?: string }).adapter, "newapi_video_kernel");

      const submit = calls.find((c) => c.method === "POST");
      assert.ok(submit, "submit call recorded");
      assert.equal(submit.url, `${NEWAPI_BASE}/video/generations`);
      assert.equal(submit.headers.Authorization, `Bearer ${NEWAPI_KEY}`);
      assert.equal(submit.headers["Content-Type"], "application/json");
      const body = JSON.parse(submit.body ?? "{}") as Record<string, unknown>;
      assert.equal(body.model, "minimax-h3");
      assert.equal(body.prompt, "一只橘猫在窗台上打哈欠");
      assert.equal(body.duration, 5);
      assert.equal(body.size, "1280x720");
      assert.deepEqual(body.metadata, { resolution: "768P" });
    } finally {
      restore();
    }
  });
});

test("輪詢三態：IN_PROGRESS（running）→ SUCCESS（succeeded 出 result_url）", () => {
  return withKernelEnv({ NEWAPI_VIDEO_KERNEL: "1", NEWAPI_BASE_URL: NEWAPI_BASE, NEWAPI_API_KEY: NEWAPI_KEY, NEWAPI_VIDEO_POLL_INTERVAL_MS: "10" }, async () => {
    const { calls, restore } = mockFetch((call, index) => {
      if (call.method === "POST") return submitOk();
      if (index === 1) return taskDto("IN_PROGRESS");
      return taskDto("SUCCESS", { result_url: RESULT_URL });
    });
    try {
      const output = await generateWithNewApiVideo(kernelInput());
      assert.equal(output.url, RESULT_URL);
      const polls = calls.filter((c) => c.method === "GET");
      assert.equal(polls.length, 2);
      assert.equal(polls[0].url, `${NEWAPI_BASE}/video/generations/${TASK_ID}`);
    } finally {
      restore();
    }
  });
});

test("輪詢三態：UNKNOWN 保守視為 running 繼續輪詢（總時限兜底）", () => {
  return withKernelEnv({ NEWAPI_VIDEO_KERNEL: "1", NEWAPI_BASE_URL: NEWAPI_BASE, NEWAPI_API_KEY: NEWAPI_KEY, NEWAPI_VIDEO_POLL_INTERVAL_MS: "10" }, async () => {
    const { restore } = mockFetch((_call, index) => {
      if (index === 0) return submitOk();
      return index === 1 ? taskDto("UNKNOWN") : taskDto("SUCCESS", { result_url: RESULT_URL });
    });
    try {
      const output = await generateWithNewApiVideo(kernelInput());
      assert.equal(output.url, RESULT_URL);
    } finally {
      restore();
    }
  });
});

test("輪詢三態：FAILURE 透傳 fail_reason 原文", () => {
  return withKernelEnv({ NEWAPI_VIDEO_KERNEL: "1", NEWAPI_BASE_URL: NEWAPI_BASE, NEWAPI_API_KEY: NEWAPI_KEY, NEWAPI_VIDEO_POLL_INTERVAL_MS: "10" }, async () => {
    const { restore } = mockFetch((call) => {
      if (call.method === "POST") return submitOk();
      return taskDto("FAILURE", { fail_reason: "content policy violation" });
    });
    try {
      await assert.rejects(
        () => generateWithNewApiVideo(kernelInput()),
        (error: Error) => error.name === "SupplierRequestError" && error.message.includes("content policy violation"),
      );
    } finally {
      restore();
    }
  });
});

test("grace 期內 task_not_exist 視為未就緒繼續輪詢", () => {
  return withKernelEnv({ NEWAPI_VIDEO_KERNEL: "1", NEWAPI_BASE_URL: NEWAPI_BASE, NEWAPI_API_KEY: NEWAPI_KEY, NEWAPI_VIDEO_POLL_INTERVAL_MS: "10" }, async () => {
    const { calls, restore } = mockFetch((call, index) => {
      if (call.method === "POST") return submitOk();
      if (index === 1) return jsonResponse(400, { code: "task_not_exist", message: "task_not_exist", data: null });
      return taskDto("SUCCESS", { result_url: RESULT_URL });
    });
    try {
      const output = await generateWithNewApiVideo(kernelInput());
      assert.equal(output.url, RESULT_URL);
      assert.equal(calls.filter((c) => c.method === "GET").length, 2);
    } finally {
      restore();
    }
  });
});

test("SUCCESS 但缺 result_url → 誠實報空（502）", () => {
  return withKernelEnv({ NEWAPI_VIDEO_KERNEL: "1", NEWAPI_BASE_URL: NEWAPI_BASE, NEWAPI_API_KEY: NEWAPI_KEY, NEWAPI_VIDEO_POLL_INTERVAL_MS: "10" }, async () => {
    const { restore } = mockFetch((call) => {
      if (call.method === "POST") return submitOk();
      return taskDto("SUCCESS");
    });
    try {
      await assert.rejects(
        () => generateWithNewApiVideo(kernelInput()),
        (error: Error) => error.name === "SupplierRequestError" && (error as { status?: number }).status === 502 && error.message.includes("result_url"),
      );
    } finally {
      restore();
    }
  });
});

test("開關 on 但缺 NEWAPI_BASE_URL → 配置錯誤 500（不靜默回退直調橋）", () => {
  return withKernelEnv({ NEWAPI_VIDEO_KERNEL: "1", NEWAPI_API_KEY: NEWAPI_KEY }, async () => {
    await assert.rejects(
      () => generateWithNewApiVideo(kernelInput()),
      (error: Error) => error.name === "SupplierRequestError" && (error as { status?: number }).status === 500 && error.message.includes("NEWAPI_BASE_URL"),
    );
  });
});

test("開關 off：video 任務仍走 metaso 直調橋（影子期並存）", () => {
  return withKernelEnv({ NEWAPI_BASE_URL: NEWAPI_BASE, NEWAPI_API_KEY: NEWAPI_KEY, METASO_API_KEY: "mk-test-key", NEWAPI_VIDEO_POLL_INTERVAL_MS: "10" }, async () => {
    const { calls, restore } = mockFetch((call) => {
      if (call.url === "https://metaso.cn/api/minimax/v2/video_generation") return jsonResponse(200, { task_id: "2092888943596797952" });
      if (call.url.includes("/v2/query/video_generation/")) {
        return jsonResponse(200, { task: { id: "2092888943596797952", status: "succeeded", content: { url: RESULT_URL }, modality: "video" } });
      }
      return jsonResponse(404, { error: { message: "not found" } });
    });
    try {
      const output = await generateWithSupplier(metasoSupplier(), kernelInput());
      assert.equal(output.endpointLabel, "metaso");
      assert.equal(output.url, RESULT_URL);
      assert.ok(calls.some((c) => c.url.includes("metaso.cn")), "metaso bridge called");
      assert.ok(!calls.some((c) => c.url.includes("newapi.test")), "new-api untouched when kernel off");
    } finally {
      restore();
    }
  });
});

test("開關 on：generateWithSupplier 分流到 new-api 原生內核", () => {
  return withKernelEnv({ NEWAPI_VIDEO_KERNEL: "1", NEWAPI_BASE_URL: NEWAPI_BASE, NEWAPI_API_KEY: NEWAPI_KEY, METASO_API_KEY: "mk-test-key", NEWAPI_VIDEO_POLL_INTERVAL_MS: "10" }, async () => {
    const { calls, restore } = mockFetch((call) => {
      if (call.method === "POST" && call.url === `${NEWAPI_BASE}/video/generations`) return submitOk();
      if (call.method === "GET" && call.url === `${NEWAPI_BASE}/video/generations/${TASK_ID}`) return taskDto("SUCCESS", { result_url: RESULT_URL });
      return jsonResponse(404, { code: "invalid_url", message: "Invalid URL", data: null });
    });
    try {
      const output = await generateWithSupplier(metasoSupplier(), kernelInput());
      assert.equal(output.endpointLabel, "new-api");
      assert.equal(output.url, RESULT_URL);
      assert.ok(calls.some((c) => c.url.startsWith(NEWAPI_BASE)), "new-api called when kernel on");
      assert.ok(!calls.some((c) => c.url.includes("metaso.cn")), "direct bridge bypassed when kernel on");
    } finally {
      restore();
    }
  });
});

test("開關 on 但非 minimax-h3 視頻：不攔截，維持原 supplier 路徑", () => {
  return withKernelEnv({ NEWAPI_VIDEO_KERNEL: "1", NEWAPI_BASE_URL: NEWAPI_BASE, NEWAPI_API_KEY: NEWAPI_KEY, METASO_API_KEY: "mk-test-key", NEWAPI_VIDEO_POLL_INTERVAL_MS: "10" }, async () => {
    const { calls, restore } = mockFetch((call) => {
      if (call.url === "https://metaso.cn/api/minimax/v2/video_generation") return jsonResponse(200, { task_id: "2092888943596797952" });
      if (call.url.includes("/v2/query/video_generation/")) {
        return jsonResponse(200, { task: { id: "2092888943596797952", status: "succeeded", content: { url: RESULT_URL }, modality: "video" } });
      }
      return jsonResponse(404, { error: { message: "not found" } });
    });
    try {
      const output = await generateWithSupplier(metasoSupplier(), kernelInput({ modelId: "firefly-video-pro" }));
      assert.equal(output.endpointLabel, "metaso");
      assert.ok(calls.some((c) => c.url.includes("metaso.cn")), "non-h3 video keeps supplier path");
      assert.ok(!calls.some((c) => c.url.startsWith(NEWAPI_BASE)), "new-api not called for non-h3 video");
    } finally {
      restore();
    }
  });
});

test("參考圖透傳：first/last frame 經 metadata，1080p → 2K + 1920x1080", () => {
  return withKernelEnv({ NEWAPI_VIDEO_KERNEL: "1", NEWAPI_BASE_URL: NEWAPI_BASE, NEWAPI_API_KEY: NEWAPI_KEY, NEWAPI_VIDEO_POLL_INTERVAL_MS: "10" }, async () => {
    let submitBody: Record<string, unknown> = {};
    const { restore } = mockFetch((call) => {
      if (call.method === "POST") {
        submitBody = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
        return submitOk();
      }
      return taskDto("SUCCESS", { result_url: RESULT_URL });
    });
    try {
      await generateWithNewApiVideo(kernelInput({
        resolution: "1080p",
        workflow: {
          references: [
            { url: "https://img.example/first.png", mimeType: "image/png" },
            { url: "https://img.example/last.png", mimeType: "image/png" },
          ],
          metadata: {},
          durationSeconds: 10,
          generateAudio: false,
        },
      }));
      const metadata = submitBody.metadata as Record<string, unknown>;
      assert.equal(submitBody.size, "1920x1080");
      assert.equal(submitBody.duration, 10);
      assert.equal(metadata.resolution, "2K");
      assert.equal(metadata.first_frame_image, "https://img.example/first.png");
      assert.equal(metadata.last_frame_image, "https://img.example/last.png");
    } finally {
      restore();
    }
  });
});
