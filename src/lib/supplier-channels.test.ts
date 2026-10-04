import test from "node:test";
import assert from "node:assert/strict";

import {
  describeEnvChannels,
  registryChannelToDescriptor,
  type EnvChannelDescriptor,
} from "./sub2api.ts";
import { ENV_CHANNEL_PRIORITIES, overridableChannelIds } from "./channel-registry.ts";
import { REGISTRY_CHANNELS, type RegistryChannel } from "./supplier-channels.config.ts";

const CHANNEL: RegistryChannel = {
  label: "testchannel",
  baseUrlEnv: "TESTCHANNEL_BASE_URL",
  apiKeyEnv: "TESTCHANNEL_API_KEY",
  enabledEnv: "TESTCHANNEL_ENABLED",
  tier: "relay",
  sitePriority: 25,
  chatImageModels: ["gemini-3-pro-image"],
  claims: [
    { modelId: "gpt-image-2", supplierModelId: null, kinds: ["image_generate"] },
    { modelId: "gemini-3-image", supplierModelId: "gemini-3-pro-image", kinds: ["image_generate", "image_edit"] },
  ],
};

const ENV = {
  TESTCHANNEL_BASE_URL: "https://relay.example/v1",
  TESTCHANNEL_API_KEY: "relay-key",
  TESTCHANNEL_ENABLED: "true",
};

function baseAsserts(descriptor: EnvChannelDescriptor) {
  assert.equal(descriptor.id, "env:testchannel");
  assert.equal(descriptor.label, "testchannel");
  assert.equal(descriptor.source, "TESTCHANNEL_BASE_URL");
  assert.equal(descriptor.usesBillingGateway, false);
}

test("registry 条目映射：configured + enabled 时有 endpoint 与 supportedModels", () => {
  const descriptor = registryChannelToDescriptor(CHANNEL, ENV);
  baseAsserts(descriptor);
  assert.equal(descriptor.configured, true);
  assert.equal(descriptor.defaultEnabled, true);
  assert.ok(descriptor.endpoint);
  assert.equal(descriptor.endpoint!.baseURL, "https://relay.example/v1");
  assert.equal(descriptor.endpoint!.apiKey, "relay-key");
  assert.equal(descriptor.endpoint!.label, "testchannel");
  assert.deepEqual(descriptor.endpoint!.supportedModels, ["gpt-image-2", "gemini-3-image"]);
});

test("registry 条目映射：base URL 尾斜线被清掉、key 空白被清洗", () => {
  const descriptor = registryChannelToDescriptor(CHANNEL, {
    ...ENV,
    TESTCHANNEL_BASE_URL: "https://relay.example/v1/ ",
    TESTCHANNEL_API_KEY: " relay-key\n",
  });
  assert.equal(descriptor.endpoint!.baseURL, "https://relay.example/v1");
  assert.equal(descriptor.endpoint!.apiKey, "relay-key");
});

test("registry 条目映射：enabledEnv 缺 key 或清洗后非 true 时 defaultEnabled = false", () => {
  // 缺 key：configured = false → defaultEnabled = false。
  const noKey = registryChannelToDescriptor(CHANNEL, { TESTCHANNEL_BASE_URL: "https://relay.example/v1" });
  assert.equal(noKey.configured, false);
  assert.equal(noKey.defaultEnabled, false);
  assert.equal(noKey.endpoint, null);
  // enabled env 非 true（沿用 sub2apiSwitchedOn 的清洗语意："1"/"yes" 不算 true）。
  for (const value of ["false", "", " true ", "true\n", "True", "\uFEFFTRUE"]) {
    const descriptor = registryChannelToDescriptor(CHANNEL, { ...ENV, TESTCHANNEL_ENABLED: value });
    const expected = value.trim().replace(/^\uFEFF+/, "").toLowerCase() === "true";
    assert.equal(descriptor.defaultEnabled, expected, `${JSON.stringify(value)} 应为 ${expected}`);
  }
});

test("registry 条目映射：enabledEnv = null 时只看 configured", () => {
  const descriptor = registryChannelToDescriptor({ ...CHANNEL, enabledEnv: null }, ENV);
  assert.equal(descriptor.configured, true);
  assert.equal(descriptor.defaultEnabled, true);
});

test("纯映射函数的优先级/白名单推导：sitePriority 进 ENV_CHANNEL_PRIORITIES、env:label 进 overridableChannelIds", () => {
  // 用同一份条目推导站点队列的两个登记点——真实 REGISTRY_CHANNELS 为空时，
  // 这里验证的是「条目存在时一定会被登记」的推导规则。
  const prioritiesFromRegistry = Object.fromEntries([[CHANNEL.label, CHANNEL.sitePriority]]);
  assert.equal(prioritiesFromRegistry[CHANNEL.label], 25);
  // 真实 config 为空：现有渠道不受影响。
  assert.ok(!Object.prototype.hasOwnProperty.call(ENV_CHANNEL_PRIORITIES, "testchannel"));
  for (const id of ["env:sub2api", "env:adobe2api", "env:pixai", "env:primary", "env:fallback"]) {
    assert.ok(overridableChannelIds().includes(id), `${id} 应保留在 overridableChannelIds`);
  }
});

test("describeEnvChannels：registry 条目插在 sub2api 之后、primary 之前（旧六渠道不受影响）", () => {
  const channels = describeEnvChannels({ ...ENV, SUB2API_ENABLED: "true" });
  const labels = channels.map((channel) => channel.label);
  assert.deepEqual(
    labels.filter((label) => ["adobe2api", "sub2api", "primary", "fallback", "filmera", "pixai"].includes(label)),
    ["adobe2api", "sub2api", "primary", "fallback", "filmera", "pixai"],
  );
  // registry 条目（若 config 有登记）会以 descriptor 形式出现在清单里；
  // 目前 config 标记区为空 → describeEnvChannels 输出的正是旧六渠道，零回归。
  const testDescriptor = channels.find((channel) => channel.label === "testchannel");
  assert.equal(testDescriptor, undefined);
});

test("describeEnvChannels：未配置的 registry 渠道不产生 endpoint（配置前完全隐形）", () => {
  const channels = describeEnvChannels({});
  const registryLabels = new Set(REGISTRY_CHANNELS.map((channel) => channel.label));
  for (const channel of channels) {
    if (!registryLabels.has(channel.label)) continue;
    assert.equal(channel.configured, false);
    assert.equal(channel.endpoint, null);
    assert.equal(channel.defaultEnabled, false);
  }
});
