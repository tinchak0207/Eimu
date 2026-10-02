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
    title: "測試包",
    items: [makeItem()],
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── normalize 白名單 ─────────────────────────────────────────

test("normalizeAssetPack：video/audio 已進白名單，但缺 mediaUrl 仍被拒（drop）", () => {
  // 舊契約：video 是「非法 kind」被 drop；新契約：video/audio 是合法交付物媒體，
  // 缺 mediaUrl 才 drop（無產物 URL 的媒體 item 無意義）。此條反映新契約。
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

test("normalizeAssetPack：未知 / 近義 asset kind 一律被拒（item 被 drop，不靜默放行）", () => {
  // 未知 kind（"garbage"）與近義詞（"movie" 而非 "video"）都不是註冊表白名單值，
  // normalizeItem 回 null → 該 item 被 drop，不得因新增媒體種類而被放行。
  const pack = normalizeAssetPack({
    id: "p1",
    title: "t",
    items: [
      { kind: "garbage", title: "x" },
      { kind: "movie", title: "近義詞" },
      { kind: "prompt", title: "good" },
    ],
  });
  assert.ok(pack);
  assert.equal(pack.items.length, 1);
  assert.equal(pack.items[0].kind, "prompt");
  assert.equal(pack.items[0].title, "good");

  // 全部為未知 kind 時，item 層全被 drop（pack 本體仍成立、items 為空）。
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

test("normalizeAssetPack：video 帶 mediaUrl → 收，kind/mediaUrl 保留", () => {
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

test("normalizeAssetPack：audio 帶 mediaUrl → 收；缺 mediaUrl → drop", () => {
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

test("normalizeAssetPack：image 既有行為不變（有 imageUrl 收、缺 URL 仍保留 item）", () => {
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

test("normalizeAssetPack：reference 既有行為不變（收 imageUrl，不收 mediaUrl）", () => {
  const pack = normalizeAssetPack({
    id: "p1",
    title: "t",
    items: [{ kind: "reference", title: "r", imageUrl: "https://x/r.png", mediaUrl: "不收" }],
  });
  assert.ok(pack);
  assert.equal(pack.items[0].imageUrl, "https://x/r.png");
  assert.equal(pack.items[0].mediaUrl, undefined);
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

// ─────────────────────────────────────────── REQ-B2-4 pack id 邊界

test("B2-4 pack id：長度上限與分隔符邊界（拒絕而非截斷，避免『可建不可分享』與撞鍵別名）", () => {
  // 邊界內：200 字可用（與 share/mount 的 200 同一個界）。
  const atLimit = "a".repeat(MAX_PACK_ID_LENGTH);
  assert.ok(normalizeAssetPack({ id: atLimit, title: "边界内的包", items: [], tags: [] }));
  // 超長：拒收（過去 str 無上限 → 能建但不能分享/掛用）。
  assert.equal(normalizeAssetPack({ id: "a".repeat(MAX_PACK_ID_LENGTH + 1), title: "超长", items: [], tags: [] }), null);
  // 含保留分隔符 `:`：拒收（作用域層確定性鍵的段分隔符，含它會撞鍵）。
  assert.equal(normalizeAssetPack({ id: "pack:x:card:y", title: "撞键", items: [], tags: [] }), null);
  assert.equal(normalizeAssetPack({ id: "  pack-ok  ", title: "空白", items: [], tags: [] })?.id, "pack-ok");
}); 
