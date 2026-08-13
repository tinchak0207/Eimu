import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGatewayEndpointsWithPools,
  environmentEndpointPriority,
  inferSupportedModels,
  maskPoolApiKey,
  normalizePoolDraft,
  type AdminPool,
} from "./admin-pools.ts";
import { buildGatewayEndpoints } from "./sub2api.ts";
import { ADOBE_FIREFLY_MODEL_ID } from "./provider-config.ts";

test("configured Adobe Firefly endpoints remain isolated from other model routes", () => {
  assert.deepEqual(inferSupportedModels({ modelId: ADOBE_FIREFLY_MODEL_ID }), [ADOBE_FIREFLY_MODEL_ID]);
});

test("pool drafts only accept Base URL and API key relay settings", () => {
  assert.deepEqual(
    normalizePoolDraft({
      kind: "relay",
      name: "  主号池  ",
      baseURL: "https://pool.example.com/v1/",
      apiKey: "  sk-secret  ",
      supportedModels: ["gpt-image-2"],
      enabled: true,
      priority: 12,
    }),
    {
      kind: "relay",
      name: "主号池",
      baseURL: "https://pool.example.com/v1",
      apiKey: "sk-secret",
      supportedModels: ["gpt-image-2"],
      enabled: true,
      priority: 12,
    },
  );
  assert.throws(() => normalizePoolDraft({ kind: "sub2api", name: "x" }), /中转渠道/);
  assert.throws(() => normalizePoolDraft({ kind: "custom", name: "x" }), /中转渠道/);
});

test("pool API keys are masked before returning to the browser", () => {
  assert.equal(maskPoolApiKey("sk-1234567890abcdef"), "sk-1**********cdef");
  assert.equal(maskPoolApiKey("short"), "*****");
});

test("enabled admin pools lead the endpoint chain and env endpoints remain fallback", () => {
  const pools: AdminPool[] = [
    {
      id: "backup",
      kind: "relay",
      name: "备用中转",
      baseURL: "https://backup.example.com/v1",
      apiKey: "backup-key",
      enabled: true,
      priority: 20,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "primary",
      kind: "sub2api",
      name: "主号池",
      baseURL: "https://pool.example.com/v1",
      apiKey: "pool-key",
      supportedModels: ["gpt-image-2"],
      enabled: true,
      priority: 10,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "off",
      kind: "relay",
      name: "停用",
      baseURL: "https://off.example.com/v1",
      apiKey: "off-key",
      enabled: false,
      priority: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  const endpoints = buildGatewayEndpointsWithPools(pools, buildGatewayEndpoints({
    IMAGE_API_BASE_URL: "https://env.example.com/v1",
    IMAGE_API_KEY: "env-key",
  }), "gpt-image-2");

  assert.deepEqual(endpoints.map((endpoint) => endpoint.label), ["主号池", "备用中转", "primary"]);
  assert.deepEqual(endpoints.map((endpoint) => endpoint.isFallback), [false, true, true]);
  assert.deepEqual(endpoints[0].supportedModels, ["gpt-image-2"]);
  assert.equal(endpoints.some((endpoint) => endpoint.baseURL.includes("off.example.com")), false);
});

test("scheduler filters by requested model and merges admin and env priorities", () => {
  const pools: AdminPool[] = [
    { id: "banana", kind: "relay", name: "banana", baseURL: "https://banana.example/v1", apiKey: "b", supportedModels: ["gemini-3.1-flash-image"], enabled: true, priority: 5, createdAt: 1, updatedAt: 1 },
    { id: "gpt", kind: "relay", name: "gpt", baseURL: "https://gpt.example/v1", apiKey: "g", supportedModels: ["gpt-image-2"], enabled: true, priority: 10, createdAt: 1, updatedAt: 1 },
    { id: "both", kind: "relay", name: "both", baseURL: "https://both.example/v1", apiKey: "x", supportedModels: ["gpt-image-2", "gemini-3.1-flash-image"], enabled: true, priority: 70, createdAt: 1, updatedAt: 1 },
  ];
  const environment = buildGatewayEndpoints({
    IMAGE_API_BASE_URL: "https://env-gpt.example/v1",
    IMAGE_API_KEY: "env-gpt",
    IMAGE_API_MODEL: "gpt-image-2",
    IMAGE_API_BASE_URL_FALLBACK: "https://env-banana.example/v1",
    IMAGE_API_KEY_FALLBACK: "env-banana",
    IMAGE_API_MODEL_FALLBACK: "gemini-3.1-flash-image",
  });

  assert.deepEqual(
    buildGatewayEndpointsWithPools(pools, environment, "gpt-image-2").map((endpoint) => endpoint.label),
    ["gpt", "primary", "both"],
  );
  assert.deepEqual(
    buildGatewayEndpointsWithPools(pools, environment, "gemini-3.1-flash-image").map((endpoint) => endpoint.label),
    ["banana", "both", "fallback"],
  );
  assert.equal(environmentEndpointPriority(environment[0], 0), 50);
  assert.equal(environmentEndpointPriority(environment[1], 1), 90);
});

test("Sub2API precedes managed relays so its account scheduler owns K12 priority", () => {
  const pools: AdminPool[] = [
    { id: "relay", kind: "relay", name: "relay", baseURL: "https://relay.example/v1", apiKey: "relay-key", supportedModels: ["gpt-image-2"], enabled: true, priority: 1, createdAt: 1, updatedAt: 1 },
  ];
  const environment = buildGatewayEndpoints({
    SUB2API_ENABLED: "true",
    SUB2API_BASE_URL: "https://sub2api.example/v1",
    SUB2API_API_KEY: "sub2api-key",
  });

  assert.deepEqual(
    buildGatewayEndpointsWithPools(pools, environment, "gpt-image-2").map((endpoint) => endpoint.label),
    ["sub2api", "relay"],
  );
  assert.equal(environmentEndpointPriority(environment[0], 0), 0);
});

test("legacy banana-named pools are automatically restricted to the banana model", () => {
  const legacy: AdminPool = {
    id: "legacy", kind: "relay", name: "Banana Endpoint", baseURL: "https://legacy.example/v1", apiKey: "k",
    enabled: true, priority: 1, createdAt: 1, updatedAt: 1,
  };
  assert.equal(buildGatewayEndpointsWithPools([legacy], [], "gpt-image-2").length, 0);
  assert.equal(buildGatewayEndpointsWithPools([legacy], [], "gemini-3.1-flash-image").length, 1);
});

test("unclassified legacy and env channels default to GPT only", () => {
  const endpoint = buildGatewayEndpoints({ IMAGE_API_BASE_URL: "https://legacy.example/v1", IMAGE_API_KEY: "k" });
  assert.equal(buildGatewayEndpointsWithPools([], endpoint, "gpt-image-2").length, 1);
  assert.equal(buildGatewayEndpointsWithPools([], endpoint, "gemini-3.1-flash-image").length, 0);
});
