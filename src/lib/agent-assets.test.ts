import test from "node:test";
import assert from "node:assert/strict";
import { ACTIVE_ASSET_ITEMS_LIMIT, buildAssetPackInjection, resolveActivationFromPack } from "./agent-assets.ts";
import type { AssetPack, AssetPackItem } from "./asset-pack-store.ts";

function makeItem(overrides: Partial<AssetPackItem> = {}): AssetPackItem {
  return { kind: "prompt", title: "item", ...overrides };
}

function makePack(overrides: Partial<AssetPack> = {}): AssetPack {
  const now = new Date().toISOString();
  return {
    id: "pack-1",
    title: "測試包",
    items: [makeItem()],
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── resolveActivationFromPack ─────────────────────────────────

test("resolveActivationFromPack：lora 單選鐵律——多 lora 只取第一個", () => {
  const pack = makePack({
    items: [
      makeItem({ kind: "lora", title: "lora1", loraVersionId: "lora-aaa" }),
      makeItem({ kind: "lora", title: "lora2", loraVersionId: "lora-bbb" }),
    ],
  });
  const activation = resolveActivationFromPack(pack);
  assert.equal(activation.packId, "pack-1");
  assert.equal(activation.title, "測試包");
  assert.deepEqual(activation.loraModelVersionIds, ["lora-aaa"]);
});

test("resolveActivationFromPack：無 lora item 時省略 loraModelVersionIds", () => {
  const pack = makePack({ items: [makeItem({ kind: "prompt", content: "hi" })] });
  const activation = resolveActivationFromPack(pack);
  assert.equal(activation.loraModelVersionIds, undefined);
});

test("resolveActivationFromPack：prompt 取首個含 content 的 prompt/recipe item", () => {
  const pack = makePack({
    items: [
      makeItem({ kind: "prompt", title: "空", content: "" }),
      makeItem({ kind: "recipe", title: "配方", content: "六槽配方" }),
      makeItem({ kind: "prompt", title: "後面的", content: "不該被選" }),
    ],
  });
  const activation = resolveActivationFromPack(pack);
  assert.equal(activation.prompt, "六槽配方");
});

test("resolveActivationFromPack：無 content/prompt item 時省略 prompt", () => {
  const pack = makePack({ items: [makeItem({ kind: "reference", imageUrl: "https://a.img" })] });
  const activation = resolveActivationFromPack(pack);
  assert.equal(activation.prompt, undefined);
});

test("resolveActivationFromPack：referenceImageUrls 收 reference+image 且去重", () => {
  const pack = makePack({
    items: [
      makeItem({ kind: "reference", title: "r1", imageUrl: "https://a.img" }),
      makeItem({ kind: "image", title: "i1", imageUrl: "https://a.img" }),
      makeItem({ kind: "image", title: "i2", imageUrl: "https://b.img" }),
      makeItem({ kind: "lora", title: "l", loraVersionId: "lora-x" }),
    ],
  });
  const activation = resolveActivationFromPack(pack);
  assert.deepEqual(activation.referenceImageUrls, ["https://a.img", "https://b.img"]);
});

test("resolveActivationFromPack：帶 digest 與完整 items 透傳", () => {
  const pack = makePack({
    digest: "語義摘要",
    items: [makeItem({ kind: "prompt", content: "hi" })],
  });
  const activation = resolveActivationFromPack(pack);
  assert.equal(activation.digest, "語義摘要");
  assert.equal(activation.items.length, 1);
});

// ── buildAssetPackInjection ───────────────────────────────────

test("buildAssetPackInjection：null/undefined → null", () => {
  assert.equal(buildAssetPackInjection(null), null);
  assert.equal(buildAssetPackInjection(undefined as unknown as AssetPack | null), null);
});

test("buildAssetPackInjection：空包（無 items）→ null", () => {
  const pack = makePack({ items: [] });
  assert.equal(buildAssetPackInjection(pack), null);
});

test("buildAssetPackInjection：items 截至上限（5）", () => {
  const items = Array.from({ length: 8 }, (_, i) => makeItem({ title: `item-${i}` }));
  const pack = makePack({ items });
  const injection = buildAssetPackInjection(pack);
  assert.ok(injection);
  assert.equal(injection.active_assets.pack_id, "pack-1");
  assert.equal(injection.active_assets.title, "測試包");
  assert.equal(injection.active_assets.items.length, ACTIVE_ASSET_ITEMS_LIMIT);
  assert.equal(injection.active_assets.items[0].title, "item-0");
});

test("buildAssetPackInjection：digest 截 500", () => {
  const pack = makePack({ items: [makeItem()], digest: "x".repeat(600) });
  const injection = buildAssetPackInjection(pack);
  assert.ok(injection);
  assert.equal(injection.active_assets.digest?.length, 500);
});

test("buildAssetPackInjection：包有內容時結構正確（digest + items）", () => {
  const pack = makePack({ digest: "摘要", items: [makeItem({ kind: "prompt", content: "hi" })] });
  const injection = buildAssetPackInjection(pack);
  assert.deepEqual(injection, {
    active_assets: {
      pack_id: "pack-1",
      title: "測試包",
      digest: "摘要",
      items: [makeItem({ kind: "prompt", content: "hi" })],
    },
  });
});

test("buildAssetPackInjection：無 digest 時省略 digest 欄位", () => {
  const pack = makePack({ items: [makeItem()] });
  const injection = buildAssetPackInjection(pack);
  assert.ok(injection);
  assert.equal(injection.active_assets.digest, undefined);
  assert.ok(!("digest" in injection.active_assets));
});
