import test from "node:test";
import assert from "node:assert/strict";

import {
  __resetChannelHealthForTests,
  buildModelQueue,
  describeChannels,
  isEndpointCoolingDown,
  overridableChannelIds,
  prioritizeHealthyEndpoints,
  recordEndpointFailure,
  recordEndpointSuccess,
} from "./channel-registry.ts";
import { buildGatewayEndpoints } from "./sub2api.ts";
import { buildGatewayEndpointsWithPools, type AdminPool } from "./admin-pools.ts";
import { REGISTRY_CHANNELS } from "./supplier-channels.config.ts";

const FULL_ENV = {
  SUB2API_ENABLED: "true",
  SUB2API_BASE_URL: "https://sub2api.example/v1",
  SUB2API_API_KEY: "sub-key",
  IMAGE_API_BASE_URL: "https://primary.example/v1",
  IMAGE_API_KEY: "primary-key",
  IMAGE_API_BASE_URL_FALLBACK: "https://fallback.example/v1",
  IMAGE_API_KEY_FALLBACK: "fallback-key",
};

function pool(overrides: Partial<AdminPool>): AdminPool {
  return {
    id: "p1",
    kind: "relay",
    name: "relay-pool",
    baseURL: "https://pool.example/v1",
    apiKey: "pool-key",
    supportedModels: ["gpt-image-2"],
    priority: 10,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("零 overrides 時 buildModelQueue 與既有生產路徑產出相同的端點集合與順序", () => {
  __resetChannelHealthForTests();
  const pools = [pool({})];
  const unified = buildModelQueue("gpt-image-2", FULL_ENV, pools, {});
  const legacy = buildGatewayEndpointsWithPools(pools, buildGatewayEndpoints(FULL_ENV), "gpt-image-2");

  // 固定優先級表在「全渠道都配置」時與舊的索引推算同值，因此順序必須一致。
  assert.deepEqual(
    unified.map((endpoint) => `${endpoint.label}@${endpoint.baseURL}`),
    legacy.map((endpoint) => `${endpoint.label}@${endpoint.baseURL}`),
  );
});

test("停用 env:sub2api 後 sub2api 退出隊列，其餘渠道順序不漂移", () => {
  __resetChannelHealthForTests();
  const before = buildModelQueue("gpt-image-2", FULL_ENV, [], {});
  assert.ok(before.some((endpoint) => endpoint.label === "sub2api"));

  const after = buildModelQueue("gpt-image-2", FULL_ENV, [], { "env:sub2api": { enabled: false } });
  assert.ok(!after.some((endpoint) => endpoint.label === "sub2api"));
  // 索引漂移守護：sub2api 消失不得改變 firefly 與 fallback 的相對優先級。
  assert.deepEqual(
    after.map((endpoint) => endpoint.label),
    before.filter((endpoint) => endpoint.label !== "sub2api").map((endpoint) => endpoint.label),
  );
});

test("SUB2API_ENABLED 清洗後判定：空白/BOM/大小寫變體視為 true，其他值仍為關閉", () => {
  __resetChannelHealthForTests();
  // 真實事故形態：stdin 添加 env 帶結尾換行、貼上帶 BOM——開關靜默失效、
  // 賬號池永遠 "never used"。清洗後這些變體必須生效，且 sub2api/primary 互斥不變。
  for (const value of ["true", " true ", "true\n", "True", "\uFEFFTRUE"]) {
    const queue = buildModelQueue("gpt-image-2", { ...FULL_ENV, SUB2API_ENABLED: value }, [], {});
    assert.ok(queue.some((endpoint) => endpoint.label === "sub2api"), `${JSON.stringify(value)} 應啟用 sub2api`);
    assert.ok(!queue.some((endpoint) => endpoint.label === "primary"), `${JSON.stringify(value)} 下 primary 應維持預設關閉`);
  }
  // 意圖不變：只有肯定的 true 開啟——"1"/"yes" 這類值不猜測語意。
  for (const value of ["1", "yes", "false", "", "truthy"]) {
    const queue = buildModelQueue("gpt-image-2", { ...FULL_ENV, SUB2API_ENABLED: value }, [], {});
    assert.ok(!queue.some((endpoint) => endpoint.label === "sub2api"), `${JSON.stringify(value)} 不應啟用 sub2api`);
    assert.ok(queue.some((endpoint) => endpoint.label === "primary"), `${JSON.stringify(value)} 下 primary 應為預設開啟`);
  }
});

test("SUB2API_ENABLED=true 時 override 可讓 primary 復活——緊急切換不再需要重新部署", () => {
  __resetChannelHealthForTests();
  const defaultQueue = buildModelQueue("gpt-image-2", FULL_ENV, [], {});
  assert.ok(!defaultQueue.some((endpoint) => endpoint.label === "primary"), "預設行為必須維持互斥");

  const flipped = buildModelQueue("gpt-image-2", FULL_ENV, [], {
    "env:sub2api": { enabled: false },
    "env:primary": { enabled: true },
  });
  assert.ok(flipped.some((endpoint) => endpoint.label === "primary"));
  assert.ok(!flipped.some((endpoint) => endpoint.label === "sub2api"));
});

test("Adobe2API is selected before Sub2API for supported partner image and video models", () => {
  __resetChannelHealthForTests();
  const env = {
    ...FULL_ENV,
    ADOBE2API_ENABLED: "true",
    ADOBE2API_BASE_URL: "https://adobe2api.example/v1",
    ADOBE2API_API_KEY: "adobe2api-key",
  };

  assert.equal(buildModelQueue("gpt-image-2", env, [], {})[0]?.label, "adobe2api");
  assert.equal(buildModelQueue("gemini-3.1-flash-image", env, [], {})[0]?.label, "adobe2api");
  assert.equal(buildModelQueue("seedance-2.0", env, [], {})[0]?.label, "adobe2api");
  assert.equal(buildModelQueue("adobe-firefly", env, [], {})[0]?.label, "adobe2api");
});

test("優先級 override 能把 env 渠道排到池後面", () => {
  __resetChannelHealthForTests();
  const pools = [pool({ priority: 5 })];
  const reordered = buildModelQueue("gpt-image-2", FULL_ENV, pools, { "env:sub2api": { priority: 20 } });
  const labels = reordered.map((endpoint) => endpoint.label);
  assert.ok(labels.indexOf("relay-pool") < labels.indexOf("sub2api"));
});

test("describeChannels 枚舉未配置渠道並如實標注 override 狀態", () => {
  __resetChannelHealthForTests();
  const bareEnv = { SUB2API_ENABLED: "true" };
  const channels = describeChannels(bareEnv, [], {});

  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  // 未配置的渠道必須出現且標明未配置——不是隱形。
  for (const id of ["env:sub2api", "env:adobe2api", "env:pixai", "env:primary", "env:fallback"]) {
    const channel = byId.get(id);
    assert.ok(channel, `${id} 必須被枚舉`);
    assert.equal(channel.configured, false);
    assert.equal(channel.enabled, false);
  }

  const withOverride = describeChannels(FULL_ENV, [pool({})], {
    "env:sub2api": { enabled: false, priority: 30 },
  });
  const sub2api = withOverride.find((channel) => channel.id === "env:sub2api");
  assert.ok(sub2api);
  assert.equal(sub2api.configured, true);
  assert.equal(sub2api.defaultEnabled, true);
  assert.equal(sub2api.enabled, false);
  assert.equal(sub2api.priority, 30);
  assert.equal(sub2api.basePriority, 0);
  assert.deepEqual(sub2api.overridden, { enabled: true, priority: true });

  const poolChannel = withOverride.find((channel) => channel.id === "pool:p1");
  assert.ok(poolChannel);
  assert.equal(poolChannel.kind, "pool");
  assert.equal(poolChannel.priority, 10);
  assert.ok(!poolChannel.host.includes("pool-key"), "host 絕不得含 key");
});

test("describeChannels 揭露計費閘道兼職生圖的危險耦合", () => {
  __resetChannelHealthForTests();
  const env = {
    SUB2API_ENABLED: "false",
    GATEWAY_BASE_URL: "https://billing-gateway.example",
    GATEWAY_API_KEY: "billing-key",
  };
  const primary = describeChannels(env, [], {}).find((channel) => channel.id === "env:primary");
  assert.ok(primary);
  assert.equal(primary.configured, true);
  assert.equal(primary.usesBillingGateway, true);
  assert.equal(primary.source, "GATEWAY_BASE_URL");
});

test("共享 circuit breaker：兩次失敗觸發冷卻、降級到隊尾而非剔除、成功即恢復", () => {
  __resetChannelHealthForTests();
  const endpoint = { label: "sub2api", baseURL: "https://sub2api.example/v1" };
  assert.equal(isEndpointCoolingDown(endpoint), false);

  recordEndpointFailure(endpoint);
  assert.equal(isEndpointCoolingDown(endpoint), false, "單次失敗不冷卻");
  recordEndpointFailure(endpoint);
  assert.equal(isEndpointCoolingDown(endpoint), true);

  const other = { label: "fallback", baseURL: "https://fallback.example/v1" };
  const reordered = prioritizeHealthyEndpoints([endpoint, other]);
  assert.deepEqual(reordered.map((item) => item.label), ["fallback", "sub2api"]);
  assert.equal(reordered.length, 2, "冷卻端點降級而非剔除");

  recordEndpointSuccess(endpoint);
  assert.equal(isEndpointCoolingDown(endpoint), false);
  __resetChannelHealthForTests();
});

test("overrides 白名單只含 env 渠道——池由自己的 CRUD 管轄", () => {
  const ids = overridableChannelIds();
  assert.deepEqual(
    [...ids].sort(),
    [...["env:adobe2api", "env:fallback", "env:pixai", "env:primary", "env:sub2api"],
      ...REGISTRY_CHANNELS.map((channel) => `env:${channel.label}`)].sort(),
  );
  assert.ok(!ids.some((id) => id.startsWith("pool:")));
});
