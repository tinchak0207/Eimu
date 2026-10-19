import assert from "node:assert/strict";
import test from "node:test";

import { SupplierRequestError } from "./failure-classifier.ts";
import { generateWithSupplier } from "./supplier-adapter.ts";
import {
  getSupplyAdapter,
  listSupplyProtocols,
  pollSupplyTask,
  reconcileProtocolOf,
} from "./supply-registry.ts";
import type { SupplierGenerationInput, SupplierRecord } from "./types.ts";

process.env.REGTEST_API_KEY = "reg-test-key-not-real";

function supplier(overrides: Partial<SupplierRecord> = {}): SupplierRecord {
  return {
    id: "env:regtest",
    label: "regtest",
    adapterType: "openai_images",
    supplyTier: "relay",
    failureDomain: "reg.example",
    baseUrl: "https://reg.example/v1",
    credentialRef: "REGTEST_API_KEY",
    configuration: {},
    priority: 25,
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
      id: "env:regtest:default",
      label: "regtest default account",
      credentialRef: "REGTEST_API_KEY",
      concurrencyLimit: 1,
      healthStatus: "healthy",
      tokenSource: "not_applicable",
      credentialExpiresAt: null,
      refreshStatus: "healthy",
      successRate5m: 1,
      healthObservedAt: new Date(),
      configuration: {},
    },
    ...overrides,
  } as SupplierRecord;
}

function imageInput(modelId: string): SupplierGenerationInput {
  return {
    jobId: "job-reg",
    attemptId: "attempt-reg",
    modelId,
    supplierModelId: null,
    prompt: "a red apple",
    kind: "image_generate",
    size: "1024x1024",
    ratio: "1:1",
    resolution: "1k",
    quality: "medium",
    workflow: {},
  };
}

function captureFetch(body: unknown) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (fetchInput: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(fetchInput), body: String(init?.body ?? "") });
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("registry：7 个内建协议全部注册", () => {
  const protocols = listSupplyProtocols();
  for (const protocol of ["openai_images", "adobe2api", "metaso", "openai_video", "filmera", "blender_bridge", "newapi_video"]) {
    assert.ok(protocols.includes(protocol), `缺 ${protocol}`);
    assert.equal(getSupplyAdapter(protocol)?.protocol, protocol);
  }
});

test("对帐协议映射与旧 protocolOfAdapter 等价；未知协议抛错（不再 default newapi_video）", () => {
  assert.equal(reconcileProtocolOf("metaso"), "metaso");
  assert.equal(reconcileProtocolOf("openai_video"), "openai_video");
  assert.equal(reconcileProtocolOf("filmera"), "filmera");
  // 旧 default 分支涵盖的已知同步协议：显式 reconcileVia 保住原行为。
  assert.equal(reconcileProtocolOf("openai_images"), "newapi_video");
  assert.equal(reconcileProtocolOf("adobe2api"), "newapi_video");
  assert.equal(reconcileProtocolOf("blender_bridge"), "newapi_video");
  assert.throws(() => reconcileProtocolOf("no_such_protocol"), /Unknown supply protocol "no_such_protocol"/);
});

test("对帐轮询：未知协议明确失败（上层记 poll_error），不去打 new-api", async () => {
  const mock = captureFetch({});
  try {
    await assert.rejects(() => pollSupplyTask("no_such_protocol", supplier(), "task-x"), /Unknown supply protocol/);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("分派：未知 adapter_type → SupplierRequestError(400)，零上游呼叫", async () => {
  const mock = captureFetch({ data: [{ b64_json: "AAAA" }] });
  try {
    await assert.rejects(
      () => generateWithSupplier(supplier({ adapterType: "no_such_protocol" }), imageInput("gpt-image-2")),
      (error: unknown) => error instanceof SupplierRequestError && error.status === 400 && /Unknown supply protocol/.test(error.message),
    );
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("分派：openai_images 经 registry 仍打 /images/generations（回归保护）", async () => {
  const mock = captureFetch({ data: [{ b64_json: "BBBB" }] });
  try {
    const output = await generateWithSupplier(supplier(), imageInput("gpt-image-2"));
    assert.ok(mock.calls[0].url.endsWith("/images/generations"));
    assert.equal(JSON.parse(mock.calls[0].body).model, "gpt-image-2");
    assert.equal(output.base64, "BBBB");
    assert.equal(output.supplierModelId, "gpt-image-2");
  } finally {
    mock.restore();
  }
});

test("V-04：sub2api 别名由 configuration.modelAliases 资料驱动——gemini-3-image 仍送 gemini-3-pro-image", async () => {
  const mock = captureFetch({ data: [{ b64_json: "CCCC" }] });
  try {
    const sub2api = supplier({
      id: "env:sub2api",
      label: "sub2api",
      configuration: { modelAliases: { "gemini-3-image": "gemini-3-pro-image" } },
    });
    const output = await generateWithSupplier(sub2api, imageInput("gemini-3-image"));
    assert.equal(JSON.parse(mock.calls[0].body).model, "gemini-3-pro-image");
    assert.equal(output.supplierModelId, "gemini-3-pro-image");
    // 未列别名的模型同名直传。
    await generateWithSupplier(sub2api, imageInput("gpt-image-2"));
    assert.equal(JSON.parse(mock.calls[1].body).model, "gpt-image-2");
    // supplierModelId（capability 映射）优先于别名。
    await generateWithSupplier({ ...sub2api, supplierModelId: "explicit-upstream" }, imageInput("gemini-3-image"));
    assert.equal(JSON.parse(mock.calls[2].body).model, "explicit-upstream");
  } finally {
    mock.restore();
  }
});

test("V-04：分派不再认 supplier 身分——env:sub2api 没有别名资料就同名直传", async () => {
  const mock = captureFetch({ data: [{ b64_json: "DDDD" }] });
  try {
    await generateWithSupplier(supplier({ id: "env:sub2api", label: "sub2api" }), imageInput("gemini-3-image"));
    assert.equal(JSON.parse(mock.calls[0].body).model, "gemini-3-image");
  } finally {
    mock.restore();
  }
});
