// WS9（本鏡参考素材第三種來源 `shot`）行為驗收。
//
// 驗收立場（守門件不是 oracle）：主體是**行為斷言**——把真實用戶輸入字串（`@[角色:霍辞渊]`）
// 與假候選卡/假節點 metadata 餵進真實推導函式，斷言優先序與去重結果；
// 本檔不含源碼字串斷言。
//
// 釘死：
//   1. 優先序 token > shot > locked（同一張卡只出現一次）。
//   2. shot 不在 entityCandidates 內 → 靜默跳過（不出現沒名字的條目）。
//   3. metadata 三欄聯集去重（character ∪ scene ∪ prop，保序）。
//   4. 缺省／空 `shotEntityCardIds` → 與既有三來源推導逐位元相同（零回歸）。

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

// ─────────────────────────────── 1. 優先序三態（真實輸入字串 + 真源 flag）

test("優先序：同一張卡既是 token 又是 shot → 只出現一次且 source 為 token", () => {
  const { entries } = deriveShotReferenceEntries(
    "雨夜里，@[角色:霍辞渊] 站定",
    CANDIDATES,
    [HO.cardId],
  );

  const hoEntries = entries.filter((e) => e.name === "霍辞渊");
  assert.equal(hoEntries.length, 1, "同一張卡不得重複成兩條");
  assert.equal(hoEntries[0].source, "token", "人明寫的 @ 引用壓過機器回填的 shot");
  assert.equal(hoEntries[0].key, "token:card-ho");
  assert.equal(hoEntries[0].previewUrl, "https://img/ho.png", "沿用卡的第一張參考圖");
});

test("優先序：同一張卡既是 shot 又是 locked → source 為 shot，locked 段不再出現它", () => {
  const { entries } = deriveShotReferenceEntries("没有任何引用", CANDIDATES, [SWORD.cardId]);

  const swordEntries = entries.filter((e) => e.name === "古剑");
  assert.equal(swordEntries.length, 1, "不得同時落在 shot 與 locked");
  assert.equal(swordEntries[0].source, "shot");
  assert.equal(swordEntries[0].key, "shot:card-sword");
  assert.deepEqual(
    entries.map((e) => [e.source, e.name]),
    [
      ["shot", "古剑"],
      ["locked", "霍辞渊"],
      ["locked", "雨夜街"],
    ],
    "shot 段在 locked 段之前，locked 只剩沒被指定/引用的卡（候選原序）",
  );
});

test("優先序：既沒引用也沒指定 → 仍為 locked（既有語義不變）", () => {
  const { entries } = deriveShotReferenceEntries("@[角色:霍辞渊] 独行", CANDIDATES, [STREET.cardId]);

  assert.deepEqual(
    entries.map((e) => [e.source, e.name]),
    [
      ["token", "霍辞渊"],
      ["shot", "雨夜街"],
      ["locked", "古剑"],
    ],
    "三段各歸其位且互斥",
  );
});

// ─────────────────────────────── 2. 不在候選內的 shot id 靜默跳過

test("shot 的 id 不在 entityCandidates 內 → 靜默跳過（不產生沒名字的條目）", () => {
  const { entries } = deriveShotReferenceEntries("", CANDIDATES, ["ghost-card", SWORD.cardId]);

  assert.equal(
    entries.some((e) => e.key === "shot:ghost-card"),
    false,
    "不在候選內（已過作用域裁決）的 id 不得進清單",
  );
  assert.deepEqual(entries.map((e) => e.name), ["古剑", "霍辞渊", "雨夜街"], "其餘照舊，不因幽靈 id 而位移");
  assert.equal(entries.every((e) => e.name.trim().length > 0), true, "任何條目都必須有名字");
});

test("shot 去重與空值：同一 id 重複／空字串 → 只出一條、空字串不進清單", () => {
  const { entries } = deriveShotReferenceEntries("", CANDIDATES, [SWORD.cardId, SWORD.cardId, "", "  "]);

  assert.equal(entries.filter((e) => e.source === "shot").length, 1, "重複 id 只出一條");
  // 空字串只在候選卡：這裡「  」也不是有效 id（不在 byCardId 內）→ 靜默跳過
  assert.equal(entries.length, 3, "三張候選卡各一條：1 shot + 2 locked，無空殼條目");
});

// ─────────────────────────────── 3. metadata 三欄聯集去重

test("shotEntityCardIdsFromMetadata：character ∪ scene ∪ prop 聯集去重且保序", () => {
  assert.deepEqual(
    shotEntityCardIdsFromMetadata({ characterCardIds: ["a"], sceneCardIds: ["a", "b"], propCardIds: ["c"] }),
    ["a", "b", "c"],
  );
  // 單欄 / 部分缺欄
  assert.deepEqual(shotEntityCardIdsFromMetadata({ characterCardIds: ["x", "x"] }), ["x"]);
  assert.deepEqual(shotEntityCardIdsFromMetadata({ propCardIds: ["c1", "c2"] }), ["c1", "c2"]);
  // 三欄齊全且互相重疊
  assert.deepEqual(
    shotEntityCardIdsFromMetadata({ characterCardIds: ["a", "b"], sceneCardIds: ["b"], propCardIds: ["a", "c"] }),
    ["a", "b", "c"],
  );
});

test("shotEntityCardIdsFromMetadata：缺省／全空 → 空陣列（＝所有既有節點）", () => {
  assert.deepEqual(shotEntityCardIdsFromMetadata(undefined), []);
  assert.deepEqual(shotEntityCardIdsFromMetadata({}), []);
  assert.deepEqual(
    shotEntityCardIdsFromMetadata({ characterCardIds: [], sceneCardIds: [], propCardIds: [] }),
    [],
  );
});

// ─────────────────────────────── 4. 零回歸：缺省／空 shot 與既有三來源推導逐位元相同

test("零回歸：缺省或空 shotEntityCardIds → 條目與未解析 token 與既有推導逐位元相同", () => {
  const prompt = "雨夜里 @[角色:霍辞渊] 站在 @[场景:雨夜街] 中央，@[角色:查无此人] 也在";
  const omitted = deriveShotReferenceEntries(prompt, CANDIDATES);
  const empty = deriveShotReferenceEntries(prompt, CANDIDATES, []);
  const idsFromEmptyMetadata = deriveShotReferenceEntries(
    prompt,
    CANDIDATES,
    shotEntityCardIdsFromMetadata({ characterCardIds: [], sceneCardIds: [], propCardIds: [] }),
  );

  assert.deepEqual(omitted, empty, "缺省與空陣列不得有差");
  assert.deepEqual(omitted, idsFromEmptyMetadata, "三欄全空（＝所有既有節點）與缺省等價");
  // oracle ＝ 改動前那條推導路徑（本檔 import 的舊函式仍在，作為逐位元對照源）
  const legacy = deriveShotReference(prompt, CANDIDATES);
  assert.deepEqual(omitted.entries, legacy.entries, "條目與改動前逐條相同（同序、同 key、同欄位值）");
  assert.deepEqual(omitted.unresolvedTokens, legacy.unresolvedTokens, "未解析清單逐字相同");
  assert.deepEqual(
    omitted.entries.map((e) => [e.source, e.key, e.name, e.kindLabel, e.previewUrl]),
    [
      ["token", "token:card-ho", "霍辞渊", "角色", "https://img/ho.png"],
      ["token", "token:card-street", "雨夜街", "场景", ""],
      ["locked", "locked:card-sword", "古剑", "道具", ""],
    ],
    "token 按出現序在前、locked 墊底（既有順序零變化）",
  );
  assert.deepEqual(omitted.unresolvedTokens, ["@[角色:查无此人]"], "未解析 token 邏輯逐字不動");
  assert.equal(omitted.entries.length, 3, "零 shot 不等於多／少一條");
});

test("零回歸：空候選空 shot → 完全空（零空殼）", () => {
  assert.deepEqual(deriveShotReferenceEntries("", [], []), { entries: [], unresolvedTokens: [] });
});