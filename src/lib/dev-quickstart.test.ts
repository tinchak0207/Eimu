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

/** 佔位金鑰：測試與回報一律不入真實憑證。 */
const PLACEHOLDER_KEY = "sk-biz-placeholder";

test("範例：gpt-image-2 段落逐字命中 spec 的 model/prompt/size", () => {
  const examples = quickstartCurlExamples(PLACEHOLDER_KEY);
  const general = examples.find((item) => item.modelId === "gpt-image-2");
  assert.ok(general, "通用段落必須存在（catalog 內有 gpt-image-2）");
  assert.match(general.curl, /"model":"gpt-image-2"/);
  assert.match(general.curl, /"prompt":"一只橘猫趴在窗台上，水彩风格"/);
  assert.match(general.curl, /"size":"1024x1024"/);
  assert.match(general.curl, /-X POST https:\/\/eimu\.dev\/v1\/images\/generations/);
});

test("範例：PixAI 段落 model id 由 catalog 真源推導，且在白名單與 catalog 同時存在", () => {
  const examples = quickstartCurlExamples(PLACEHOLDER_KEY);
  const pixai = examples.find((item) => item.modelId.startsWith("pixai-"));
  assert.ok(pixai, "二次元段落必須存在（catalog 內有可用 pixai 模型）");

  // 跨檔交叉驗證：可見白名單（image-model-ids.js）與 catalog 兩份來源都必須認得它。
  assert.ok(IMAGE_MODEL_IDS.includes(pixai.modelId), "id 必須在使用者可見模型白名單內");
  const definition = GENERATION_MODEL_CATALOG[pixai.modelId];
  assert.ok(definition, "id 必須存在於 GENERATION_MODEL_CATALOG");
  assert.equal(definition.kind, "image");
  assert.equal(definition.vendor, "PixAI");

  // 範例 curl 真的用了這顆推導出來的 id，size 由該模型預設比例推導。
  assert.ok(pixai.curl.includes(`"model":"${pixai.modelId}"`), "curl 的 model 必須是推導值");
  const size = quickstartExampleSize(pixai.modelId);
  assert.ok(size && pixai.curl.includes(`"size":"${size}"`), "curl 的 size 必須由 catalog 預設比例推導");
});

test("範例：兩段都代入呼叫端傳入的金鑰明文，不內建任何金鑰", () => {
  const examples = quickstartCurlExamples(PLACEHOLDER_KEY);
  assert.ok(examples.length >= 2, "通用 + 二次元兩段");
  for (const example of examples) {
    assert.ok(example.curl.includes(`Bearer ${PLACEHOLDER_KEY}`), `${example.title} 必須代入傳入的金鑰`);
  }
  // 未傳金鑰時不得組出任何字面金鑰（防止把示範值寫死成看起來可用的 key）。
  const empty = quickstartCurlExamples("");
  for (const example of empty) {
    assert.doesNotMatch(example.curl, /Bearer sk-/, "空金鑰不得渲染成 sk- 假金鑰");
  }
});

test("pixaiShowcaseModelId：catalog 為空回 null，絕不編造硬編碼 id", () => {
  assert.equal(pixaiShowcaseModelId({}, []), null);
  // 只有偏好序以外的 pixai 條目時，不得回偏好序裡的幻影 id。
  assert.equal(pixaiShowcaseModelId({}, ["pixai-tsubaki2"]), null, "白名單有但 catalog 無 → 不算存在");
  assert.equal(pixaiShowcaseModelId({ "pixai-tsubaki2": {} }, []), null, "catalog 有但白名單無 → 不可見");
});

test("pixaiShowcaseModelId：偏好序落空時退到 catalog 內實際存在的 pixai 條目", () => {
  assert.equal(
    pixaiShowcaseModelId({ "pixai-haruka-v2": {} }, ["pixai-haruka-v2"]),
    "pixai-haruka-v2",
    "偏好序首位缺失時取實際存在的替代",
  );
  // 默認參數（真實 catalog）首位是 Tsubaki.2（catalog 內 promotionTag「推荐」的二次元主力）。
  assert.equal(pixaiShowcaseModelId(), "pixai-tsubaki2");
  assert.equal(generationModel(pixaiShowcaseModelId() ?? "")?.promotionTag, "推荐");
});

test("buildGenerationCurl：端點、認證頭與 JSON body 形狀固定", () => {
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

test("餘額說明與充值連結：文案逐字、連結指向定價頁", () => {
  assert.equal(DEV_QUICKSTART_BALANCE_NOTE, "新人礼额度可直接调用；余额用完返回 402，附充值链接。");
  assert.match(DEV_QUICKSTART_BALANCE_NOTE, /402/);
  assert.equal(DEV_QUICKSTART_PRICING_URL, "https://eimu.dev/pricing");
  assert.equal(DEV_QUICKSTART_BASE_URL, "https://eimu.dev/v1");
});