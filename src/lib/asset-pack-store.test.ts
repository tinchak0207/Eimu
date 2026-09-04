import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  AssetPackLimitError,
  MAX_DIGEST_LENGTH,
  MAX_ITEMS_PER_PACK,
  MAX_PACKS_PER_USER,
  __resetAssetPackStoreForTests,
  deleteAssetPacks,
  getActiveAssetPack,
  listAssetPacks,
  normalizeAssetPack,
  saveAssetPack,
} from "./asset-pack-store.ts";
import type { AssetPack, AssetPackItem } from "./asset-pack-store.ts";

beforeEach(() => {
  __resetAssetPackStoreForTests();
});

const USER_ID = 1;

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

// ── normalize 白名單 ─────────────────────────────────────────

test("normalizeAssetPack：非法 kind 的 item 被拒絕（drop）", () => {
  const pack = normalizeAssetPack({
    id: "p1",
    title: "t",
    items: [
      { kind: "video", title: "bad" }, // 不在白名單
      { kind: "prompt", title: "good" },
    ],
  });
  assert.ok(pack);
  assert.equal(pack.items.length, 1);
  assert.equal(pack.items[0].title, "good");
});

test("normalizeAssetPack：無 title 的 pack 拒絕", () => {
  assert.equal(normalizeAssetPack({ id: "p1", title: "" }), null);
  assert.equal(normalizeAssetPack({ id: "p1" }), null);
  assert.equal(normalizeAssetPack({ title: "t" }), null);
  assert.equal(normalizeAssetPack(null), null);
});

test("normalizeAssetPack：無 title 的 item 被拒絕（drop）", () => {
  const pack = normalizeAssetPack({
    id: "p1",
    title: "t",
    items: [{ kind: "prompt", title: "  " }, makeItem()],
  });
  assert.ok(pack);
  assert.equal(pack.items.length, 1);
});

test("normalizeAssetPack：digest 截斷至 500", () => {
  const pack = normalizeAssetPack({ id: "p1", title: "t", digest: "x".repeat(600) });
  assert.ok(pack);
  assert.equal(pack.digest!.length, MAX_DIGEST_LENGTH);
});

test("normalizeAssetPack：items 超過上限截斷", () => {
  const items = Array.from({ length: MAX_ITEMS_PER_PACK + 10 }, (_, i) => makeItem({ title: `item-${i}` }));
  const pack = normalizeAssetPack({ id: "p1", title: "t", items });
  assert.ok(pack);
  assert.equal(pack.items.length, MAX_ITEMS_PER_PACK);
});

test("normalizeAssetPack：tags 去重 + 截斷；欄位按 kind 才收；lora 專屬欄位", () => {
  const pack = normalizeAssetPack({
    id: "p1",
    title: "t",
    tags: ["a", " a ", "a", "", 42 as unknown as string],
    items: [
      { kind: "lora", title: "l", loraVersionId: "v1", loraWeight: 0.8, content: "不收", imageUrl: "不收" },
      { kind: "prompt", title: "pr", content: "hello", loraVersionId: "不收" },
      { kind: "recipe", title: "rc", content: "recipe text", modelId: "m1", size: "1024x1024", loraModelVersionIds: ["a", "b"] },
    ],
  });
  assert.ok(pack);
  assert.deepEqual(pack.tags, ["a"]);
  const [lora, prompt, recipe] = pack.items;
  assert.equal(lora.loraVersionId, "v1");
  assert.equal(lora.loraWeight, 0.8);
  assert.equal(lora.content, undefined);
  assert.equal(lora.imageUrl, undefined);
  assert.equal(prompt.content, "hello");
  assert.equal(prompt.loraVersionId, undefined);
  assert.equal(recipe.content, "recipe text");
  assert.equal(recipe.modelId, "m1");
  assert.equal(recipe.size, "1024x1024");
  assert.deepEqual(recipe.loraModelVersionIds, ["a", "b"]);
});

test("normalizeAssetPack：active 只收 boolean true", () => {
  const pack = normalizeAssetPack({ id: "p1", title: "t", active: true });
  assert.ok(pack);
  assert.equal(pack.active, true);
  const pack2 = normalizeAssetPack({ id: "p1", title: "t", active: "yes" as unknown as boolean });
  assert.ok(pack2);
  assert.equal(pack2.active, undefined);
});

// ── store 行為 ───────────────────────────────────────────────

test("saveAssetPack：upsert by id 覆蓋", async () => {
  await saveAssetPack(USER_ID, makePack({ id: "pack-1", title: "A" }));
  await saveAssetPack(USER_ID, makePack({ id: "pack-1", title: "B" }));
  const packs = await listAssetPacks(USER_ID);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].title, "B");
});

test("saveAssetPack：超過 MAX_PACKS_PER_USER 拋 AssetPackLimitError", async () => {
  for (let i = 0; i < MAX_PACKS_PER_USER; i++) {
    await saveAssetPack(USER_ID, makePack({ id: `pack-${i}` }));
  }
  await assert.rejects(
    () => saveAssetPack(USER_ID, makePack({ id: "overflow" })),
    (err) => err instanceof AssetPackLimitError,
  );
});

test("saveAssetPack：upsert 既有 id 不佔上限（仍可更新）", async () => {
  for (let i = 0; i < MAX_PACKS_PER_USER; i++) {
    await saveAssetPack(USER_ID, makePack({ id: `pack-${i}` }));
  }
  await saveAssetPack(USER_ID, makePack({ id: "pack-0", title: "updated" }));
  const packs = await listAssetPacks(USER_ID);
  assert.equal(packs.length, MAX_PACKS_PER_USER);
  assert.equal(packs.find((p) => p.id === "pack-0")?.title, "updated");
});

test("saveAssetPack：active 單一（存 A.active 再存 B.active → A 被清掉）", async () => {
  await saveAssetPack(USER_ID, makePack({ id: "A", active: true }));
  await saveAssetPack(USER_ID, makePack({ id: "B", active: true }));
  const packs = await listAssetPacks(USER_ID);
  const a = packs.find((p) => p.id === "A");
  const b = packs.find((p) => p.id === "B");
  assert.ok(a);
  assert.ok(b);
  assert.equal(a.active, undefined);
  assert.equal(b.active, true);
  assert.equal(packs.filter((p) => p.active === true).length, 1);
});

test("getActiveAssetPack：無 active 包 → null；有則回該包", async () => {
  assert.equal(await getActiveAssetPack(USER_ID), null);
  await saveAssetPack(USER_ID, makePack({ id: "A", active: true }));
  const active = await getActiveAssetPack(USER_ID);
  assert.ok(active);
  assert.equal(active.id, "A");
});

test("deleteAssetPacks：刪除指定 id，不存在的忽略", async () => {
  await saveAssetPack(USER_ID, makePack({ id: "A" }));
  await saveAssetPack(USER_ID, makePack({ id: "B" }));
  await deleteAssetPacks(USER_ID, ["A", "missing"]);
  const packs = await listAssetPacks(USER_ID);
  assert.deepEqual(packs.map((p) => p.id), ["B"]);
});

test("saveAssetPack：不合法 pack 拋錯", async () => {
  await assert.rejects(
    () => saveAssetPack(USER_ID, { id: "", title: "" } as AssetPack),
    /invalid asset pack/,
  );
});
