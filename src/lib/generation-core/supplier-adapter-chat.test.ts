import assert from "node:assert/strict";
import test from "node:test";

import { chatImageOutput, generateWithSupplier } from "./supplier-adapter.ts";
import type { SupplierGenerationInput, SupplierRecord } from "./types.ts";

process.env.HUBTEST_API_KEY = "hub-key";

function supplier(overrides: Partial<SupplierRecord> = {}): SupplierRecord {
  return {
    id: "env:hubtest",
    label: "hubtest",
    adapterType: "openai_images",
    supplyTier: "relay",
    failureDomain: "hub.example",
    baseUrl: "https://hub.example/v1",
    credentialRef: "HUBTEST_API_KEY",
    configuration: { chatImageModels: ["gemini-3-pro-image"] },
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
      id: "env:hubtest:default",
      supplierId: "env:hubtest",
      label: "hubtest default account",
      credentialRef: "HUBTEST_API_KEY",
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

function input(modelId: string): SupplierGenerationInput {
  return {
    jobId: "job-1",
    attemptId: "attempt-1",
    modelId,
    supplierModelId: null,
    prompt: "a red apple on a white table",
    kind: "image_generate",
    size: "1024x1024",
    ratio: "1:1",
    resolution: "1k",
    quality: "medium",
    workflow: {},
  };
}

function mockFetch(routes: Array<{ match: (url: string) => boolean; body: unknown; status?: number }>) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (fetchInput: RequestInfo | URL, init?: RequestInit) => {
    const url = String(fetchInput);
    calls.push({ url, body: init?.body });
    const route = routes.find((r) => r.match(url));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      text: async () => JSON.stringify(route.body),
      json: async () => route.body,
      headers: new Headers(),
    } as Response;
  }) as typeof fetch;
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

test("chatImageOutput：data URL 优先抽 base64（取第一个）", () => {
  const content = "前缀文字 ![image](data:image/jpeg;base64,/9j/4AAQSkZJRg==) 中缀 ![image](data:image/png;base64,AAAA) 后缀";
  const result = chatImageOutput(content);
  assert.equal(result.base64, "/9j/4AAQSkZJRg==");
  assert.equal(result.url, null);
});

test("chatImageOutput：没有 data URL 时抽 http URL markdown", () => {
  const content = "看这张 ![generated](https://cdn.example/img.png)";
  const result = chatImageOutput(content);
  assert.equal(result.base64, null);
  assert.equal(result.url, "https://cdn.example/img.png");
});

test("chatImageOutput：两者皆无 → null/null", () => {
  const result = chatImageOutput("模型只回了纯文字");
  assert.equal(result.base64, null);
  assert.equal(result.url, null);
});

test("chat 模型走 /chat/completions：content 抽 base64 成功", async () => {
  const mock = mockFetch([
    {
      match: (u) => u.endsWith("/chat/completions"),
      body: { choices: [{ message: { content: "![image](data:image/jpeg;base64,/9j/4AAQ)" } }] },
    },
  ]);
  try {
    const output = await generateWithSupplier(supplier({ supplierModelId: "gemini-3-pro-image" }), input("gemini-3-image"));
    assert.equal(mock.calls.length, 1);
    assert.ok(mock.calls[0].url.endsWith("/chat/completions"), "应打 /chat/completions");
    const body = JSON.parse(String(mock.calls[0].body));
    assert.equal(body.model, "gemini-3-pro-image");
    assert.equal(body.messages[0].role, "user");
    assert.equal(body.messages[0].content, "a red apple on a white table");
    assert.equal(output.base64, "/9j/4AAQ");
    assert.equal(output.url, null);
    assert.equal(output.endpointLabel, "hubtest");
  } finally {
    mock.restore();
  }
});

test("chat 模型走 /chat/completions：content 抽 http URL 成功", async () => {
  const mock = mockFetch([
    {
      match: (u) => u.endsWith("/chat/completions"),
      body: { choices: [{ message: { content: "![image](https://cdn.example/img.png)" } }] },
    },
  ]);
  try {
    const output = await generateWithSupplier(supplier({ supplierModelId: "gemini-3-pro-image" }), input("gemini-3-image"));
    assert.equal(output.base64, null);
    assert.equal(output.url, "https://cdn.example/img.png");
  } finally {
    mock.restore();
  }
});

test("chat 模型带 references：请求体是多段 content（text + image_url）", async () => {
  const mock = mockFetch([
    {
      match: (u) => u.endsWith("/chat/completions"),
      body: { choices: [{ message: { content: "![image](data:image/png;base64,AAAA)" } }] },
    },
  ]);
  try {
    const output = await generateWithSupplier(supplier({ supplierModelId: "gemini-3-pro-image" }), {
      ...input("gemini-3-image"),
      workflow: { references: [{ url: "https://cdn.example/ref.png", mimeType: "image/png" }] },
    });
    const body = JSON.parse(String(mock.calls[0].body));
    assert.deepEqual(body.messages[0].content, [
      { type: "text", text: "a red apple on a white table" },
      { type: "image_url", image_url: { url: "https://cdn.example/ref.png" } },
    ]);
    assert.equal(output.base64, "AAAA");
  } finally {
    mock.restore();
  }
});

test("chat 模型空结果：报 Supplier result was empty", async () => {
  const mock = mockFetch([
    {
      match: (u) => u.endsWith("/chat/completions"),
      body: { choices: [{ message: { content: "模型只回了纯文字" } }] },
    },
  ]);
  try {
    await assert.rejects(
      generateWithSupplier(supplier({ supplierModelId: "gemini-3-pro-image" }), input("gemini-3-image")),
      /Supplier chat image result was empty\. Content preview: 模型只回了纯文字/,
    );
  } finally {
    mock.restore();
  }
});

test("非 chat 模型仍走 /images/generations（回归保护）", async () => {
  const mock = mockFetch([
    {
      match: (u) => u.endsWith("/images/generations"),
      body: { data: [{ b64_json: "BBBB" }] },
    },
  ]);
  try {
    const output = await generateWithSupplier(supplier(), input("gpt-image-2"));
    assert.ok(mock.calls[0].url.endsWith("/images/generations"), "应打 /images/generations");
    assert.equal(output.base64, "BBBB");
  } finally {
    mock.restore();
  }
});

test("chatImageModels 未配置时：模型不走 chat 路径（回归保护）", async () => {
  const mock = mockFetch([
    {
      match: (u) => u.endsWith("/images/generations"),
      body: { data: [{ url: "https://cdn.example/img.png" }] },
    },
  ]);
  try {
    const output = await generateWithSupplier(
      supplier({ configuration: {} }),
      input("gemini-3-image"),
    );
    assert.ok(mock.calls[0].url.endsWith("/images/generations"));
    assert.equal(output.url, "https://cdn.example/img.png");
  } finally {
    mock.restore();
  }
});
