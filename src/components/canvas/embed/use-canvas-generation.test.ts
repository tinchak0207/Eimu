import test from "node:test";
import assert from "node:assert/strict";
import { resolveEntityCardsOverride, withProjectStyleId } from "./use-canvas-generation";
import { applyCharacterCardsToPayload, type CharacterCard } from "@/lib/character-cards";

/**
 * WS6（按镜参考集收窄，空白节点原地生成 A4 补接通路）行为验收。
 *
 * 验收立场：断言**行为**——喂真实锁定卡阵列与面板行内引用 id，断言推导出的覆写物件，
 * 并把它喂进真正的注入层（applyCharacterCardsToPayload）锁定「本镜参考图集合」这个端状态。
 * 不用源码字串断言（守门件不是 oracle）。
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

test("命中卡：覆写＝那批卡 + referenceScope \"referenced\"，且真的把参考图收窄到被引用者", () => {
  const override = resolveEntityCardsOverride(LOCKED, ["card-ho"]);
  assert.ok(override, "命中必须回覆写物件");
  assert.deepEqual(override.cards, [HO]);
  assert.equal(override.referenceScope, "referenced");

  // 端状态：本镜正文只 @ 了霍辞渊 → 参考图只剩霍辞渊，其余锁定卡（雨夜街/古剑）不进本镜。
  const payload = { prompt: "@[角色:霍辞渊] 特写", reference_images: [] as { url: string; role: string; name: string }[] };
  const finalPayload = applyCharacterCardsToPayload(payload, override.cards, { referenceScope: override.referenceScope });
  const urls = (finalPayload.reference_images ?? []).map((r) => r.url);
  assert.deepEqual(urls, ["https://img/ho.png"]);
  assert.ok(!urls.includes("https://img/street.png"));
  assert.ok(!urls.includes("https://img/sword.png"));
});

test("多张命中：只含被引用的那批，顺序沿用 activeCharacterCards（不随 entityCardIds 重排）", () => {
  // id 传入序与锁定卡序相反；且锁定卡序本身刻意非字母序。
  const override = resolveEntityCardsOverride(LOCKED, ["card-sword", "card-street"]);
  assert.ok(override);
  assert.deepEqual(override.cards, [STREET, SWORD], "顺序必须与 activeCharacterCards 一致");
  assert.equal(override.cards[0], STREET, "不复制不重排，逐卡同一物件");
  assert.equal(override.referenceScope, "referenced");

  const payload = { prompt: "@[场景:雨夜街] 俯拍", reference_images: [] as { url: string; role: string; name: string }[] };
  const finalPayload = applyCharacterCardsToPayload(payload, override.cards, { referenceScope: override.referenceScope });
  assert.deepEqual((finalPayload.reference_images ?? []).map((r) => r.url), ["https://img/street.png"]);
});

test("id 全部对不到卡 → undefined（不传 cardsOverride，退回既有全量锁定行为）", () => {
  const override = resolveEntityCardsOverride(LOCKED, ["card-ghost", "card-deleted"]);
  assert.equal(override, undefined, "收窄到空集合必须被拒（比不收窄更坏的失败模式）");

  // 对照组：缺省路径（不传覆写）＝全量锁定卡都进 payload，同一颗提示词下不会静默全空。
  const payload = { prompt: "@[角色:霍辞渊] 特写", reference_images: [] as { url: string; role: string; name: string }[] };
  const full = applyCharacterCardsToPayload(payload, LOCKED, undefined);
  assert.ok((full.reference_images ?? []).length >= 3, "缺省＝全量锁定卡参考图");
});

test("缺省／空阵列 → undefined（既有行为逐位元不变）", () => {
  assert.equal(resolveEntityCardsOverride(LOCKED), undefined);
  assert.equal(resolveEntityCardsOverride(LOCKED, []), undefined);
  // 锁定卡本身为空时也一样：没有卡可收窄 → 不覆写。
  assert.equal(resolveEntityCardsOverride([], ["card-ho"]), undefined);
});

test("命中判定不被 name 影响：只认 id（同名不同卡各归各）", () => {
  const twin = card({ id: "card-ho-2", name: "霍辞渊" });
  const override = resolveEntityCardsOverride([HO, twin], ["card-ho-2"]);
  assert.ok(override);
  assert.deepEqual(override.cards, [twin]);
});

// ── 专案风格绑定注入（P1-8／对称差 D34）──────────────────────────────────────
//
// 验收立场：断言**送出的请求物件真的带了风格**。实际组装路径＝卡注入（真
// applyCharacterCardsToPayload）→ LoRA merge → `withProjectStyleId`（本档唯一 style 并入点）。
// 这里用真卡注入函式组出 payload，再过 style 并入，断言端状态；不用源码字串断言。

test("有专案绑定：请求物件带 style_id＝专案 styleId", () => {
  const payload = { prompt: "海边日落", model: "seedream-4", reference_images: [] };
  const finalPayload = withProjectStyleId(payload, "sai-anime");
  assert.equal(finalPayload.style_id, "sai-anime");
  assert.deepEqual(Object.keys(finalPayload).sort(), ["model", "prompt", "reference_images", "style_id"]);
  // 既有栏位逐栏不变（不因注入风格而动到 prompt/model/参考图）。
  assert.equal(finalPayload.prompt, "海边日落");
  assert.equal(finalPayload.model, "seedream-4");
});

test("无专案绑定：请求物件不含 style_id 键（不塞 undefined／空字串）", () => {
  const payload = { prompt: "海边日落", model: "seedream-4" };
  const noBinding = withProjectStyleId(payload, undefined);
  assert.ok(!("style_id" in noBinding), "无绑定不得新增 style_id 键");
  assert.equal(noBinding, payload, "无绑定＝原物件逐位不变");
  // 空字串同款：不新增键。
  assert.ok(!("style_id" in withProjectStyleId(payload, "")));
});

test("已带 style_id（呼叫端显式给定）：不覆写", () => {
  const payload = { prompt: "x", style_id: "ads-luxury" };
  assert.equal(withProjectStyleId(payload, "sai-anime").style_id, "ads-luxury");
});

test("防回归：卡注入与 LoRA 栏位逐栏不变，只多一个 style_id", () => {
  const payload = {
    prompt: "@[角色:霍辞渊] 特写",
    model: "seedream-4",
    reference_images: [] as { url: string; role: string; name: string }[],
    loraModelVersionIds: ["lora-7"],
    count: 1,
  };
  const afterCards = applyCharacterCardsToPayload(payload, [HO], { referenceScope: "referenced" });
  const finalPayload = withProjectStyleId(afterCards, "sai-anime");

  assert.equal(finalPayload.style_id, "sai-anime");
  assert.deepEqual(finalPayload.loraModelVersionIds, ["lora-7"], "LoRA 栏位不被风格注入动到");
  assert.equal(finalPayload.count, 1);
  const urls = (finalPayload.reference_images ?? []).map((r) => r.url);
  assert.deepEqual(urls, ["https://img/ho.png"], "卡注入结果逐栏不变");
  // 卡注入带来的片段前缀仍在（风格只是附加，不取代提示词）。
  assert.equal(typeof finalPayload.prompt, "string");
  // 逐栏等价：除 style_id 外与卡注入结果一致。
  const { style_id: _style, ...rest } = finalPayload as Record<string, unknown>;
  assert.deepEqual(rest, afterCards);
});