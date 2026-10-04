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

test("零 overrides 时 buildModelQueue 与既有生产路径产出相同的端点集合与顺序", () => {
  __resetChannelHealthForTests();
  const pools = [pool({})];
  const unified = buildModelQueue("gpt-image-2", FULL_ENV, pools, {});
  const legacy = buildGatewayEndpointsWithPools(pools, buildGatewayEndpoints(FULL_ENV), "gpt-image-2");

  // 固定优先级表在「全渠道都配置」时与旧的索引推算同值，因此顺序必须一致。
  assert.deepEqual(
    unified.map((endpoint) => `${endpoint.label}@${endpoint.baseURL}`),
    legacy.map((endpoint) => `${endpoint.label}@${endpoint.baseURL}`),
  );
});

test("停用 env:sub2api 后 sub2api 退出队列，其余渠道顺序不漂移", () => {
  __resetChannelHealthForTests();
  const before = buildModelQueue("gpt-image-2", FULL_ENV, [], {});
  assert.ok(before.some((endpoint) => endpoint.label === "sub2api"));

  const after = buildModelQueue("gpt-image-2", FULL_ENV, [], { "env:sub2api": { enabled: false } });
  assert.ok(!after.some((endpoint) => endpoint.label === "sub2api"));
  // 索引漂移守护：sub2api 消失不得改变 firefly 与 fallback 的相对优先级。
  assert.deepEqual(
    after.map((endpoint) => endpoint.label),
    before.filter((endpoint) => endpoint.label !== "sub2api").map((endpoint) => endpoint.label),
  );
});

test("SUB2API_ENABLED 清洗后判定：空白/BOM/大小写变体视为 true，其他值仍为关闭", () => {
  __resetChannelHealthForTests();
  // 真实事故形态：stdin 添加 env 带结尾换行、贴上带 BOM——开关静默失效、
  // 账号池永远 "never used"。清洗后这些变体必须生效，且 sub2api/primary 互斥不变。
  for (const value of ["true", " true ", "true\n", "True", "\uFEFFTRUE"]) {
    const queue = buildModelQueue("gpt-image-2", { ...FULL_ENV, SUB2API_ENABLED: value }, [], {});
    assert.ok(queue.some((endpoint) => endpoint.label === "sub2api"), `${JSON.stringify(value)} 应启用 sub2api`);
    assert.ok(!queue.some((endpoint) => endpoint.label === "primary"), `${JSON.stringify(value)} 下 primary 应维持预设关闭`);
  }
  // 意图不变：只有肯定的 true 开启——"1"/"yes" 这类值不猜测语意。
  for (const value of ["1", "yes", "false", "", "truthy"]) {
    const queue = buildModelQueue("gpt-image-2", { ...FULL_ENV, SUB2API_ENABLED: value }, [], {});
    assert.ok(!queue.some((endpoint) => endpoint.label === "sub2api"), `${JSON.stringify(value)} 不应启用 sub2api`);
    assert.ok(queue.some((endpoint) => endpoint.label === "primary"), `${JSON.stringify(value)} 下 primary 应为预设开启`);
  }
});

test("SUB2API_ENABLED=true 时 override 可让 primary 复活——紧急切换不再需要重新部署", () => {
  __resetChannelHealthForTests();
  const defaultQueue = buildModelQueue("gpt-image-2", FULL_ENV, [], {});
  assert.ok(!defaultQueue.some((endpoint) => endpoint.label === "primary"), "预设行为必须维持互斥");

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
  // 2026-09-27 暴君裁定「adobe2api 留图、停视频」（视频唯一权威＝xiaoyxiao）：
  // adobe2api 不再承接任何视频 model（ADOBE2API_MODEL_IDS 只留图像；对应 capability
  // 由 seed 的 retireUnclaimedCapabilities 退役）。
  assert.notEqual(buildModelQueue("seedance-2.0", env, [], {})[0]?.label, "adobe2api");
  assert.equal(buildModelQueue("adobe-firefly", env, [], {})[0]?.label, "adobe2api");
});

test("优先级 override 能把 env 渠道排到池后面", () => {
  __resetChannelHealthForTests();
  const pools = [pool({ priority: 5 })];
  const reordered = buildModelQueue("gpt-image-2", FULL_ENV, pools, { "env:sub2api": { priority: 20 } });
  const labels = reordered.map((endpoint) => endpoint.label);
  assert.ok(labels.indexOf("relay-pool") < labels.indexOf("sub2api"));
});

test("describeChannels 枚举未配置渠道并如实标注 override 状态", () => {
  __resetChannelHealthForTests();
  const bareEnv = { SUB2API_ENABLED: "true" };
  const channels = describeChannels(bareEnv, [], {});

  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  // 未配置的渠道必须出现且标明未配置——不是隐形。
  for (const id of ["env:sub2api", "env:adobe2api", "env:pixai", "env:primary", "env:fallback"]) {
    const channel = byId.get(id);
    assert.ok(channel, `${id} 必须被枚举`);
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
  assert.ok(!poolChannel.host.includes("pool-key"), "host 绝不得含 key");
});

test("describeChannels 揭露计费闸道兼职生图的危险耦合", () => {
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

test("共享 circuit breaker：两次失败触发冷却、降级到队尾而非剔除、成功即恢复", () => {
  __resetChannelHealthForTests();
  const endpoint = { label: "sub2api", baseURL: "https://sub2api.example/v1" };
  assert.equal(isEndpointCoolingDown(endpoint), false);

  recordEndpointFailure(endpoint);
  assert.equal(isEndpointCoolingDown(endpoint), false, "单次失败不冷却");
  recordEndpointFailure(endpoint);
  assert.equal(isEndpointCoolingDown(endpoint), true);

  const other = { label: "fallback", baseURL: "https://fallback.example/v1" };
  const reordered = prioritizeHealthyEndpoints([endpoint, other]);
  assert.deepEqual(reordered.map((item) => item.label), ["fallback", "sub2api"]);
  assert.equal(reordered.length, 2, "冷却端点降级而非剔除");

  recordEndpointSuccess(endpoint);
  assert.equal(isEndpointCoolingDown(endpoint), false);
  __resetChannelHealthForTests();
});

test("overrides 白名单只含 env 渠道——池由自己的 CRUD 管辖", () => {
  const ids = overridableChannelIds();
  assert.deepEqual(
    [...ids].sort(),
    [...["env:adobe2api", "env:fallback", "env:pixai", "env:primary", "env:sub2api"],
      ...REGISTRY_CHANNELS.map((channel) => `env:${channel.label}`)].sort(),
  );
  assert.ok(!ids.some((id) => id.startsWith("pool:")));
});
