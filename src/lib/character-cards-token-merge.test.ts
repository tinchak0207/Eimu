// mergeTokenReferencedCards（生成时「本段 prompt token 引用到的卡」就地并入注入集）行为验收。
//
// 立场：断言**行为**，不用源码字串断言（守门件不是 oracle）。
// 核心＝卡**在库但未锁定**时，正文写 `@[角色:灰羽]` 就足以让灰羽进注入集
// （参考图回来、token 就地展开），且既有锁定语义零退化、零 token 时逐位元等价。
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

/** 卡库全量（agent 建的卡就在这里；**不在**锁定集）。 */
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

// ─────────────────────────────────────────── a：库里有、未锁定 → 并入

test("a：prompt 引用库中未锁定的卡 → 并入注入集（参考图回来、token 就地展开）", () => {
  const locked = [HO]; // 灰羽**不在**锁定集
  const merged = mergeTokenReferencedCards(locked, LIBRARY, "@[角色:灰羽] 站在雨里");
  assert.deepEqual(
    merged.map((c) => c.id),
    ["card-ho", "biz-grey"],
    "灰羽（在库未锁定）必须被并入，且既有锁定卡保持在前",
  );
  // 端状态：真注入层（applyCharacterCardsToPayload）确实把灰羽的参考图与片段带进请求
  const payload = applyCharacterCardsToPayload({ prompt: "@[角色:灰羽] 站在雨里" }, merged);
  assert.deepEqual(
    (payload.reference_images ?? []).map((r) => r.url),
    ["https://img/grey.png", "https://img/ho.png"],
  );
  assert.ok(payload.prompt.includes("灰白羽翼少女"), "token 必须就地展开成灰羽的 prompt 片段");
  assert.ok(!payload.prompt.includes("@[角色:灰羽]"), "token 不应原样漏给上游");
  assert.equal(payload.prompt, "银发黑衣男性\n灰白羽翼少女 站在雨里");
});

// ─────────────────────────────────────────── b：库中没有 → 不并入、不 throw、等价

test("b：prompt 引用库中不存在的卡 → 不并入、不 throw，行为与现状逐位元等价", () => {
  const locked = [HO];
  const prompt = "@[角色:不存在的卡] 站在雨里";
  const merged = mergeTokenReferencedCards(locked, LIBRARY, prompt);
  assert.equal(merged, locked, "零命中＝回同一阵列参考");
  // 现状＝直接拿锁定集喂注入层；并入后结果必须与之逐栏相同
  assert.deepEqual(
    applyCharacterCardsToPayload({ prompt }, merged),
    applyCharacterCardsToPayload({ prompt }, locked),
  );
});

// ─────────────────────────────────────────── c：阴性对照（无 token）

test("c：prompt 完全无 token → 回同一阵列参考（零新增、零副作用）", () => {
  const locked = [HO, STREET];
  const merged = mergeTokenReferencedCards(locked, LIBRARY, "雨夜街上的银发男人");
  assert.equal(merged, locked);
  assert.equal(merged.length, 2);
  // 无 token 时连卡库都不需要（缺卡库也逐位元等价）
  assert.equal(mergeTokenReferencedCards(locked, null, "雨夜街上的银发男人"), locked);
  assert.equal(mergeTokenReferencedCards(locked, undefined, "雨夜街上的银发男人"), locked);
  // 空 prompt 同理
  assert.equal(mergeTokenReferencedCards(locked, LIBRARY, ""), locked);
});

// ─────────────────────────────────────────── d：既有锁定语义不退化

test("d：锁定集里未被 token 引用的卡仍在注入集（既有锁定语义不退化）", () => {
  const locked = [HO, STREET];
  const merged = mergeTokenReferencedCards(locked, LIBRARY, "@[角色:灰羽] 走在街上");
  assert.deepEqual(merged.map((c) => c.id), ["card-ho", "card-street", "biz-grey"]);
  const payload = applyCharacterCardsToPayload({ prompt: "@[角色:灰羽] 走在街上" }, merged);
  // 未命中的锁定卡照旧走前缀（token 命中者不进前缀）
  assert.equal(payload.prompt, "银发黑衣男性\n湿滑石板路霓虹\n灰白羽翼少女 走在街上");
  assert.deepEqual(
    (payload.reference_images ?? []).map((r) => r.url),
    ["https://img/grey.png", "https://img/ho.png", "https://img/street.png"],
  );
});

// ─────────────────────────────────────────── e：去重

test("e：token 引用的卡同时在锁定集内 → 不重复并入", () => {
  const locked = [GREY, HO];
  const merged = mergeTokenReferencedCards(locked, LIBRARY, "@[角色:灰羽] 与 @[角色:灰羽]");
  assert.equal(merged, locked, "全命中既有集合＝回同一阵列参考");
  assert.equal(merged.filter((c) => c.id === GREY.id).length, 1);
  const payload = applyCharacterCardsToPayload({ prompt: "@[角色:灰羽] 与 @[角色:灰羽]" }, merged);
  assert.deepEqual((payload.reference_images ?? []).map((r) => r.url), ["https://img/grey.png", "https://img/ho.png"]);
});

// ─────────────────────────────────────────── f：非法/不符种类

test("f：kind 非法（resolveEntityTokenKind → null）或种类不符 → 不并入、不 throw", () => {
  const locked = [HO];
  for (const prompt of ["@[未知种类:灰羽] 在雨里", "@[场景:灰羽] 在雨里", "@[角色:雨夜街] 在雨里"]) {
    const merged = mergeTokenReferencedCards(locked, LIBRARY, prompt);
    assert.equal(merged, locked, `不应并入：${prompt}`);
  }
  // 同名同 kind 多张 → 取卡库第一张（与 expandEntityTokens 同一把尺）
  const dupA = card({ id: "dup-a", name: "灰羽", prompt: "第一张" });
  const dupB = card({ id: "dup-b", name: "灰羽", prompt: "第二张" });
  const merged = mergeTokenReferencedCards([], [dupA, dupB], "@[角色:灰羽]");
  assert.deepEqual(merged.map((c) => c.id), ["dup-a"]);
});

// ─────────────────────────────────────────── 第二注入点：drama-recipe

test("drama-recipe：分镜段 prompt 的 token 引用库中未锁定的卡 → 参考图与片段进批次任务", () => {
  const storyboard = { shots: [{ shotId: "SB-01", prompt: "@[角色:灰羽] 站在夜市口" }] };
  const tasks = storyboardToBatchTasks(storyboard, LIBRARY);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].needsAsset, false);
  assert.deepEqual(tasks[0].missingCardIds, []);
  assert.equal(tasks[0].prompt, "灰白羽翼少女 站在夜市口");
  assert.deepEqual(tasks[0].referenceImages.map((r) => r.url), ["https://img/grey.png"]);
});

test("drama-recipe：零 token 时逐位元等价（只注入分镜宣告的卡）", () => {
  const storyboard = {
    shots: [{ shotId: "SB-02", prompt: "夜市全景", characterCardIds: ["card-ho"], sceneCardIds: ["card-street"] }],
  };
  const tasks = storyboardToBatchTasks(storyboard, LIBRARY);
  assert.equal(tasks[0].prompt, "银发黑衣男性\n湿滑石板路霓虹\n夜市全景");
  assert.deepEqual(tasks[0].referenceImages.map((r) => r.url), ["https://img/ho.png", "https://img/street.png"]);
});
