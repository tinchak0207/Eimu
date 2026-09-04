// nodeToAssetPackItems 純函式測試：expected-pass。
// 只斷言已落地的轉換契約（prompt / lora / image / 標題回落 / 去空格）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeToAssetPackItems } from "./node-to-asset-items";

test("有 prompt → 產生 prompt item，含 canvas source", () => {
  const items = nodeToAssetPackItems({ id: "n1", title: "主提示", prompt: "一个女孩" });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "prompt");
  assert.equal(items[0].title, "主提示");
  assert.equal(items[0].content, "一个女孩");
  assert.deepEqual(items[0].source, { type: "canvas", id: "n1" });
});

test("prompt 標題缺失 → 回落「画布提示词」", () => {
  const items = nodeToAssetPackItems({ id: "n2", prompt: "x" });
  assert.equal(items[0].title, "画布提示词");
});

test("有 LoRA → 額外產生 lora item，取第一個 loraVersionId", () => {
  const items = nodeToAssetPackItems({
    id: "n3",
    prompt: "x",
    loraModelVersionIds: ["lora-1", "lora-2"],
  });
  assert.equal(items.length, 2);
  const lora = items.find((i) => i.kind === "lora");
  assert.ok(lora);
  assert.equal(lora.loraVersionId, "lora-1");
  assert.equal(lora.title, "LoRA");
});

test("無 prompt 但只有 lora / image → 仍產出對應 item", () => {
  const items = nodeToAssetPackItems({
    id: "n4",
    loraModelVersionIds: ["l1"],
    imageUrl: "https://img.example/a.png",
  });
  assert.equal(items.length, 2);
  assert.ok(items.some((i) => i.kind === "lora"));
  assert.ok(items.some((i) => i.kind === "image"));
  assert.ok(!items.some((i) => i.kind === "prompt"));
});

test("空節點（無 prompt / lora / image）→ 空陣列", () => {
  assert.deepEqual(nodeToAssetPackItems({ id: "n5" }), []);
  assert.deepEqual(nodeToAssetPackItems({ id: "n6", prompt: "   " }), []);
});

test("prompt 帶 modelId / size → 帶入 item；空白則省略", () => {
  const withMeta = nodeToAssetPackItems({ id: "n7", prompt: "x", modelId: "m1", size: "1024x1024" });
  assert.equal(withMeta[0].modelId, "m1");
  assert.equal(withMeta[0].size, "1024x1024");
  const blankMeta = nodeToAssetPackItems({ id: "n8", prompt: "x", modelId: "  ", size: "" });
  assert.equal(blankMeta[0].modelId, undefined);
  assert.equal(blankMeta[0].size, undefined);
});