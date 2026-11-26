// 行内实体引用 token（@[角色:霍辞渊]）：纯逻辑层。
//
// 定位：卡（character-cards.ts）是「项目级锁定配置」——挂上画布就自动全量注入。
// token 是**逐处引用**：写在提示词正文里，展开时「就地」替换成该卡的 prompt 片段，
// 让「这一镜要谁/哪个场景/用哪个道具」变成可精确指名的实体引用，
// 而不是靠整包锁定把所有卡都塞进前缀。
//
// 语法（冻结契约）：`@[种类:名称]`
//   - 种类字：正/简/英文皆收（角色|人物 / 场景|场景|scene / …），见 resolveEntityTokenKind
//   - 名称：1..100 字，不含 `[` `]`（避免嵌套歧义）
//   - 未命中/未知名称 → 原样保留 token 字串（fail-open，不报错、不吞内容）
//
// 本档只做纯函式：不改 cards、不 mutate 输入、不做 I/O。

import type { CharacterCard, CharacterCardKind } from "./character-cards";

/** 行内实体引用的 token 语法：`@[角色:霍辞渊]`。 */
export const ENTITY_TOKEN_PATTERN = /@\[([^\[\]:]{1,40}):([^\[\]]{1,100})\]/g;

export interface EntityTokenHit {
  /** token 里写的种类字（未正规化，如「场景」）。 */
  kindLabel: string;
  name: string;
  start: number;
  end: number;
}

/**
 * 种类字 → 卡 kind。正/简/英文皆收；其余（含空字串、未知词）→ null。
 * 注意：`scene` 等英文词只认小写原文（与 toCharacterCardKind 的 fail-closed 同调）。
 */
export function resolveEntityTokenKind(kindLabel: string): CharacterCardKind | null {
  const clean = kindLabel.trim();
  if (!clean) return null;
  if (clean === "角色" || clean === "人物" || clean === "character") return "character";
  if (clean === "场景" || clean === "场景" || clean === "scene") return "scene";
  if (clean === "风格" || clean === "风格" || clean === "style") return "style";
  if (clean === "道具" || clean === "prop") return "prop";
  if (
    clean === "音频" ||
    clean === "音频" ||
    clean === "音效" ||
    clean === "配乐" ||
    clean === "配乐" ||
    clean === "audio"
  ) {
    return "audio";
  }
  return null;
}

/** 解析提示词中的全部 token（按出现序；不做任何解析度/命中判定）。 */
export function parseEntityTokens(prompt: string): EntityTokenHit[] {
  const hits: EntityTokenHit[] = [];
  if (!prompt) return hits;
  // 全域正则带 lastIndex 状态：每次呼叫重建（模组级常数共用会串味）。
  const pattern = new RegExp(ENTITY_TOKEN_PATTERN.source, "g");
  for (let match = pattern.exec(prompt); match; match = pattern.exec(prompt)) {
    hits.push({
      kindLabel: match[1],
      name: match[2],
      start: match.index,
      end: match.index + match[0].length,
    });
    if (match[0].length === 0) pattern.lastIndex += 1; // 理论上不可能（长度 ≥ 5），保险防死循环
  }
  return hits;
}

// ─────────────────────────────────────────── 畸形 token 诊断（只诊断、不改写）

/**
 * 畸形形状的分类（**只诊断，不改写**：原文一律照留，只让呼叫端多一句人话提示）。
 *   - `empty_name`：`@[角色:]` —— 名称段为空（`ENTITY_TOKEN_PATTERN` 要求名称 1..100 字，故不算 token）
 *   - `unclosed`：`@[角色:灰羽` —— 名称段没有右括号收尾
 *   - `unknown_kind`：`@[未知种类:灰羽]` —— 语法完整但种类字无法辨识（会落在 `expandEntityTokens` 的 unresolved）
 */
export type MalformedEntityTokenReason = "empty_name" | "unclosed" | "unknown_kind";

export interface MalformedEntityToken {
  /** 原文片段（**原样**，未做任何替换；呼叫端可直接写进 warning）。 */
  raw: string;
  reason: MalformedEntityTokenReason;
  /** token 里写的种类字（`@[角色:]` → "角色"）。 */
  kindLabel: string;
  /** 名称段（`@[角色:]` → ""）。 */
  name: string;
}

/** `@[种类:]`：名称段为空。种类字 0..40（`@[:]` 也算畸形：种类字空）。 */
const EMPTY_NAME_TOKEN_PATTERN = /@\[([^\[\]:]{0,40}):\]/g;

/** `@[种类:名称`：名称段非空但**没有**右括号收尾（后一个字元不是 `]` 即判畸形）。 */
const UNCLOSED_TOKEN_PATTERN = /@\[([^\[\]:]{1,40}):([^\[\]]{1,100})/g;

/**
 * 找出「看起来想写 token 但没解析成功」的形状（纯函式、零 I/O、**不改写任何内容**）。
 *
 * 只认三种形状（刻意不收「缺冒号」如 `@[Verse]`——那更可能是正文而不是打错的 token，
 * 误报会制造噪音）：
 *   ①`@[角色:]` 名称为空；②`@[角色:灰羽` 缺右括号；③`@[未知种类:灰羽]` 种类字无法辨识。
 *
 * 保序（按出现位置）、按原文去重；正常 token（如 `@[角色:灰羽]`）**绝不**回报
 * （阴性对照：正常 token 不得被误报为畸形）。
 */
export function findMalformedEntityTokens(prompt: string): MalformedEntityToken[] {
  const found: (MalformedEntityToken & { start: number })[] = [];
  if (!prompt || !prompt.includes("@[")) return found;
  const seen = new Set<string>();
  const push = (start: number, raw: string, reason: MalformedEntityTokenReason, kindLabel: string, name: string) => {
    if (!raw || seen.has(raw)) return;
    seen.add(raw);
    found.push({ start, raw, reason, kindLabel, name });
  };

  // ③ 语法完整但种类字不认：用既有的 parseEntityTokens（**不另写 token 语法**）。
  for (const hit of parseEntityTokens(prompt)) {
    if (resolveEntityTokenKind(hit.kindLabel)) continue;
    push(hit.start, prompt.slice(hit.start, hit.end), "unknown_kind", hit.kindLabel, hit.name);
  }

  // ① 名称为空（`ENTITY_TOKEN_PATTERN` 不匹配 ⇒ parseEntityTokens 看不到，必须另扫）。
  const emptyName = new RegExp(EMPTY_NAME_TOKEN_PATTERN.source, "g");
  for (let match = emptyName.exec(prompt); match; match = emptyName.exec(prompt)) {
    push(match.index, match[0], "empty_name", match[1], "");
    if (match[0].length === 0) emptyName.lastIndex += 1;
  }

  // ② 缺右括号：名称字元集不含 `]`，所以「紧接在匹配之后的字元不是 `]`」＝名称段没收尾。
  const unclosed = new RegExp(UNCLOSED_TOKEN_PATTERN.source, "g");
  for (let match = unclosed.exec(prompt); match; match = unclosed.exec(prompt)) {
    if (prompt[match.index + match[0].length] === "]") continue; // 正常 token（含名称刚好顶到上限）
    push(match.index, match[0], "unclosed", match[1], match[2]);
    if (match[0].length === 0) unclosed.lastIndex += 1;
  }

  // 保序：按出现位置（三种形状互斥，同位置不可能撞）。
  found.sort((a, b) => a.start - b.start);
  return found.map(({ start: _start, ...entry }) => entry);
}

/** 卡的 token 原文：`@[角色:霍辞渊]`。 */
export function serializeEntityToken(card: Pick<CharacterCard, "kind" | "name">): string {
  return `@[${kindLabelForCardKind(card.kind)}:${card.name.trim()}]`;
}

/** 卡 kind → token 用的种类字（简体，与卡的 token 输入端一致）。 */
function kindLabelForCardKind(kind: CharacterCardKind): string {
  switch (kind) {
    case "scene":
      return "场景";
    case "style":
      return "风格";
    case "prop":
      return "道具";
    case "audio":
      return "音频";
    default:
      return "角色";
  }
}

/**
 * 把正文里的 token 就地展开成对应卡的 prompt 片段。
 *
 * 语义：
 *   - 命中：整段 token（start..end）就地替换（**不搬到开头**）；片段为空字串 → 替换成卡名。
 *   - 未命中（种类字未知 / 没有同名同 kind 的卡）：原样保留 token 字串，并记入 unresolved。
 *   - 同名同 kind 多张卡：取 cards 阵列中**第一张**——刻意 fail-safe（不因为重名而炸或全丢）。
 *   - usedCardIds：按首次出现序去重；unresolved：去重（按首次出现序）。
 *   - 零 token：prompt 逐位元不变，回空阵列。
 *
 * 纯函式：不改 cards、不 mutate 输入。
 */
export function expandEntityTokens(
  prompt: string,
  cards: readonly CharacterCard[],
): { prompt: string; usedCardIds: string[]; unresolved: string[] } {
  const hits = parseEntityTokens(prompt);
  if (hits.length === 0) return { prompt, usedCardIds: [], unresolved: [] };

  const usedCardIds: string[] = [];
  const unresolved: string[] = [];
  let cursor = 0;
  let out = "";
  for (const hit of hits) {
    out += prompt.slice(cursor, hit.start);
    const kind = resolveEntityTokenKind(hit.kindLabel);
    const matched = kind
      ? cards.find((card) => card.kind === kind && card.name.trim() === hit.name.trim())
      : undefined;
    if (!matched) {
      // 未命中：token 原样保留（fail-open），并记录原始字串。
      const raw = prompt.slice(hit.start, hit.end);
      out += raw;
      if (!unresolved.includes(raw)) unresolved.push(raw);
    } else {
      out += matched.prompt.trim() || matched.name;
      if (!usedCardIds.includes(matched.id)) usedCardIds.push(matched.id);
    }
    cursor = hit.end;
  }
  out += prompt.slice(cursor);
  return { prompt: out, usedCardIds, unresolved };
}