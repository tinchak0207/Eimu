import test from "node:test";
import assert from "node:assert/strict";
import { buildLoraFavoritesPack, LORA_FAVORITES_PACK_ID } from "./LoraLibraryPanel";

// 与 LoraLibraryPanel 的 LoraPreferenceItem 结构一致（该接口未导出，按结构造）。
interface FavLora {
  versionId: string;
  title: string;
  thumb: string;
  favorite: boolean;
  updatedAt: string;
}

function fav(overrides: Partial<FavLora> = {}): FavLora {
  return {
    versionId: "lora-cyberpunk-v3",
    title: "赛博朋克",
    thumb: "https://cdn.example.com/lora/cyberpunk.jpg",
    favorite: true,
    updatedAt: "2026-08-29T10:00:00.000Z",
    ...overrides,
  };
}

test("buildLoraFavoritesPack：收藏清单组装成确定性 id 的「我的 LoRA 收藏」包", () => {
  const pack = buildLoraFavoritesPack(
    [fav({ versionId: "lora-a", title: "A" }), fav({ versionId: "lora-b", title: "B" })],
    "2026-08-30T00:00:00.000Z",
  );
  assert.equal(pack.id, LORA_FAVORITES_PACK_ID);
  assert.equal(pack.id, "lora-favorites");
  assert.equal(pack.title, "我的 LoRA 收藏");
  assert.equal(pack.items.length, 2);
  assert.deepEqual(pack.tags, []);
  assert.equal(pack.createdAt, "2026-08-30T00:00:00.000Z");
  assert.equal(pack.updatedAt, "2026-08-30T00:00:00.000Z");
});

test("buildLoraFavoritesPack：每个 item 只带 lora 白名单栏位", () => {
  const pack = buildLoraFavoritesPack([fav({ versionId: "lora-cyberpunk-v3", title: "赛博朋克" })], "2026-08-30T00:00:00.000Z");
  const item = pack.items[0];
  assert.ok(item);
  assert.equal(item.kind, "lora");
  assert.equal(item.title, "赛博朋克");
  assert.equal(item.loraVersionId, "lora-cyberpunk-v3");
  assert.equal(item.createdAt, "2026-08-30T00:00:00.000Z");
  // 不携带非白名单栏位：无 content / 无 imageUrl / 无 source。
  assert.equal(item.content, undefined);
  assert.equal(item.imageUrl, undefined);
  assert.equal(item.source, undefined);
});

test("buildLoraFavoritesPack：空收藏仍产出空包（可 upsert，不报错）", () => {
  const pack = buildLoraFavoritesPack([], "2026-08-30T00:00:00.000Z");
  assert.equal(pack.id, LORA_FAVORITES_PACK_ID);
  assert.equal(pack.items.length, 0);
});
