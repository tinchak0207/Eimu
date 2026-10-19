import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  AssetPackLimitError,
  MAX_DIGEST_LENGTH,
  MAX_ITEMS_PER_PACK,
  MAX_PACK_ID_LENGTH,
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
    title: "测试包",
    items: [makeItem()],
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── normalize 白名单 ─────────────────────────────────────────

test("normalizeAssetPack：video/audio 已进白名单，但缺 mediaUrl 仍被拒（drop）", () => {
  // 旧契约：video 是「非法 kind」被 drop；新契约：video/audio 是合法交付物媒体，
  // 缺 mediaUrl 才 drop（无产物 URL 的媒体 item 无意义）。此条反映新契约。
  const pack = normalizeAssetPack({
    id: "p1",
    title: "t",
    items: [
      { kind: "video", title: "no-url" }, // 合法 kind 但缺 mediaUrl → drop
      { kind: "audio", title: "no-url" }, // 同上
      { kind: "prompt", title: "good" },
    ],
  });
  assert.ok(pack);
  assert.equal(pack.items.length, 1);
  assert.equal(pack.items[0].title, "good");
});

test("normalizeAssetPack：未知 / 近义 asset kind 一律被拒（item 被 drop，不静默放行）", () => {
  // 未知 kind（"garbage"）与近义词（"movie" 而非 "video"）都不是注册表白名单值，
  // normalizeItem 回 null → 该 item 被 drop，不得因新增媒体种类而被放行。
  const pack = normalizeAssetPack({
    id: "p1",
    title: "t",
    items: [
      { kind: "garbage", title: "x" },
      { kind: "movie", title: "近义词" },
      { kind: "prompt", title: "good" },
    ],
  });
  assert.ok(pack);
  assert.equal(pack.items.length, 1);
  assert.equal(pack.items[0].kind, "prompt");
  assert.equal(pack.items[0].title, "good");

  // 全部为未知 kind 时，item 层全被 drop（pack 本体仍成立、items 为空）。
  const allBogus = normalizeAssetPack({
    id: "p2",
    title: "t",
    items: [
      { kind: "garbage", title: "x" },
      { kind: "movie", title: "y" },
    ],
  });
  assert.ok(allBogus);
  assert.equal(allBogus.items.length, 0);
});

test("normalizeAssetPack：video 带 mediaUrl → 收，kind/mediaUrl 保留", () => {
  const pack = normalizeAssetPack({
    id: "p1",
    title: "t",
    items: [
      { kind: "video", title: "v", mediaUrl: "  https://x/a.mp4  ", imageUrl: "不收" },
    ],
  });
  assert.ok(pack);
  assert.equal(pack.items.length, 1);
  assert.equal(pack.items[0].kind, "video");
  assert.equal(pack.items[0].mediaUrl, "https://x/a.mp4");
  assert.equal(pack.items[0].imageUrl, undefined);
});

test("normalizeAssetPack：audio 带 mediaUrl → 收；缺 mediaUrl → drop", () => {
  const pack = normalizeAssetPack({
    id: "p1",
    title: "t",
    items: [
      { kind: "audio", title: "a", mediaUrl: "https://x/a.mp3" },
      { kind: "audio", title: "bad", mediaUrl: "   " },
    ],
  });
  assert.ok(pack);
  assert.equal(pack.items.length, 1);
  assert.equal(pack.items[0].kind, "audio");
  assert.equal(pack.items[0].mediaUrl, "https://x/a.mp3");
});

test("normalizeAssetPack：image 既有行为不变（有 imageUrl 收、缺 URL 仍保留 item）", () => {
  const pack = normalizeAssetPack({
    id: "p1",
    title: "t",
    items: [
      { kind: "image", title: "with", imageUrl: "https://x/a.png", mediaUrl: "不收" },
      { kind: "image", title: "without" },
    ],
  });
  assert.ok(pack);
  assert.equal(pack.items.length, 2);
  assert.equal(pack.items[0].imageUrl, "https://x/a.png");
  assert.equal(pack.items[0].mediaUrl, undefined);
  assert.equal(pack.items[1].kind, "image");
  assert.equal(pack.items[1].imageUrl, undefined);
});

test("normalizeAssetPack：reference 既有行为不变（收 imageUrl，不收 mediaUrl）", () => {
  const pack = normalizeAssetPack({
    id: "p1",
    title: "t",
    items: [{ kind: "reference", title: "r", imageUrl: "https://x/r.png", mediaUrl: "不收" }],
  });
  assert.ok(pack);
  assert.equal(pack.items[0].imageUrl, "https://x/r.png");
  assert.equal(pack.items[0].mediaUrl, undefined);
});

test("normalizeAssetPack：无 title 的 pack 拒绝", () => {
  assert.equal(normalizeAssetPack({ id: "p1", title: "" }), null);
  assert.equal(normalizeAssetPack({ id: "p1" }), null);
  assert.equal(normalizeAssetPack({ title: "t" }), null);
  assert.equal(normalizeAssetPack(null), null);
});

test("normalizeAssetPack：无 title 的 item 被拒绝（drop）", () => {
  const pack = normalizeAssetPack({
    id: "p1",
    title: "t",
    items: [{ kind: "prompt", title: "  " }, makeItem()],
  });
  assert.ok(pack);
  assert.equal(pack.items.length, 1);
});

test("normalizeAssetPack：digest 截断至 500", () => {
  const pack = normalizeAssetPack({ id: "p1", title: "t", digest: "x".repeat(600) });
  assert.ok(pack);
  assert.equal(pack.digest!.length, MAX_DIGEST_LENGTH);
});

test("normalizeAssetPack：items 超过上限截断", () => {
  const items = Array.from({ length: MAX_ITEMS_PER_PACK + 10 }, (_, i) => makeItem({ title: `item-${i}` }));
  const pack = normalizeAssetPack({ id: "p1", title: "t", items });
  assert.ok(pack);
  assert.equal(pack.items.length, MAX_ITEMS_PER_PACK);
});

test("normalizeAssetPack：tags 去重 + 截断；栏位按 kind 才收；lora 专属栏位", () => {
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

// ── store 行为 ───────────────────────────────────────────────

test("saveAssetPack：upsert by id 覆盖", async () => {
  await saveAssetPack(USER_ID, makePack({ id: "pack-1", title: "A" }));
  await saveAssetPack(USER_ID, makePack({ id: "pack-1", title: "B" }));
  const packs = await listAssetPacks(USER_ID);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].title, "B");
});

test("saveAssetPack：超过 MAX_PACKS_PER_USER 抛 AssetPackLimitError", async () => {
  for (let i = 0; i < MAX_PACKS_PER_USER; i++) {
    await saveAssetPack(USER_ID, makePack({ id: `pack-${i}` }));
  }
  await assert.rejects(
    () => saveAssetPack(USER_ID, makePack({ id: "overflow" })),
    (err) => err instanceof AssetPackLimitError,
  );
});

test("saveAssetPack：upsert 既有 id 不占上限（仍可更新）", async () => {
  for (let i = 0; i < MAX_PACKS_PER_USER; i++) {
    await saveAssetPack(USER_ID, makePack({ id: `pack-${i}` }));
  }
  await saveAssetPack(USER_ID, makePack({ id: "pack-0", title: "updated" }));
  const packs = await listAssetPacks(USER_ID);
  assert.equal(packs.length, MAX_PACKS_PER_USER);
  assert.equal(packs.find((p) => p.id === "pack-0")?.title, "updated");
});

test("saveAssetPack：active 单一（存 A.active 再存 B.active → A 被清掉）", async () => {
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

test("getActiveAssetPack：无 active 包 → null；有则回该包", async () => {
  assert.equal(await getActiveAssetPack(USER_ID), null);
  await saveAssetPack(USER_ID, makePack({ id: "A", active: true }));
  const active = await getActiveAssetPack(USER_ID);
  assert.ok(active);
  assert.equal(active.id, "A");
});

test("deleteAssetPacks：删除指定 id，不存在的忽略", async () => {
  await saveAssetPack(USER_ID, makePack({ id: "A" }));
  await saveAssetPack(USER_ID, makePack({ id: "B" }));
  await deleteAssetPacks(USER_ID, ["A", "missing"]);
  const packs = await listAssetPacks(USER_ID);
  assert.deepEqual(packs.map((p) => p.id), ["B"]);
});

test("saveAssetPack：不合法 pack 抛错", async () => {
  await assert.rejects(
    () => saveAssetPack(USER_ID, { id: "", title: "" } as AssetPack),
    /invalid asset pack/,
  );
});

// ─────────────────────────────────────────── REQ-B2-4 pack id 边界

test("B2-4 pack id：长度上限与分隔符边界（拒绝而非截断，避免『可建不可分享』与撞键别名）", () => {
  // 边界内：200 字可用（与 share/mount 的 200 同一个界）。
  const atLimit = "a".repeat(MAX_PACK_ID_LENGTH);
  assert.ok(normalizeAssetPack({ id: atLimit, title: "边界内的包", items: [], tags: [] }));
  // 超长：拒收（过去 str 无上限 → 能建但不能分享/挂用）。
  assert.equal(normalizeAssetPack({ id: "a".repeat(MAX_PACK_ID_LENGTH + 1), title: "超长", items: [], tags: [] }), null);
  // 含保留分隔符 `:`：拒收（作用域层确定性键的段分隔符，含它会撞键）。
  assert.equal(normalizeAssetPack({ id: "pack:x:card:y", title: "撞键", items: [], tags: [] }), null);
  assert.equal(normalizeAssetPack({ id: "  pack-ok  ", title: "空白", items: [], tags: [] })?.id, "pack-ok");
}); 
