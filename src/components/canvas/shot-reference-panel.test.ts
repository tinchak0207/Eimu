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
 * WS3（行内 @ 素材卡引用）行为验收。
 *
 * 验收立场（守门件不是 oracle）：主体是**行为断言**——喂真实用户输入字串
 * （`@[角色:霍辞渊]` 原文）与假 dataset，断言推导／分派结果；末尾的源码级断言
 * 只算「变更探针」，不计入已验证。
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

// ─────────────────────────────── 1. 本镜参考素材推导（真实用户输入字串）

test("deriveShotReference：正文 token 命中 → token 段；未引用候选 → locked 段", () => {
  const prompt = "雨夜里，@[角色:霍辞渊] 站在 @[场景:雨夜街] 中央";
  const { entries, unresolvedTokens } = deriveShotReference(prompt, CANDIDATES);

  assert.deepEqual(unresolvedTokens, [], "两条 token 都能命中，不该有未匹配");
  assert.deepEqual(
    entries.map((e) => [e.source, e.name, e.kindLabel]),
    [
      ["token", "霍辞渊", "角色"],
      ["token", "雨夜街", "场景"],
      ["locked", "古剑", "道具"],
    ],
    "命中按出现序在前，锁定未引用接在后",
  );
  assert.equal(entries[0].previewUrl, "https://img/ho.png", "token 条目带卡的第一张参考图");
});

test("deriveShotReference：未命中的 token 原文进 unresolvedTokens（不吞内容、不当成命中）", () => {
  const prompt = "镜头里 @[角色:查无此人] 走过，@[没听过的种类:东西] 也出现";
  const { entries, unresolvedTokens } = deriveShotReference(prompt, CANDIDATES);

  assert.deepEqual(unresolvedTokens, ["@[角色:查无此人]", "@[没听过的种类:东西]"]);
  assert.equal(entries.every((e) => e.source === "locked"), true, "未命中不得伪装成 token 命中");
});

test("deriveShotReference：种类字消歧——同名卡按 kind 取，不误抓第一张同名", () => {
  // 用户原文写「场景」：必须落在 scene 卡，而不是同名的 character 卡
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

test("deriveShotReference：同卡多次引用只列一条；零输入零输出", () => {
  const dup = deriveShotReference("@[角色:霍辞渊] 抬头，@[角色:霍辞渊] 又低头", CANDIDATES);
  assert.equal(dup.entries.filter((e) => e.source === "token").length, 1);

  const empty = deriveShotReference("", CANDIDATES);
  assert.equal(empty.entries.length, 3, "没 token 时全部落在 locked（看得出漏引）");
  assert.deepEqual(empty.unresolvedTokens, []);
  assert.deepEqual(deriveShotReference("", []), { entries: [], unresolvedTokens: [] }, "零素材零 token ＝零空壳");
});

test("groupShotReferenceEntries：两段分组，顺序稳定", () => {
  const { entries } = deriveShotReference("@[角色:霍辞渊] 独行", CANDIDATES);
  const grouped = groupShotReferenceEntries(entries);
  assert.deepEqual(grouped.token.map((e) => e.name), ["霍辞渊"]);
  assert.deepEqual(grouped.locked.map((e) => e.name), ["雨夜街", "古剑"]);
});

test("groupShotReferenceEntries：第三种来源 shot（本镜已指定）独立成组，locked 仍垫底", () => {
  const entries: ShotReferenceEntry[] = [
    { key: "locked:c3", kindLabel: "道具", name: "古剑", previewUrl: "", source: "locked" },
    { key: "shot:c2", kindLabel: "场景", name: "雨夜街", previewUrl: "", source: "shot" },
    { key: "token:c1", kindLabel: "角色", name: "霍辞渊", previewUrl: "", source: "token" },
  ];
  const grouped = groupShotReferenceEntries(entries);
  assert.deepEqual(grouped.token.map((e) => e.name), ["霍辞渊"], "行内 @ 引用段");
  assert.deepEqual(grouped.shot.map((e) => e.name), ["雨夜街"], "本镜已指定段（来自节点 metadata 卡 id）");
  assert.deepEqual(grouped.locked.map((e) => e.name), ["古剑"], "锁定未引用段");
  assert.equal(
    grouped.token.length + grouped.shot.length + grouped.locked.length,
    entries.length,
    "三段互斥且不漏条目",
  );
});

// ─────────────────────────────── 2. chip 序列化分派（假 dataset，零 jsdom）

test("serializeChipText：带 cardId → 行内 token（不误编成 @图片N）", () => {
  assert.equal(serializeChipText({ cardId: "c1", cardKind: "scene", title: "雨夜街" }, []), "@[场景:雨夜街]");
  assert.equal(serializeChipText({ cardId: "c2", cardKind: "character", title: "霍辞渊" }, []), "@[角色:霍辞渊]");
  assert.equal(serializeChipText({ cardId: "c3", cardKind: "prop", title: "古剑" }, []), "@[道具:古剑]");
  // 即使同时带 nodeId（理论上不该发生），cardId 分派优先
  assert.equal(serializeChipText({ nodeId: "n1", cardId: "c1", cardKind: "scene", title: "雨夜街" }, ["n1"]), "@[场景:雨夜街]");
  // 种类字认不出（旧资料/agent 乱填）→ 收敛角色，不炸
  assert.equal(serializeChipText({ cardId: "c9", cardKind: "??", title: "无名" }, []), "@[角色:无名]");
});

test("serializeChipText：图片 chip 沿用 @图片N（N = 在已选清单的序号+1）", () => {
  assert.equal(serializeChipText({ nodeId: "n2", title: "场景A" }, ["n1", "n2"]), "@图片2");
  assert.equal(serializeChipText({ nodeId: "n9", title: "未选图" }, ["n1", "n2"]), "@未选图");
});

test("端到端（跨模组）：序列化出的 token 真的能被展开层就地还原成卡 prompt", () => {
  const text = `雨夜里，${serializeChipText({ cardId: "c1", cardKind: "scene", title: "雨夜街" }, [])} 中央`;
  const hits = parseEntityTokens(text);
  assert.equal(hits.length, 1, "序列化结果必须是可被 token 解析器认到的原文");
  assert.equal(hits[0].kindLabel, "场景");

  const cards: CharacterCard[] = [
    { ...HO, createdAt: "2026-09-24", updatedAt: "2026-09-24" },
    { ...STREET, createdAt: "2026-09-24", updatedAt: "2026-09-24" },
  ];
  const expanded = expandEntityTokens(text, cards);
  assert.equal(expanded.prompt, "雨夜里，湿滑石板路霓虹 中央", "token 就地替换成该卡片段（不搬到开头）");
  assert.deepEqual(expanded.usedCardIds, ["card-street"]);
  assert.deepEqual(expanded.unresolved, []);
});

// ─────────────────────────────── 3. @ 选单两组候选（摊平索引 + 过滤）

test("buildMentionRows：图片组在前、素材卡组在后，索引跨组连续", () => {
  const rows = buildMentionRows([{ title: "上游图A" }, { title: "上游图B" }], [{ name: "霍辞渊" }, { name: "雨夜街" }], "");
  assert.deepEqual(rows.map((r) => [r.index, r.group, r.sourceIndex]), [
    [0, "image", 0],
    [1, "image", 1],
    [2, "entity", 0],
    [3, "entity", 1],
  ]);
});

test("buildMentionRows：query 对两组同时生效（标题/名称 lowercase includes）", () => {
  const rows = buildMentionRows([{ title: "Foggy Street" }, { title: "肖像" }], [{ name: "fog light" }, { name: "古剑" }], "FOG");
  assert.deepEqual(rows.map((r) => [r.group, r.sourceIndex]), [
    ["image", 0],
    ["entity", 0],
  ]);
  // 两组都没命中 → 空（消费端据此关选单，维持既有行为）
  assert.deepEqual(buildMentionRows([{ title: "肖像" }], [{ name: "古剑" }], "zzz"), []);
  // 某组为空 → 该组不出列（零空组）
  assert.deepEqual(buildMentionRows([], [{ name: "霍辞渊" }], "").map((r) => r.group), ["entity"]);
  // 纯空白 query ＝ 不过滤
  assert.equal(buildMentionRows([{ title: "肖像" }], [{ name: "古剑" }], "   ").length, 2);
});

// ─────────────────────────────── 4. 挂接契约（源码级变更探针，不计入已验证）

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

test("变更探针：@ 选单两组标题与面板透传真的挂上（非行为验证）", () => {
  const panel = read("src/components/canvas/CanvasNodePromptPanel.tsx");
  assert.match(panel, /"图片"[\s\S]*?"素材卡"/, "选单需有组标题（图片 / 素材卡）");
  assert.match(panel, /<ShotReferencePanel entries=\{shotReference\.entries\}/, "解析清单要挂在面板内");
  assert.match(panel, /onToggleEntity\?\.\(cand\.cardId\)/);

  const nodeView = read("src/components/canvas/CanvasNodeView.tsx");
  assert.match(nodeView, /entityCandidates=\{entityCandidates\}/, "CanvasNodeView 需透传素材卡候选");
  assert.match(nodeView, /onToggleEntity=\{onToggleEntity\}/);

  const embed = read("src/components/canvas/CanvasEmbed.tsx");
  assert.match(embed, /canvas\.activeCharacterCards[\s\S]*?card\.references\[0\]\?\.url \?\? ""/, "候选来源＝项目锁定卡");
  assert.match(embed, /entityCardIds: panelEntityIds/);

  const generation = read("src/components/canvas/embed/use-canvas-generation.ts");
  assert.match(generation, /referenceScope: "referenced"/, "按镜引用需把本镜收窄语义传到卡注入层");
});