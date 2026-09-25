import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildMentionRows,
  deriveShotReference,
  groupShotReferenceEntries,
  serializeChipText,
  type ShotReferenceCandidate,
  type ShotReferenceEntry,
} from "./ShotReferencePanel";
import { expandEntityTokens, parseEntityTokens } from "@/lib/entity-tokens";
import type { CharacterCard } from "@/lib/character-cards";

/**
 * WS3（行內 @ 素材卡引用）行為驗收。
 *
 * 驗收立場（守門件不是 oracle）：主體是**行為斷言**——餵真實用戶輸入字串
 * （`@[角色:霍辞渊]` 原文）與假 dataset，斷言推導／分派結果；末尾的源碼級斷言
 * 只算「變更探針」，不計入已驗證。
 */

const HO = { id: "card-ho", name: "霍辞渊", kind: "character" as const, prompt: "银发黑衣男性", references: [] };
const STREET = { id: "card-street", name: "雨夜街", kind: "scene" as const, prompt: "湿滑石板路霓虹", references: [] };
const SWORD = { id: "card-sword", name: "古剑", kind: "prop" as const, prompt: "锈迹长锋", references: [] };

function cand(card: typeof HO, kindLabel: string, previewUrl = ""): ShotReferenceCandidate {
  return { cardId: card.id, name: card.name, kind: card.kind, kindLabel, previewUrl };
}

const CANDIDATES: ShotReferenceCandidate[] = [
  cand(HO, "角色", "https://img/ho.png"),
  cand(STREET, "场景"),
  cand(SWORD, "道具"),
];

// ─────────────────────────────── 1. 本鏡參考素材推導（真實用戶輸入字串）

test("deriveShotReference：正文 token 命中 → token 段；未引用候選 → locked 段", () => {
  const prompt = "雨夜里，@[角色:霍辞渊] 站在 @[场景:雨夜街] 中央";
  const { entries, unresolvedTokens } = deriveShotReference(prompt, CANDIDATES);

  assert.deepEqual(unresolvedTokens, [], "兩條 token 都能命中，不該有未匹配");
  assert.deepEqual(
    entries.map((e) => [e.source, e.name, e.kindLabel]),
    [
      ["token", "霍辞渊", "角色"],
      ["token", "雨夜街", "场景"],
      ["locked", "古剑", "道具"],
    ],
    "命中按出現序在前，鎖定未引用接在後",
  );
  assert.equal(entries[0].previewUrl, "https://img/ho.png", "token 條目帶卡的第一張參考圖");
});

test("deriveShotReference：未命中的 token 原文進 unresolvedTokens（不吞內容、不當成命中）", () => {
  const prompt = "镜头里 @[角色:查无此人] 走过，@[没听过的种类:东西] 也出现";
  const { entries, unresolvedTokens } = deriveShotReference(prompt, CANDIDATES);

  assert.deepEqual(unresolvedTokens, ["@[角色:查无此人]", "@[没听过的种类:东西]"]);
  assert.equal(entries.every((e) => e.source === "locked"), true, "未命中不得偽裝成 token 命中");
});

test("deriveShotReference：種類字消歧——同名卡按 kind 取，不誤抓第一張同名", () => {
  // 用戶原文寫「场景」：必須落在 scene 卡，而不是同名的 character 卡
  const twins: ShotReferenceCandidate[] = [
    { cardId: "char-1", name: "张记", kind: "character", kindLabel: "角色", previewUrl: "" },
    { cardId: "scene-1", name: "张记", kind: "scene", kindLabel: "场景", previewUrl: "" },
  ];
  const { entries } = deriveShotReference("@[场景:张记] 内景", twins);
  assert.deepEqual(entries.map((e) => [e.source, e.key]), [
    ["token", "token:scene-1"],
    ["locked", "locked:char-1"],
  ]);
});

test("deriveShotReference：同卡多次引用只列一條；零輸入零輸出", () => {
  const dup = deriveShotReference("@[角色:霍辞渊] 抬头，@[角色:霍辞渊] 又低头", CANDIDATES);
  assert.equal(dup.entries.filter((e) => e.source === "token").length, 1);

  const empty = deriveShotReference("", CANDIDATES);
  assert.equal(empty.entries.length, 3, "沒 token 時全部落在 locked（看得出漏引）");
  assert.deepEqual(empty.unresolvedTokens, []);
  assert.deepEqual(deriveShotReference("", []), { entries: [], unresolvedTokens: [] }, "零素材零 token ＝零空殼");
});

test("groupShotReferenceEntries：兩段分組，順序穩定", () => {
  const { entries } = deriveShotReference("@[角色:霍辞渊] 独行", CANDIDATES);
  const grouped = groupShotReferenceEntries(entries);
  assert.deepEqual(grouped.token.map((e) => e.name), ["霍辞渊"]);
  assert.deepEqual(grouped.locked.map((e) => e.name), ["雨夜街", "古剑"]);
});

test("groupShotReferenceEntries：第三種來源 shot（本鏡已指定）獨立成組，locked 仍墊底", () => {
  const entries: ShotReferenceEntry[] = [
    { key: "locked:c3", kindLabel: "道具", name: "古剑", previewUrl: "", source: "locked" },
    { key: "shot:c2", kindLabel: "场景", name: "雨夜街", previewUrl: "", source: "shot" },
    { key: "token:c1", kindLabel: "角色", name: "霍辞渊", previewUrl: "", source: "token" },
  ];
  const grouped = groupShotReferenceEntries(entries);
  assert.deepEqual(grouped.token.map((e) => e.name), ["霍辞渊"], "行內 @ 引用段");
  assert.deepEqual(grouped.shot.map((e) => e.name), ["雨夜街"], "本鏡已指定段（來自節點 metadata 卡 id）");
  assert.deepEqual(grouped.locked.map((e) => e.name), ["古剑"], "鎖定未引用段");
  assert.equal(
    grouped.token.length + grouped.shot.length + grouped.locked.length,
    entries.length,
    "三段互斥且不漏條目",
  );
});

// ─────────────────────────────── 2. chip 序列化分派（假 dataset，零 jsdom）

test("serializeChipText：帶 cardId → 行內 token（不誤編成 @图片N）", () => {
  assert.equal(serializeChipText({ cardId: "c1", cardKind: "scene", title: "雨夜街" }, []), "@[场景:雨夜街]");
  assert.equal(serializeChipText({ cardId: "c2", cardKind: "character", title: "霍辞渊" }, []), "@[角色:霍辞渊]");
  assert.equal(serializeChipText({ cardId: "c3", cardKind: "prop", title: "古剑" }, []), "@[道具:古剑]");
  // 即使同時帶 nodeId（理論上不該發生），cardId 分派優先
  assert.equal(serializeChipText({ nodeId: "n1", cardId: "c1", cardKind: "scene", title: "雨夜街" }, ["n1"]), "@[场景:雨夜街]");
  // 種類字認不出（舊資料/agent 亂填）→ 收斂角色，不炸
  assert.equal(serializeChipText({ cardId: "c9", cardKind: "??", title: "无名" }, []), "@[角色:无名]");
});

test("serializeChipText：圖片 chip 沿用 @图片N（N = 在已選清單的序號+1）", () => {
  assert.equal(serializeChipText({ nodeId: "n2", title: "场景A" }, ["n1", "n2"]), "@图片2");
  assert.equal(serializeChipText({ nodeId: "n9", title: "未选图" }, ["n1", "n2"]), "@未选图");
});

test("端到端（跨模組）：序列化出的 token 真的能被展開層就地還原成卡 prompt", () => {
  const text = `雨夜里，${serializeChipText({ cardId: "c1", cardKind: "scene", title: "雨夜街" }, [])} 中央`;
  const hits = parseEntityTokens(text);
  assert.equal(hits.length, 1, "序列化結果必須是可被 token 解析器認到的原文");
  assert.equal(hits[0].kindLabel, "场景");

  const cards: CharacterCard[] = [
    { ...HO, createdAt: "2026-09-24", updatedAt: "2026-09-24" },
    { ...STREET, createdAt: "2026-09-24", updatedAt: "2026-09-24" },
  ];
  const expanded = expandEntityTokens(text, cards);
  assert.equal(expanded.prompt, "雨夜里，湿滑石板路霓虹 中央", "token 就地替換成該卡片段（不搬到開頭）");
  assert.deepEqual(expanded.usedCardIds, ["card-street"]);
  assert.deepEqual(expanded.unresolved, []);
});

// ─────────────────────────────── 3. @ 選單兩組候選（攤平索引 + 過濾）

test("buildMentionRows：圖片組在前、素材卡組在後，索引跨組連續", () => {
  const rows = buildMentionRows([{ title: "上游图A" }, { title: "上游图B" }], [{ name: "霍辞渊" }, { name: "雨夜街" }], "");
  assert.deepEqual(rows.map((r) => [r.index, r.group, r.sourceIndex]), [
    [0, "image", 0],
    [1, "image", 1],
    [2, "entity", 0],
    [3, "entity", 1],
  ]);
});

test("buildMentionRows：query 對兩組同時生效（標題/名稱 lowercase includes）", () => {
  const rows = buildMentionRows([{ title: "Foggy Street" }, { title: "肖像" }], [{ name: "fog light" }, { name: "古剑" }], "FOG");
  assert.deepEqual(rows.map((r) => [r.group, r.sourceIndex]), [
    ["image", 0],
    ["entity", 0],
  ]);
  // 兩組都沒命中 → 空（消費端據此關選單，維持既有行為）
  assert.deepEqual(buildMentionRows([{ title: "肖像" }], [{ name: "古剑" }], "zzz"), []);
  // 某組為空 → 該組不出列（零空組）
  assert.deepEqual(buildMentionRows([], [{ name: "霍辞渊" }], "").map((r) => r.group), ["entity"]);
  // 純空白 query ＝ 不過濾
  assert.equal(buildMentionRows([{ title: "肖像" }], [{ name: "古剑" }], "   ").length, 2);
});

// ─────────────────────────────── 4. 掛接契約（源碼級變更探針，不計入已驗證）

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

test("變更探針：@ 選單兩組標題與面板透傳真的掛上（非行為驗證）", () => {
  const panel = read("src/components/canvas/CanvasNodePromptPanel.tsx");
  assert.match(panel, /"图片"[\s\S]*?"素材卡"/, "選單需有組標題（图片 / 素材卡）");
  assert.match(panel, /<ShotReferencePanel entries=\{shotReference\.entries\}/, "解析清單要掛在面板內");
  assert.match(panel, /onToggleEntity\?\.\(cand\.cardId\)/);

  const nodeView = read("src/components/canvas/CanvasNodeView.tsx");
  assert.match(nodeView, /entityCandidates=\{entityCandidates\}/, "CanvasNodeView 需透傳素材卡候選");
  assert.match(nodeView, /onToggleEntity=\{onToggleEntity\}/);

  const embed = read("src/components/canvas/CanvasEmbed.tsx");
  assert.match(embed, /canvas\.activeCharacterCards[\s\S]*?card\.references\[0\]\?\.url \?\? ""/, "候選來源＝項目鎖定卡");
  assert.match(embed, /entityCardIds: panelEntityIds/);

  const generation = read("src/components/canvas/embed/use-canvas-generation.ts");
  assert.match(generation, /referenceScope: "referenced"/, "按鏡引用需把本鏡收窄語義傳到卡注入層");
});