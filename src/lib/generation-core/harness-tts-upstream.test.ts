// TTS 公開端點缺口（2026-10-01）的零成本行為斷言。
//
// 缺口層級（本檔守住的部分）：
//   ① **adapter 執行路徑**：supply-registry 新增 `harness_tts` 協議，指向 harness 閘道
//      既有 TTS 端點 `POST {base}/v1/tts`（router.ts:531 → media-internal-routes.ts handleTts）。
//   ② **capability 宣告**：registry 渠道 `harness-tts` 認領 catalog 真源 id `tts-1`（kind=tts）。
//
// 本檔不打任何真上游：fetch 一律 mock；DB 用 in-memory fake（見下「capability 解析」節的
// 誠實邊界註記）。

import assert from "node:assert/strict";
import test from "node:test";

import { REGISTRY_CHANNELS } from "../supplier-channels.config.ts";
import { describeEnvChannels, registryChannelToDescriptor } from "../sub2api.ts";
import { hasGenerationCapability } from "./job-repository.ts";
import {
  HARNESS_TTS_PATH,
  generateWithHarnessTts,
} from "./harness-tts-upstream.ts";
import { listSupplyProtocols, reconcileProtocolOf } from "./supply-registry.ts";
import { resolveSupplyAdapter } from "./supplier-adapter.ts";
import type { GenerationSql } from "./database.ts";
import { SupplierRequestError } from "./failure-classifier.ts";
import type { SupplierGenerationInput, SupplierRecord } from "./types.ts";

const TTS_MODEL = "tts-1";
const HARNESS_CHANNEL = "harness-tts";

// ─────────────────────────── fixtures

function supplier(overrides: Partial<SupplierRecord> = {}): SupplierRecord {
  return {
    id: `env:${HARNESS_CHANNEL}`,
    label: HARNESS_CHANNEL,
    adapterType: "harness_tts",
    supplyTier: "relay",
    failureDomain: "store.tinchak0207.xyz",
    baseUrl: "https://store.tinchak0207.xyz/agent",
    credentialRef: "HARNESS_TTS_API_KEY",
    configuration: {},
    priority: 50,
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
      id: `env:${HARNESS_CHANNEL}:default`,
      label: "harness-tts default account",
      credentialRef: "HARNESS_TTS_API_KEY",
      concurrencyLimit: 1,
      healthStatus: "healthy",
      tokenSource: "not_applicable",
      credentialExpiresAt: null,
      refreshStatus: "healthy",
      successRate5m: 1,
      healthObservedAt: new Date(0),
      configuration: {},
    },
    ...overrides,
  };
}

function input(overrides: Partial<SupplierGenerationInput> = {}): SupplierGenerationInput {
  return {
    jobId: "job-1",
    attemptId: "attempt-1",
    modelId: TTS_MODEL,
    supplierModelId: null,
    prompt: "你好，世界。",
    kind: "tts",
    size: null,
    ratio: null,
    resolution: null,
    quality: null,
    workflow: { voice: "default", inputLength: 6 },
    ...overrides,
  };
}

/** mock fetch：記下請求，回一個可控 Response。 */
function captureFetch(response: Response): { calls: Array<{ url: string; init: RequestInit }>; restore: () => void } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// ─────────────────────────── ① adapter 執行路徑

test("harness_tts adapter：POST {base}/v1/tts，Bearer 憑證，回 mp3 URL", async () => {
  process.env.HARNESS_TTS_API_KEY = "sk-biz-test-key";
  const capture = captureFetch(
    Response.json({ ok: true, url: "https://store.tinchak0207.xyz/agent/v1/audio/tts_abc.mp3", chars: 6, cost_coins: 0.006 }),
  );
  try {
    const output = await generateWithHarnessTts(supplier(), input());
    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0].url, `https://store.tinchak0207.xyz/agent${HARNESS_TTS_PATH}`);
    const headers = capture.calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk-biz-test-key");
    // 哨兵 "default" ⇒ 不送 voice，讓閘道用它自己的預設（route.ts 檔頭語義）。
    assert.deepEqual(JSON.parse(String(capture.calls[0].init.body)), { text: "你好，世界。" });
    assert.equal(output.url, "https://store.tinchak0207.xyz/agent/v1/audio/tts_abc.mp3");
    assert.equal(output.base64, null);
    assert.equal(output.endpointLabel, HARNESS_CHANNEL);
    assert.equal(output.supplierModelId, TTS_MODEL);
  } finally {
    capture.restore();
  }
});

test("harness_tts adapter：顯式音色逐字透傳", async () => {
  process.env.HARNESS_TTS_API_KEY = "sk-biz-test-key";
  const capture = captureFetch(Response.json({ ok: true, url: "https://x/audio.mp3" }));
  try {
    await generateWithHarnessTts(supplier(), input({ workflow: { voice: "zh-CN-XiaoxiaoNeural" } }));
    assert.deepEqual(JSON.parse(String(capture.calls[0].init.body)), {
      text: "你好，世界。",
      voice: "zh-CN-XiaoxiaoNeural",
    });
  } finally {
    capture.restore();
  }
});

test("harness_tts adapter：上游 503 tts_unavailable 原文透傳且分類成 SupplierRequestError", async () => {
  process.env.HARNESS_TTS_API_KEY = "sk-biz-test-key";
  const capture = captureFetch(
    Response.json({ error: { message: "配音（TTS）上游暂不可用：上游不可達" } }, { status: 503 }),
  );
  try {
    await assert.rejects(
      () => generateWithHarnessTts(supplier(), input()),
      (error: unknown) => {
        assert.ok(error instanceof SupplierRequestError, "應為 SupplierRequestError");
        if (!(error instanceof SupplierRequestError)) return false;
        assert.equal(error.status, 503);
        assert.match(error.message, /tts|不可用|TTS/);
        return true;
      },
    );
  } finally {
    capture.restore();
  }
});

test("harness_tts adapter：kind 非 tts 或回 200 但無 url ⇒ 確定性失敗（不假成功）", async () => {
  process.env.HARNESS_TTS_API_KEY = "sk-biz-test-key";
  await assert.rejects(
    () => generateWithHarnessTts(supplier(), input({ kind: "image_generate" })),
    (error: unknown) => error instanceof SupplierRequestError && error.status === 400,
  );
  const capture = captureFetch(Response.json({ ok: true }));
  try {
    await assert.rejects(
      () => generateWithHarnessTts(supplier(), input()),
      (error: unknown) => error instanceof SupplierRequestError && error.status === 502,
    );
  } finally {
    capture.restore();
  }
});

test("harness_tts 協議已註冊且分派正確；sync 協議有對帳兜底映射", () => {
  assert.ok(listSupplyProtocols().includes("harness_tts"), "harness_tts 應已註冊進 supply-registry");
  const adapter = resolveSupplyAdapter(supplier(), input());
  assert.equal(adapter.protocol, "harness_tts");
  assert.equal(reconcileProtocolOf("harness_tts"), "newapi_video");
});

// ─────────────────────────── ② capability 宣告

test("registry 渠道 harness-tts 認領 catalog 真源 id tts-1（kind=tts）", () => {
  const channel = REGISTRY_CHANNELS.find((c) => c.label === HARNESS_CHANNEL);
  assert.ok(channel, "REGISTRY_CHANNELS 應有 harness-tts 條目");
  assert.equal(channel.adapterType, "harness_tts");
  assert.deepEqual(
    channel.claims.map((claim) => ({ modelId: claim.modelId, kinds: claim.kinds })),
    [{ modelId: TTS_MODEL, kinds: ["tts"] }],
  );
});

test("harness-tts 描述子：env 齊備才算 configured，supportedModels=[tts-1]", () => {
  const channel = REGISTRY_CHANNELS.find((c) => c.label === HARNESS_CHANNEL)!;
  const env = {
    HARNESS_TTS_BASE_URL: "https://store.tinchak0207.xyz/agent",
    HARNESS_TTS_API_KEY: "sk-biz-test-key",
    HARNESS_TTS_ENABLED: "true",
  };
  const descriptor = registryChannelToDescriptor(channel, env);
  assert.equal(descriptor.id, `env:${HARNESS_CHANNEL}`);
  assert.equal(descriptor.defaultEnabled, true);
  assert.deepEqual(descriptor.endpoint!.supportedModels, [TTS_MODEL]);
  // 缺 key ⇒ 不 configured（不會被 seed）。
  assert.equal(registryChannelToDescriptor(channel, { HARNESS_TTS_BASE_URL: env.HARNESS_TTS_BASE_URL }).configured, false);
  // describeEnvChannels 是 seed 的真源入口：env 齊備時應含該渠道。
  assert.ok(describeEnvChannels(env).some((entry) => entry.label === HARNESS_CHANNEL && entry.configured));
  // 未設 env ⇒ configured=false、endpoint=null（seed 的 configured 過濾會跳過，不假裝有供給）。
  const unset = describeEnvChannels({}).find((entry) => entry.label === HARNESS_CHANNEL);
  assert.ok(unset, "registry 條目無 env 時仍應是 configured=false 的描述子（不是消失）");
  assert.equal(unset.configured, false);
  assert.equal(unset.endpoint, null);
});

// ─────────────────────────── ③ capability 解析（miss → hit）

/**
 * 誠實邊界：本機沒有生產 Postgres（PGlite 未安裝，見 master-ingest-service.test.ts 的
 * skip 慣例）。此 fake 依真函式插值出的 (public_model_id, kind) 判定 EXISTS，capability
 * 清單**由 REGISTRY_CHANNELS 真源推導**（非測試硬編）。它守的是「宣告 → 閘門接受」這條
 * 參數鏈；真正的 DB 佈署級 oracle 是收尾指引裡的 supplier_capability 唯讀查詢。
 */
function capabilityRowsFromRegistry(): Array<{ public_model_id: string; kind: string }> {
  return REGISTRY_CHANNELS.flatMap((channel) =>
    channel.claims.flatMap((claim) => claim.kinds.map((kind) => ({ public_model_id: claim.modelId, kind }))),
  );
}

function fakeCapabilitySql(rows: Array<{ public_model_id: string; kind: string }>): GenerationSql {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ? ");
    if (text.includes("supplier_capability")) {
      const modelId = values[0];
      const kind = values[1];
      return [{ present: rows.some((row) => row.public_model_id === modelId && row.kind === kind) }];
    }
    return [];
  }) as unknown as GenerationSql;
}

test("capability 解析：無宣告時 miss，harness-tts 宣告後 hit（{model:'tts-1', kind:'tts'}）", async () => {
  const probe = { modelId: TTS_MODEL, kind: "tts" as const, ratio: null, resolution: null, routingClass: "generic" as const };
  // miss：宣告前的狀態（seed 尚未含 tts capability）。
  assert.equal(await hasGenerationCapability(probe, fakeCapabilitySql([])), false);
  // hit：以 REGISTRY_CHANNELS 真源推導出的 capability 集（＝seed 會落庫的集合）。
  assert.equal(await hasGenerationCapability(probe, fakeCapabilitySql(capabilityRowsFromRegistry())), true);
  // 反例（不假 hit）：未宣告的 model／kind 仍 miss。
  assert.equal(
    await hasGenerationCapability({ ...probe, modelId: "tts-2" }, fakeCapabilitySql(capabilityRowsFromRegistry())),
    false,
  );
});
