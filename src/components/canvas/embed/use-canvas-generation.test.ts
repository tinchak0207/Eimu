import test from "node:test";
import assert from "node:assert/strict";
import { resolveEntityCardsOverride } from "./use-canvas-generation";
import { applyCharacterCardsToPayload, type CharacterCard } from "@/lib/character-cards";

/**
 * WS6（按鏡參考集收窄，空白節點原地生成 A4 補接通路）行為驗收。
 *
 * 驗收立場：斷言**行為**——餵真實鎖定卡陣列與面板行內引用 id，斷言推導出的覆寫物件，
 * 並把它餵進真正的注入層（applyCharacterCardsToPayload）鎖定「本鏡參考圖集合」這個端狀態。
 * 不用源碼字串斷言（守門件不是 oracle）。
 */

function card(partial: Partial<CharacterCard> & { id: string }): CharacterCard {
  return {
    name: partial.id,
    kind: "character",
    prompt: "",
    references: [],
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...partial,
  };
}

const HO = card({
  id: "card-ho",
  name: "霍辞渊",
  prompt: "银发黑衣男性",
  references: [{ url: "https://img/ho.png", role: "character", name: "霍辞渊" }],
});
const STREET = card({
  id: "card-street",
  name: "雨夜街",
  kind: "scene",
  prompt: "湿滑石板路霓虹",
  references: [{ url: "https://img/street.png", role: "scene", name: "雨夜街" }],
});
const SWORD = card({
  id: "card-sword",
  name: "古剑",
  kind: "prop",
  prompt: "锈迹长锋",
  references: [{ url: "https://img/sword.png", role: "general", name: "古剑" }],
});
const LOCKED = [HO, STREET, SWORD];

test("命中卡：覆寫＝那批卡 + referenceScope \"referenced\"，且真的把參考圖收窄到被引用者", () => {
  const override = resolveEntityCardsOverride(LOCKED, ["card-ho"]);
  assert.ok(override, "命中必須回覆寫物件");
  assert.deepEqual(override.cards, [HO]);
  assert.equal(override.referenceScope, "referenced");

  // 端狀態：本鏡正文只 @ 了霍辞渊 → 參考圖只剩霍辞渊，其餘鎖定卡（雨夜街/古剑）不進本鏡。
  const payload = { prompt: "@[角色:霍辞渊] 特写", reference_images: [] as { url: string; role: string; name: string }[] };
  const finalPayload = applyCharacterCardsToPayload(payload, override.cards, { referenceScope: override.referenceScope });
  const urls = (finalPayload.reference_images ?? []).map((r) => r.url);
  assert.deepEqual(urls, ["https://img/ho.png"]);
  assert.ok(!urls.includes("https://img/street.png"));
  assert.ok(!urls.includes("https://img/sword.png"));
});

test("多張命中：只含被引用的那批，順序沿用 activeCharacterCards（不隨 entityCardIds 重排）", () => {
  // id 傳入序與鎖定卡序相反；且鎖定卡序本身刻意非字母序。
  const override = resolveEntityCardsOverride(LOCKED, ["card-sword", "card-street"]);
  assert.ok(override);
  assert.deepEqual(override.cards, [STREET, SWORD], "順序必須與 activeCharacterCards 一致");
  assert.equal(override.cards[0], STREET, "不複製不重排，逐卡同一物件");
  assert.equal(override.referenceScope, "referenced");

  const payload = { prompt: "@[场景:雨夜街] 俯拍", reference_images: [] as { url: string; role: string; name: string }[] };
  const finalPayload = applyCharacterCardsToPayload(payload, override.cards, { referenceScope: override.referenceScope });
  assert.deepEqual((finalPayload.reference_images ?? []).map((r) => r.url), ["https://img/street.png"]);
});

test("id 全部對不到卡 → undefined（不傳 cardsOverride，退回既有全量鎖定行為）", () => {
  const override = resolveEntityCardsOverride(LOCKED, ["card-ghost", "card-deleted"]);
  assert.equal(override, undefined, "收窄到空集合必須被拒（比不收窄更壞的失敗模式）");

  // 對照組：缺省路徑（不傳覆寫）＝全量鎖定卡都進 payload，同一顆提示詞下不會靜默全空。
  const payload = { prompt: "@[角色:霍辞渊] 特写", reference_images: [] as { url: string; role: string; name: string }[] };
  const full = applyCharacterCardsToPayload(payload, LOCKED, undefined);
  assert.ok((full.reference_images ?? []).length >= 3, "缺省＝全量鎖定卡參考圖");
});

test("缺省／空陣列 → undefined（既有行為逐位元不變）", () => {
  assert.equal(resolveEntityCardsOverride(LOCKED), undefined);
  assert.equal(resolveEntityCardsOverride(LOCKED, []), undefined);
  // 鎖定卡本身為空時也一樣：沒有卡可收窄 → 不覆寫。
  assert.equal(resolveEntityCardsOverride([], ["card-ho"]), undefined);
});

test("命中判定不被 name 影響：只認 id（同名不同卡各歸各）", () => {
  const twin = card({ id: "card-ho-2", name: "霍辞渊" });
  const override = resolveEntityCardsOverride([HO, twin], ["card-ho-2"]);
  assert.ok(override);
  assert.deepEqual(override.cards, [twin]);
});