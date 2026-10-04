import test from "node:test";
import assert from "node:assert/strict";

import {
  DEV_QUICKSTART_BALANCE_NOTE,
  DEV_QUICKSTART_BASE_URL,
  DEV_QUICKSTART_PRICING_URL,
  buildGenerationCurl,
  pixaiShowcaseModelId,
  quickstartCurlExamples,
  quickstartExampleSize,
} from "./dev-quickstart.ts";
import { GENERATION_MODEL_CATALOG, IMAGE_MODEL_IDS, generationModel } from "./generation-model-catalog";

/** 占位金钥：测试与回报一律不入真实凭证。 */
const PLACEHOLDER_KEY = "sk-biz-placeholder";

test("范例：gpt-image-2 段落逐字命中 spec 的 model/prompt/size", () => {
  const examples = quickstartCurlExamples(PLACEHOLDER_KEY);
  const general = examples.find((item) => item.modelId === "gpt-image-2");
  assert.ok(general, "通用段落必须存在（catalog 内有 gpt-image-2）");
  assert.match(general.curl, /"model":"gpt-image-2"/);
  assert.match(general.curl, /"prompt":"一只橘猫趴在窗台上，水彩风格"/);
  assert.match(general.curl, /"size":"1024x1024"/);
  assert.match(general.curl, /-X POST https:\/\/eimu\.dev\/v1\/images\/generations/);
});

test("范例：PixAI 段落 model id 由 catalog 真源推导，且在白名单与 catalog 同时存在", () => {
  const examples = quickstartCurlExamples(PLACEHOLDER_KEY);
  const pixai = examples.find((item) => item.modelId.startsWith("pixai-"));
  assert.ok(pixai, "二次元段落必须存在（catalog 内有可用 pixai 模型）");

  // 跨档交叉验证：可见白名单（image-model-ids.js）与 catalog 两份来源都必须认得它。
  assert.ok(IMAGE_MODEL_IDS.includes(pixai.modelId), "id 必须在使用者可见模型白名单内");
  const definition = GENERATION_MODEL_CATALOG[pixai.modelId];
  assert.ok(definition, "id 必须存在于 GENERATION_MODEL_CATALOG");
  assert.equal(definition.kind, "image");
  assert.equal(definition.vendor, "PixAI");

  // 范例 curl 真的用了这颗推导出来的 id，size 由该模型预设比例推导。
  assert.ok(pixai.curl.includes(`"model":"${pixai.modelId}"`), "curl 的 model 必须是推导值");
  const size = quickstartExampleSize(pixai.modelId);
  assert.ok(size && pixai.curl.includes(`"size":"${size}"`), "curl 的 size 必须由 catalog 预设比例推导");
});

test("范例：两段都代入呼叫端传入的金钥明文，不内建任何金钥", () => {
  const examples = quickstartCurlExamples(PLACEHOLDER_KEY);
  assert.ok(examples.length >= 2, "通用 + 二次元两段");
  for (const example of examples) {
    assert.ok(example.curl.includes(`Bearer ${PLACEHOLDER_KEY}`), `${example.title} 必须代入传入的金钥`);
  }
  // 未传金钥时不得组出任何字面金钥（防止把示范值写死成看起来可用的 key）。
  const empty = quickstartCurlExamples("");
  for (const example of empty) {
    assert.doesNotMatch(example.curl, /Bearer sk-/, "空金钥不得渲染成 sk- 假金钥");
  }
});

test("pixaiShowcaseModelId：catalog 为空回 null，绝不编造硬编码 id", () => {
  assert.equal(pixaiShowcaseModelId({}, []), null);
  // 只有偏好序以外的 pixai 条目时，不得回偏好序里的幻影 id。
  assert.equal(pixaiShowcaseModelId({}, ["pixai-tsubaki2"]), null, "白名单有但 catalog 无 → 不算存在");
  assert.equal(pixaiShowcaseModelId({ "pixai-tsubaki2": {} }, []), null, "catalog 有但白名单无 → 不可见");
});

test("pixaiShowcaseModelId：偏好序落空时退到 catalog 内实际存在的 pixai 条目", () => {
  assert.equal(
    pixaiShowcaseModelId({ "pixai-haruka-v2": {} }, ["pixai-haruka-v2"]),
    "pixai-haruka-v2",
    "偏好序首位缺失时取实际存在的替代",
  );
  // 默认参数（真实 catalog）首位是 Tsubaki.2（catalog 内 promotionTag「推荐」的二次元主力）。
  assert.equal(pixaiShowcaseModelId(), "pixai-tsubaki2");
  assert.equal(generationModel(pixaiShowcaseModelId() ?? "")?.promotionTag, "推荐");
});

test("buildGenerationCurl：端点、认证头与 JSON body 形状固定", () => {
  const curl = buildGenerationCurl({
    modelId: "pixai-tsubaki2",
    prompt: "1girl",
    size: "1024x1024",
    apiKey: PLACEHOLDER_KEY,
  });
  assert.match(curl, /^curl -s -X POST https:\/\/eimu\.dev\/v1\/images\/generations \\$/m);
  assert.match(curl, /-H "Authorization: Bearer sk-biz-placeholder" \\/);
  assert.match(curl, /-H "Content-Type: application\/json" \\/);
  assert.ok(curl.trimEnd().endsWith(`-d '{"model":"pixai-tsubaki2","prompt":"1girl","size":"1024x1024"}'`));
});

test("余额说明与充值连结：文案逐字、连结指向定价页", () => {
  assert.equal(DEV_QUICKSTART_BALANCE_NOTE, "新人礼额度可直接调用；余额用完返回 402，附充值链接。");
  assert.match(DEV_QUICKSTART_BALANCE_NOTE, /402/);
  assert.equal(DEV_QUICKSTART_PRICING_URL, "https://eimu.dev/pricing");
  assert.equal(DEV_QUICKSTART_BASE_URL, "https://eimu.dev/v1");
});