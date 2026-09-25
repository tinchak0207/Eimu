// mergeTokenReferencedCards（生成時「本段 prompt token 引用到的卡」就地併入注入集）行為驗收。
//
// 立場：斷言**行為**，不用源碼字串斷言（守門件不是 oracle）。
// 核心＝卡**在庫但未鎖定**時，正文寫 `@[角色:灰羽]` 就足以讓灰羽進注入集
// （參考圖回來、token 就地展開），且既有鎖定語義零退化、零 token 時逐位元等價。
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCharacterCardsToPayload,
  mergeTokenReferencedCards,
  type CharacterCard,
} from "./character-cards";
import { storyboardToBatchTasks } from "./drama-recipe";

function card(partial: Partial<CharacterCard> & { id: string }): CharacterCard {
  return {
    name: partial.id,
    kind: "character",
    prompt: "",
    references: [],
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
    ...partial,
  };
}

/** 卡庫全量（agent 建的卡就在這裡；**不在**鎖定集）。 */
const GREY = card({
  id: "biz-grey",
  name: "灰羽",
  prompt: "灰白羽翼少女",
  references: [{ url: "https://img/grey.png", role: "character", name: "灰羽" }],
});
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
const LIBRARY = [GREY, HO, STREET];

// ─────────────────────────────────────────── a：庫裡有、未鎖定 → 併入

test("a：prompt 引用庫中未鎖定的卡 → 併入注入集（參考圖回來、token 就地展開）", () => {
  const locked = [HO]; // 灰羽**不在**鎖定集
  const merged = mergeTokenReferencedCards(locked, LIBRARY, "@[角色:灰羽] 站在雨里");
  assert.deepEqual(
    merged.map((c) => c.id),
    ["card-ho", "biz-grey"],
    "灰羽（在庫未鎖定）必須被併入，且既有鎖定卡保持在前",
  );
  // 端狀態：真注入層（applyCharacterCardsToPayload）確實把灰羽的參考圖與片段帶進請求
  const payload = applyCharacterCardsToPayload({ prompt: "@[角色:灰羽] 站在雨里" }, merged);
  assert.deepEqual(
    (payload.reference_images ?? []).map((r) => r.url),
    ["https://img/grey.png", "https://img/ho.png"],
  );
  assert.ok(payload.prompt.includes("灰白羽翼少女"), "token 必須就地展開成灰羽的 prompt 片段");
  assert.ok(!payload.prompt.includes("@[角色:灰羽]"), "token 不應原樣漏給上游");
  assert.equal(payload.prompt, "银发黑衣男性\n灰白羽翼少女 站在雨里");
});

// ─────────────────────────────────────────── b：庫中沒有 → 不併入、不 throw、等價

test("b：prompt 引用庫中不存在的卡 → 不併入、不 throw，行為與現狀逐位元等價", () => {
  const locked = [HO];
  const prompt = "@[角色:不存在的卡] 站在雨里";
  const merged = mergeTokenReferencedCards(locked, LIBRARY, prompt);
  assert.equal(merged, locked, "零命中＝回同一陣列參考");
  // 現狀＝直接拿鎖定集餵注入層；併入後結果必須與之逐欄相同
  assert.deepEqual(
    applyCharacterCardsToPayload({ prompt }, merged),
    applyCharacterCardsToPayload({ prompt }, locked),
  );
});

// ─────────────────────────────────────────── c：陰性對照（無 token）

test("c：prompt 完全無 token → 回同一陣列參考（零新增、零副作用）", () => {
  const locked = [HO, STREET];
  const merged = mergeTokenReferencedCards(locked, LIBRARY, "雨夜街上的银发男人");
  assert.equal(merged, locked);
  assert.equal(merged.length, 2);
  // 無 token 時連卡庫都不需要（缺卡庫也逐位元等價）
  assert.equal(mergeTokenReferencedCards(locked, null, "雨夜街上的银发男人"), locked);
  assert.equal(mergeTokenReferencedCards(locked, undefined, "雨夜街上的银发男人"), locked);
  // 空 prompt 同理
  assert.equal(mergeTokenReferencedCards(locked, LIBRARY, ""), locked);
});

// ─────────────────────────────────────────── d：既有鎖定語義不退化

test("d：鎖定集裡未被 token 引用的卡仍在注入集（既有鎖定語義不退化）", () => {
  const locked = [HO, STREET];
  const merged = mergeTokenReferencedCards(locked, LIBRARY, "@[角色:灰羽] 走在街上");
  assert.deepEqual(merged.map((c) => c.id), ["card-ho", "card-street", "biz-grey"]);
  const payload = applyCharacterCardsToPayload({ prompt: "@[角色:灰羽] 走在街上" }, merged);
  // 未命中的鎖定卡照舊走前綴（token 命中者不進前綴）
  assert.equal(payload.prompt, "银发黑衣男性\n湿滑石板路霓虹\n灰白羽翼少女 走在街上");
  assert.deepEqual(
    (payload.reference_images ?? []).map((r) => r.url),
    ["https://img/grey.png", "https://img/ho.png", "https://img/street.png"],
  );
});

// ─────────────────────────────────────────── e：去重

test("e：token 引用的卡同時在鎖定集內 → 不重複併入", () => {
  const locked = [GREY, HO];
  const merged = mergeTokenReferencedCards(locked, LIBRARY, "@[角色:灰羽] 與 @[角色:灰羽]");
  assert.equal(merged, locked, "全命中既有集合＝回同一陣列參考");
  assert.equal(merged.filter((c) => c.id === GREY.id).length, 1);
  const payload = applyCharacterCardsToPayload({ prompt: "@[角色:灰羽] 與 @[角色:灰羽]" }, merged);
  assert.deepEqual((payload.reference_images ?? []).map((r) => r.url), ["https://img/grey.png", "https://img/ho.png"]);
});

// ─────────────────────────────────────────── f：非法/不符種類

test("f：kind 非法（resolveEntityTokenKind → null）或種類不符 → 不併入、不 throw", () => {
  const locked = [HO];
  for (const prompt of ["@[未知种类:灰羽] 在雨里", "@[场景:灰羽] 在雨里", "@[角色:雨夜街] 在雨里"]) {
    const merged = mergeTokenReferencedCards(locked, LIBRARY, prompt);
    assert.equal(merged, locked, `不應併入：${prompt}`);
  }
  // 同名同 kind 多張 → 取卡庫第一張（與 expandEntityTokens 同一把尺）
  const dupA = card({ id: "dup-a", name: "灰羽", prompt: "第一張" });
  const dupB = card({ id: "dup-b", name: "灰羽", prompt: "第二張" });
  const merged = mergeTokenReferencedCards([], [dupA, dupB], "@[角色:灰羽]");
  assert.deepEqual(merged.map((c) => c.id), ["dup-a"]);
});

// ─────────────────────────────────────────── 第二注入點：drama-recipe

test("drama-recipe：分鏡段 prompt 的 token 引用庫中未鎖定的卡 → 參考圖與片段進批次任務", () => {
  const storyboard = { shots: [{ shotId: "SB-01", prompt: "@[角色:灰羽] 站在夜市口" }] };
  const tasks = storyboardToBatchTasks(storyboard, LIBRARY);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].needsAsset, false);
  assert.deepEqual(tasks[0].missingCardIds, []);
  assert.equal(tasks[0].prompt, "灰白羽翼少女 站在夜市口");
  assert.deepEqual(tasks[0].referenceImages.map((r) => r.url), ["https://img/grey.png"]);
});

test("drama-recipe：零 token 時逐位元等價（只注入分鏡宣告的卡）", () => {
  const storyboard = {
    shots: [{ shotId: "SB-02", prompt: "夜市全景", characterCardIds: ["card-ho"], sceneCardIds: ["card-street"] }],
  };
  const tasks = storyboardToBatchTasks(storyboard, LIBRARY);
  assert.equal(tasks[0].prompt, "银发黑衣男性\n湿滑石板路霓虹\n夜市全景");
  assert.deepEqual(tasks[0].referenceImages.map((r) => r.url), ["https://img/ho.png", "https://img/street.png"]);
});
