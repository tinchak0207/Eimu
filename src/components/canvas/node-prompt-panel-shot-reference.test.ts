// WS9（本镜参考素材第三种来源 `shot`）行为验收。
//
// 验收立场（守门件不是 oracle）：主体是**行为断言**——把真实用户输入字串（`@[角色:霍辞渊]`）
// 与假候选卡/假节点 metadata 喂进真实推导函式，断言优先序与去重结果；
// 本档不含源码字串断言。
//
// 钉死：
//   1. 优先序 token > shot > locked（同一张卡只出现一次）。
//   2. shot 不在 entityCandidates 内 → 静默跳过（不出现没名字的条目）。
//   3. metadata 三栏联集去重（character ∪ scene ∪ prop，保序）。
//   4. 缺省／空 `shotEntityCardIds` → 与既有三来源推导逐位元相同（零回归）。

import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveShotReferenceEntries,
  shotEntityCardIdsFromMetadata,
  type CanvasEntityCandidate,
} from "./CanvasNodePromptPanel";
import { deriveShotReference } from "./ShotReferencePanel";

const HO: CanvasEntityCandidate = {
  cardId: "card-ho",
  name: "霍辞渊",
  kind: "character",
  kindLabel: "角色",
  previewUrl: "https://img/ho.png",
};
const STREET: CanvasEntityCandidate = {
  cardId: "card-street",
  name: "雨夜街",
  kind: "scene",
  kindLabel: "场景",
  previewUrl: "",
};
const SWORD: CanvasEntityCandidate = {
  cardId: "card-sword",
  name: "古剑",
  kind: "prop",
  kindLabel: "道具",
  previewUrl: "",
};

const CANDIDATES: CanvasEntityCandidate[] = [HO, STREET, SWORD];

// ─────────────────────────────── 1. 优先序三态（真实输入字串 + 真源 flag）

test("优先序：同一张卡既是 token 又是 shot → 只出现一次且 source 为 token", () => {
  const { entries } = deriveShotReferenceEntries(
    "雨夜里，@[角色:霍辞渊] 站定",
    CANDIDATES,
    [HO.cardId],
  );

  const hoEntries = entries.filter((e) => e.name === "霍辞渊");
  assert.equal(hoEntries.length, 1, "同一张卡不得重复成两条");
  assert.equal(hoEntries[0].source, "token", "人明写的 @ 引用压过机器回填的 shot");
  assert.equal(hoEntries[0].key, "token:card-ho");
  assert.equal(hoEntries[0].previewUrl, "https://img/ho.png", "沿用卡的第一张参考图");
});

test("优先序：同一张卡既是 shot 又是 locked → source 为 shot，locked 段不再出现它", () => {
  const { entries } = deriveShotReferenceEntries("没有任何引用", CANDIDATES, [SWORD.cardId]);

  const swordEntries = entries.filter((e) => e.name === "古剑");
  assert.equal(swordEntries.length, 1, "不得同时落在 shot 与 locked");
  assert.equal(swordEntries[0].source, "shot");
  assert.equal(swordEntries[0].key, "shot:card-sword");
  assert.deepEqual(
    entries.map((e) => [e.source, e.name]),
    [
      ["shot", "古剑"],
      ["locked", "霍辞渊"],
      ["locked", "雨夜街"],
    ],
    "shot 段在 locked 段之前，locked 只剩没被指定/引用的卡（候选原序）",
  );
});

test("优先序：既没引用也没指定 → 仍为 locked（既有语义不变）", () => {
  const { entries } = deriveShotReferenceEntries("@[角色:霍辞渊] 独行", CANDIDATES, [STREET.cardId]);

  assert.deepEqual(
    entries.map((e) => [e.source, e.name]),
    [
      ["token", "霍辞渊"],
      ["shot", "雨夜街"],
      ["locked", "古剑"],
    ],
    "三段各归其位且互斥",
  );
});

// ─────────────────────────────── 2. 不在候选内的 shot id 静默跳过

test("shot 的 id 不在 entityCandidates 内 → 静默跳过（不产生没名字的条目）", () => {
  const { entries } = deriveShotReferenceEntries("", CANDIDATES, ["ghost-card", SWORD.cardId]);

  assert.equal(
    entries.some((e) => e.key === "shot:ghost-card"),
    false,
    "不在候选内（已过作用域裁决）的 id 不得进清单",
  );
  assert.deepEqual(entries.map((e) => e.name), ["古剑", "霍辞渊", "雨夜街"], "其余照旧，不因幽灵 id 而位移");
  assert.equal(entries.every((e) => e.name.trim().length > 0), true, "任何条目都必须有名字");
});

test("shot 去重与空值：同一 id 重复／空字串 → 只出一条、空字串不进清单", () => {
  const { entries } = deriveShotReferenceEntries("", CANDIDATES, [SWORD.cardId, SWORD.cardId, "", "  "]);

  assert.equal(entries.filter((e) => e.source === "shot").length, 1, "重复 id 只出一条");
  // 空字串只在候选卡：这里「  」也不是有效 id（不在 byCardId 内）→ 静默跳过
  assert.equal(entries.length, 3, "三张候选卡各一条：1 shot + 2 locked，无空壳条目");
});

// ─────────────────────────────── 3. metadata 三栏联集去重

test("shotEntityCardIdsFromMetadata：character ∪ scene ∪ prop 联集去重且保序", () => {
  assert.deepEqual(
    shotEntityCardIdsFromMetadata({ characterCardIds: ["a"], sceneCardIds: ["a", "b"], propCardIds: ["c"] }),
    ["a", "b", "c"],
  );
  // 单栏 / 部分缺栏
  assert.deepEqual(shotEntityCardIdsFromMetadata({ characterCardIds: ["x", "x"] }), ["x"]);
  assert.deepEqual(shotEntityCardIdsFromMetadata({ propCardIds: ["c1", "c2"] }), ["c1", "c2"]);
  // 三栏齐全且互相重叠
  assert.deepEqual(
    shotEntityCardIdsFromMetadata({ characterCardIds: ["a", "b"], sceneCardIds: ["b"], propCardIds: ["a", "c"] }),
    ["a", "b", "c"],
  );
});

test("shotEntityCardIdsFromMetadata：缺省／全空 → 空阵列（＝所有既有节点）", () => {
  assert.deepEqual(shotEntityCardIdsFromMetadata(undefined), []);
  assert.deepEqual(shotEntityCardIdsFromMetadata({}), []);
  assert.deepEqual(
    shotEntityCardIdsFromMetadata({ characterCardIds: [], sceneCardIds: [], propCardIds: [] }),
    [],
  );
});

// ─────────────────────────────── 4. 零回归：缺省／空 shot 与既有三来源推导逐位元相同

test("零回归：缺省或空 shotEntityCardIds → 条目与未解析 token 与既有推导逐位元相同", () => {
  const prompt = "雨夜里 @[角色:霍辞渊] 站在 @[场景:雨夜街] 中央，@[角色:查无此人] 也在";
  const omitted = deriveShotReferenceEntries(prompt, CANDIDATES);
  const empty = deriveShotReferenceEntries(prompt, CANDIDATES, []);
  const idsFromEmptyMetadata = deriveShotReferenceEntries(
    prompt,
    CANDIDATES,
    shotEntityCardIdsFromMetadata({ characterCardIds: [], sceneCardIds: [], propCardIds: [] }),
  );

  assert.deepEqual(omitted, empty, "缺省与空阵列不得有差");
  assert.deepEqual(omitted, idsFromEmptyMetadata, "三栏全空（＝所有既有节点）与缺省等价");
  // oracle ＝ 改动前那条推导路径（本档 import 的旧函式仍在，作为逐位元对照源）
  const legacy = deriveShotReference(prompt, CANDIDATES);
  assert.deepEqual(omitted.entries, legacy.entries, "条目与改动前逐条相同（同序、同 key、同栏位值）");
  assert.deepEqual(omitted.unresolvedTokens, legacy.unresolvedTokens, "未解析清单逐字相同");
  assert.deepEqual(
    omitted.entries.map((e) => [e.source, e.key, e.name, e.kindLabel, e.previewUrl]),
    [
      ["token", "token:card-ho", "霍辞渊", "角色", "https://img/ho.png"],
      ["token", "token:card-street", "雨夜街", "场景", ""],
      ["locked", "locked:card-sword", "古剑", "道具", ""],
    ],
    "token 按出现序在前、locked 垫底（既有顺序零变化）",
  );
  assert.deepEqual(omitted.unresolvedTokens, ["@[角色:查无此人]"], "未解析 token 逻辑逐字不动");
  assert.equal(omitted.entries.length, 3, "零 shot 不等于多／少一条");
});

test("零回归：空候选空 shot → 完全空（零空壳）", () => {
  assert.deepEqual(deriveShotReferenceEntries("", [], []), { entries: [], unresolvedTokens: [] });
});