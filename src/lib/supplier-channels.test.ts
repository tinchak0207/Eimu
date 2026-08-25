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
  seedPriority: 25,
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

test("registry 條目映射：configured + enabled 時有 endpoint 與 supportedModels", () => {
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

test("registry 條目映射：base URL 尾斜線被清掉、key 空白被清洗", () => {
  const descriptor = registryChannelToDescriptor(CHANNEL, {
    ...ENV,
    TESTCHANNEL_BASE_URL: "https://relay.example/v1/ ",
    TESTCHANNEL_API_KEY: " relay-key\n",
  });
  assert.equal(descriptor.endpoint!.baseURL, "https://relay.example/v1");
  assert.equal(descriptor.endpoint!.apiKey, "relay-key");
});

test("registry 條目映射：enabledEnv 缺 key 或清洗後非 true 時 defaultEnabled = false", () => {
  // 缺 key：configured = false → defaultEnabled = false。
  const noKey = registryChannelToDescriptor(CHANNEL, { TESTCHANNEL_BASE_URL: "https://relay.example/v1" });
  assert.equal(noKey.configured, false);
  assert.equal(noKey.defaultEnabled, false);
  assert.equal(noKey.endpoint, null);
  // enabled env 非 true（沿用 sub2apiSwitchedOn 的清洗語意："1"/"yes" 不算 true）。
  for (const value of ["false", "", " true ", "true\n", "True", "\uFEFFTRUE"]) {
    const descriptor = registryChannelToDescriptor(CHANNEL, { ...ENV, TESTCHANNEL_ENABLED: value });
    const expected = value.trim().replace(/^\uFEFF+/, "").toLowerCase() === "true";
    assert.equal(descriptor.defaultEnabled, expected, `${JSON.stringify(value)} 應為 ${expected}`);
  }
});

test("registry 條目映射：enabledEnv = null 時只看 configured", () => {
  const descriptor = registryChannelToDescriptor({ ...CHANNEL, enabledEnv: null }, ENV);
  assert.equal(descriptor.configured, true);
  assert.equal(descriptor.defaultEnabled, true);
});

test("純映射函數的優先級/白名單推導：sitePriority 進 ENV_CHANNEL_PRIORITIES、env:label 進 overridableChannelIds", () => {
  // 用同一份條目推導站點隊列的兩個登記點——真實 REGISTRY_CHANNELS 為空時，
  // 這裡驗證的是「條目存在時一定會被登記」的推導規則。
  const prioritiesFromRegistry = Object.fromEntries([[CHANNEL.label, CHANNEL.sitePriority]]);
  assert.equal(prioritiesFromRegistry[CHANNEL.label], 25);
  // 真實 config 為空：現有六渠道 + sensenova 不受影響。
  assert.ok(!Object.prototype.hasOwnProperty.call(ENV_CHANNEL_PRIORITIES, "testchannel"));
  for (const id of ["env:sub2api", "env:adobe2api", "env:pixai", "env:primary", "env:fallback", "sensenova"]) {
    assert.ok(overridableChannelIds().includes(id), `${id} 應保留在 overridableChannelIds`);
  }
});

test("describeEnvChannels：registry 條目插在 sub2api 之後、primary 之前（舊六渠道不受影響）", () => {
  const channels = describeEnvChannels({ ...ENV, SUB2API_ENABLED: "true" });
  const labels = channels.map((channel) => channel.label);
  assert.deepEqual(
    labels.filter((label) => ["adobe2api", "sub2api", "primary", "fallback", "filmera", "pixai"].includes(label)),
    ["adobe2api", "sub2api", "primary", "fallback", "filmera", "pixai"],
  );
  // registry 條目（若 config 有登記）會以 descriptor 形式出現在清單裡；
  // 目前 config 標記區為空 → describeEnvChannels 輸出的正是舊六渠道，零回歸。
  const testDescriptor = channels.find((channel) => channel.label === "testchannel");
  assert.equal(testDescriptor, undefined);
});

test("describeEnvChannels：未配置的 registry 渠道不產生 endpoint（配置前完全隱形）", () => {
  const channels = describeEnvChannels({});
  const registryLabels = new Set(REGISTRY_CHANNELS.map((channel) => channel.label));
  for (const channel of channels) {
    if (!registryLabels.has(channel.label)) continue;
    assert.equal(channel.configured, false);
    assert.equal(channel.endpoint, null);
    assert.equal(channel.defaultEnabled, false);
  }
});
