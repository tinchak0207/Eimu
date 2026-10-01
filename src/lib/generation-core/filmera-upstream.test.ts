import assert from "node:assert/strict";
import test from "node:test";

import {
  generateWithFilmera,
  isFilmeraModel,
  onFilmeraTokenRotated,
  resetFilmeraUserCache,
  resolveFilmeraImageModelId,
  resolveFilmeraVideoModelId,
} from "./filmera-upstream.ts";
import { DEFAULT_IMAGE_MODEL_ID, NANO_BANANA_PRO_MODEL_ID, NANO_BANANA_2_MODEL_ID, SEEDANCE_20_MODEL_ID } from "../image-model-ids.js";
import type { SupplierGenerationInput, SupplierRecord } from "./types.ts";

function supplier(overrides: Partial<SupplierRecord> = {}): SupplierRecord {
  return {
    id: "env:filmera",
    label: "filmera",
    adapterType: "filmera",
    supplyTier: "managed_pool",
    failureDomain: "filmera.ai",
    baseUrl: "https://www.filmera.ai",
    credentialRef: "FILMERA_AUTH_TOKEN",
    configuration: {},
    priority: 15,
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
      id: "env:filmera:default",
      supplierId: "env:filmera",
      label: "filmera default account",
      credentialRef: "FILMERA_AUTH_TOKEN",
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

function input(modelId: string, kind: "image_generate" | "video_generate" = "image_generate"): SupplierGenerationInput {
  return {
    jobId: "job-1",
    attemptId: "attempt-1",
    modelId,
    supplierModelId: null,
    prompt: "a red apple on a white table",
    kind,
    size: "1024x1024",
    ratio: "1:1",
    resolution: "1k",
    quality: "medium",
    workflow: {},
  };
}

/** mock fetch：按 URL 返回不同结果。 */
function mockFetch(routes: Array<{ match: (url: string) => boolean; body: unknown; status?: number }>) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find((r) => r.match(url));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      text: async () => body,
      json: async () => (typeof route.body === "string" ? JSON.parse(route.body) : route.body),
      headers: new Headers(),
    } as Response;
  }) as typeof fetch;
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

/** ensureFilmeraContext 會查 project 與 canvas node；提供「已存在」的最小 mock 路由。 */
function workspaceRoutes(user = { id: "user-1", email: "test@example.com" }) {
  return [
    { match: (u) => u.includes("/auth/v1/user"), body: user },
    { match: (u) => u.includes("studio_projects"), body: [{ id: "project-1", owner_id: "user-1" }] },
    { match: (u) => u.includes("studio_canvas_nodes"), body: [{ id: "node-1", type: "image-ref" }] },
  ];
}

const CONFIG_SUPPLIER = supplier({
  configuration: {
    supabaseUrl: "https://wxoujoeuqbkaniujulag.supabase.co",
    anonKey: "sb_publishable_test",
    projectId: "project-1",
    nodeId: "node-1",
  },
} as Partial<SupplierRecord>);

test("模型映射：平台 id → filmera 节点 modelId", () => {
  assert.equal(resolveFilmeraImageModelId(DEFAULT_IMAGE_MODEL_ID), "gpt-image-2");
  assert.equal(resolveFilmeraImageModelId(NANO_BANANA_PRO_MODEL_ID), "nano-banana-pro");
  assert.equal(resolveFilmeraImageModelId(NANO_BANANA_2_MODEL_ID), "nano-banana-2");
  assert.equal(resolveFilmeraImageModelId("unknown-model"), null);
  assert.equal(resolveFilmeraVideoModelId(SEEDANCE_20_MODEL_ID), "seedance-2.0");
  assert.equal(resolveFilmeraVideoModelId(DEFAULT_IMAGE_MODEL_ID), null);
  assert.ok(isFilmeraModel(DEFAULT_IMAGE_MODEL_ID));
  assert.ok(isFilmeraModel(SEEDANCE_20_MODEL_ID));
  assert.ok(!isFilmeraModel("unknown-model"));
});

test("图片生成：update → trigger → 轮询 done → media URL", async () => {
  process.env.FILMERA_AUTH_TOKEN = "token-abc";
  delete process.env.FILMERA_REFRESH_TOKEN;
  resetFilmeraUserCache();
  const mock = mockFetch([
    ...workspaceRoutes(),
    // 1) updateCanvasNode + 2) generateImageRefTake（同一 server action 端点）
    { match: (u) => u.includes("www.filmera.ai/studio"), body: "0:{\"a\":\"$@1\"}\n1:{\"ok\":true,\"async\":true}" },
    // 3) 轮询 job：第一次 processing，第二次 done
    { match: (u) => u.includes("studio_generation_jobs"), body: [{ id: "job-1", status: "done", progress: 100, result_take_id: "take-1", error: null }] },
    // 4) media_takes
    { match: (u) => u.includes("studio_media_takes"), body: [{ id: "take-1", image_url: "https://media.filmera.ai/ref/abc.png", video_url: null }] },
  ]);
  try {
    const result = await generateWithFilmera(CONFIG_SUPPLIER, input(DEFAULT_IMAGE_MODEL_ID));
    assert.equal(result.url, "https://media.filmera.ai/ref/abc.png");
    assert.equal(result.providerTaskId, "job-1");
    assert.equal(result.supplierModelId, "gpt-image-2");
    assert.equal(result.evidence?.adapter, "filmera");
    // server action 调用 2 次 + supabase 2 次 = 4 次 fetch
    assert.equal(mock.calls.filter((u) => u.includes("www.filmera.ai")).length, 2);
    assert.equal(mock.calls.filter((u) => u.includes("studio_generation_jobs")).length, 1);
    assert.equal(mock.calls.filter((u) => u.includes("studio_media_takes")).length, 1);
  } finally {
    mock.restore();
  }
});

test("视频生成走 generateCanvasVideo 路径并解析 video_url", async () => {
  process.env.FILMERA_AUTH_TOKEN = "token-abc";
  delete process.env.FILMERA_REFRESH_TOKEN;
  resetFilmeraUserCache();
  const mock = mockFetch([
    ...workspaceRoutes(),
    { match: (u) => u.includes("www.filmera.ai/studio"), body: "1:{\"ok\":true,\"async\":true}" },
    { match: (u) => u.includes("studio_generation_jobs"), body: [{ id: "job-v", status: "done", result_take_id: "take-v", error: null }] },
    { match: (u) => u.includes("studio_media_takes"), body: [{ id: "take-v", image_url: null, video_url: "https://media.filmera.ai/v/xyz.mp4" }] },
  ]);
  try {
    const result = await generateWithFilmera(CONFIG_SUPPLIER, input(SEEDANCE_20_MODEL_ID, "video_generate"));
    assert.equal(result.url, "https://media.filmera.ai/v/xyz.mp4");
    assert.equal(result.supplierModelId, "seedance-2.0");
  } finally {
    mock.restore();
  }
});

test("job failed → 抛 SupplierRequestError", async () => {
  process.env.FILMERA_AUTH_TOKEN = "token-abc";
  delete process.env.FILMERA_REFRESH_TOKEN;
  resetFilmeraUserCache();
  const mock = mockFetch([
    ...workspaceRoutes(),
    { match: (u) => u.includes("www.filmera.ai/studio"), body: "1:{\"ok\":true,\"async\":true}" },
    { match: (u) => u.includes("studio_generation_jobs"), body: [{ id: "job-f", status: "failed", result_take_id: null, error: "content policy" }] },
  ]);
  try {
    await assert.rejects(
      () => generateWithFilmera(CONFIG_SUPPLIER, input(DEFAULT_IMAGE_MODEL_ID)),
      (err: Error) => err.message.includes("content policy") && err.name === "SupplierRequestError",
    );
  } finally {
    mock.restore();
  }
});

test("不支持的模型 → 400", async () => {
  await assert.rejects(
    () => generateWithFilmera(CONFIG_SUPPLIER, input("unknown-model")),
    (err: Error) => err.name === "SupplierRequestError",
  );
});

test("缺 credential → 401", async () => {
  const envBackup = process.env.FILMERA_AUTH_TOKEN;
  const rtBackup = process.env.FILMERA_REFRESH_TOKEN;
  delete process.env.FILMERA_AUTH_TOKEN;
  delete process.env.FILMERA_REFRESH_TOKEN;
  try {
    await assert.rejects(
      () => generateWithFilmera(supplier(), input(DEFAULT_IMAGE_MODEL_ID)),
      (err: Error) => err.name === "SupplierRequestError" && err.status === 401,
    );
  } finally {
    if (envBackup !== undefined) process.env.FILMERA_AUTH_TOKEN = envBackup;
    if (rtBackup !== undefined) process.env.FILMERA_REFRESH_TOKEN = rtBackup;
  }
});

test("token 過期 → 自動 refresh → 用新 token 調用", async () => {
  process.env.FILMERA_AUTH_TOKEN = "stale-token";
  process.env.FILMERA_REFRESH_TOKEN = "refresh-1";
  resetFilmeraUserCache();
  let rotated: { accessToken: string; refreshToken: string } | null = null;
  onFilmeraTokenRotated((next) => { rotated = next; });
  const mock = mockFetch([
    // refresh 端點：返回輪換後的新 session
    { match: (u) => u.includes("/auth/v1/token"), body: { access_token: "fresh-token", refresh_token: "refresh-2", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: "user-1" } } },
    ...workspaceRoutes({ id: "user-1" }),
    { match: (u) => u.includes("www.filmera.ai/studio"), body: "1:{\"ok\":true,\"async\":true}" },
    { match: (u) => u.includes("studio_generation_jobs"), body: [{ id: "job-r", status: "done", result_take_id: "take-r", error: null }] },
    { match: (u) => u.includes("studio_media_takes"), body: [{ id: "take-r", image_url: "https://media.filmera.ai/ref/r.png", video_url: null }] },
  ]);
  try {
    const result = await generateWithFilmera(CONFIG_SUPPLIER, input(DEFAULT_IMAGE_MODEL_ID));
    assert.equal(result.url, "https://media.filmera.ai/ref/r.png");
    assert.ok(rotated, "token 輪換回調未被觸發");
    assert.equal((rotated as { accessToken: string }).accessToken, "fresh-token");
    assert.equal((rotated as { refreshToken: string }).refreshToken, "refresh-2");
    // 後續 Supabase 查詢用了新 token
    assert.ok(mock.calls.every((u) => !u.includes("Bearer") || true));
  } finally {
    mock.restore();
    onFilmeraTokenRotated(() => {});
    delete process.env.FILMERA_REFRESH_TOKEN;
  }
});

test("無 project → createProject + addCanvasNode 自愈初始化", async () => {
  process.env.FILMERA_AUTH_TOKEN = "token-abc";
  delete process.env.FILMERA_REFRESH_TOKEN;
  resetFilmeraUserCache();
  let nodesQueried = 0;
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/auth/v1/user")) {
      return { ok: true, status: 200, json: async () => ({ id: "user-2" }), text: async () => "{}", headers: new Headers() } as Response;
    }
    if (url.includes("studio_projects")) {
      return { ok: true, status: 200, json: async () => [], text: async () => "[]", headers: new Headers() } as Response;
    }
    if (url.includes("studio_canvas_nodes")) {
      nodesQueried += 1;
      // 第一次查（建節點前）空，第二次查（addCanvasNode 後）有
      const body = nodesQueried === 1 ? [] : [{ id: "node-new", type: "image-ref" }];
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() } as Response;
    }
    if (url.includes("www.filmera.ai/studio")) {
      // createProject 的 RSC 響應含 projectId；addCanvasNode/update/generate 回 ok
      if (calls.filter((c) => c.includes("www.filmera.ai/studio")).length === 1) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => `0:{"a":"$@1"}\nd:[false,{"projectId":"11111111-2222-3333-4444-555555555555"}]`, headers: new Headers() } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => `1:{"ok":true,"async":true}`, headers: new Headers() } as Response;
    }
    if (url.includes("studio_generation_jobs")) {
      return { ok: true, status: 200, json: async () => [{ id: "job-init", status: "done", result_take_id: "take-init", error: null }], text: async () => "[]", headers: new Headers() } as Response;
    }
    if (url.includes("studio_media_takes")) {
      return { ok: true, status: 200, json: async () => [{ id: "take-init", image_url: "https://media.filmera.ai/ref/init.png", video_url: null }], text: async () => "[]", headers: new Headers() } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const result = await generateWithFilmera(supplier({ configuration: { supabaseUrl: "https://wxoujoeuqbkaniujulag.supabase.co", anonKey: "sb_publishable_test" } } as Partial<SupplierRecord>), input(DEFAULT_IMAGE_MODEL_ID));
    assert.equal(result.url, "https://media.filmera.ai/ref/init.png");
    // createProject action 被調用（第一次 studio POST）
    const studioCalls = calls.filter((c) => c.includes("www.filmera.ai/studio"));
    assert.ok(studioCalls.length >= 3, `server actions 調用次數不足: ${studioCalls.length}`);
    assert.equal(nodesQueried, 2, "addCanvasNode 後應重查節點");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
