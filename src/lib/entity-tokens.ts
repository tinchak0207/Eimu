// 行內實體引用 token（@[角色:霍辞渊]）：純邏輯層。
//
// 定位：卡（character-cards.ts）是「項目級鎖定配置」——掛上畫布就自動全量注入。
// token 是**逐處引用**：寫在提示詞正文裡，展開時「就地」替換成該卡的 prompt 片段，
// 讓「這一鏡要誰/哪個場景/用哪個道具」變成可精確指名的實體引用，
// 而不是靠整包鎖定把所有卡都塞進前綴。
//
// 語法（凍結契約）：`@[種類:名稱]`
//   - 種類字：正/簡/英文皆收（角色|人物 / 场景|場景|scene / …），見 resolveEntityTokenKind
//   - 名稱：1..100 字，不含 `[` `]`（避免嵌套歧義）
//   - 未命中/未知名稱 → 原樣保留 token 字串（fail-open，不報錯、不吞內容）
//
// 本檔只做純函式：不改 cards、不 mutate 輸入、不做 I/O。

import type { CharacterCard, CharacterCardKind } from "./character-cards";

/** 行內實體引用的 token 語法：`@[角色:霍辞渊]`。 */
export const ENTITY_TOKEN_PATTERN = /@\[([^\[\]:]{1,40}):([^\[\]]{1,100})\]/g;

export interface EntityTokenHit {
  /** token 裡寫的種類字（未正規化，如「场景」）。 */
  kindLabel: string;
  name: string;
  start: number;
  end: number;
}

/**
 * 種類字 → 卡 kind。正/簡/英文皆收；其餘（含空字串、未知詞）→ null。
 * 注意：`scene` 等英文詞只認小寫原文（與 toCharacterCardKind 的 fail-closed 同調）。
 */
export function resolveEntityTokenKind(kindLabel: string): CharacterCardKind | null {
  const clean = kindLabel.trim();
  if (!clean) return null;
  if (clean === "角色" || clean === "人物" || clean === "character") return "character";
  if (clean === "场景" || clean === "場景" || clean === "scene") return "scene";
  if (clean === "风格" || clean === "風格" || clean === "style") return "style";
  if (clean === "道具" || clean === "prop") return "prop";
  if (
    clean === "音频" ||
    clean === "音頻" ||
    clean === "音效" ||
    clean === "配乐" ||
    clean === "配樂" ||
    clean === "audio"
  ) {
    return "audio";
  }
  return null;
}

/** 解析提示詞中的全部 token（按出現序；不做任何解析度/命中判定）。 */
export function parseEntityTokens(prompt: string): EntityTokenHit[] {
  const hits: EntityTokenHit[] = [];
  if (!prompt) return hits;
  // 全域正則帶 lastIndex 狀態：每次呼叫重建（模組級常數共用會串味）。
  const pattern = new RegExp(ENTITY_TOKEN_PATTERN.source, "g");
  for (let match = pattern.exec(prompt); match; match = pattern.exec(prompt)) {
    hits.push({
      kindLabel: match[1],
      name: match[2],
      start: match.index,
      end: match.index + match[0].length,
    });
    if (match[0].length === 0) pattern.lastIndex += 1; // 理論上不可能（長度 ≥ 5），保險防死循環
  }
  return hits;
}

// ─────────────────────────────────────────── 畸形 token 診斷（只診斷、不改寫）

/**
 * 畸形形狀的分類（**只診斷，不改寫**：原文一律照留，只讓呼叫端多一句人話提示）。
 *   - `empty_name`：`@[角色:]` —— 名稱段為空（`ENTITY_TOKEN_PATTERN` 要求名稱 1..100 字，故不算 token）
 *   - `unclosed`：`@[角色:灰羽` —— 名稱段沒有右括號收尾
 *   - `unknown_kind`：`@[未知种类:灰羽]` —— 語法完整但種類字無法辨識（會落在 `expandEntityTokens` 的 unresolved）
 */
export type MalformedEntityTokenReason = "empty_name" | "unclosed" | "unknown_kind";

export interface MalformedEntityToken {
  /** 原文片段（**原樣**，未做任何替換；呼叫端可直接寫進 warning）。 */
  raw: string;
  reason: MalformedEntityTokenReason;
  /** token 裡寫的種類字（`@[角色:]` → "角色"）。 */
  kindLabel: string;
  /** 名稱段（`@[角色:]` → ""）。 */
  name: string;
}

/** `@[種類:]`：名稱段為空。種類字 0..40（`@[:]` 也算畸形：種類字空）。 */
const EMPTY_NAME_TOKEN_PATTERN = /@\[([^\[\]:]{0,40}):\]/g;

/** `@[種類:名稱`：名稱段非空但**沒有**右括號收尾（後一個字元不是 `]` 即判畸形）。 */
const UNCLOSED_TOKEN_PATTERN = /@\[([^\[\]:]{1,40}):([^\[\]]{1,100})/g;

/**
 * 找出「看起來想寫 token 但沒解析成功」的形狀（純函式、零 I/O、**不改寫任何內容**）。
 *
 * 只認三種形狀（刻意不收「缺冒號」如 `@[Verse]`——那更可能是正文而不是打錯的 token，
 * 誤報會製造噪音）：
 *   ①`@[角色:]` 名稱為空；②`@[角色:灰羽` 缺右括號；③`@[未知种类:灰羽]` 種類字無法辨識。
 *
 * 保序（按出現位置）、按原文去重；正常 token（如 `@[角色:灰羽]`）**絕不**回報
 * （陰性對照：正常 token 不得被誤報為畸形）。
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

  // ③ 語法完整但種類字不認：用既有的 parseEntityTokens（**不另寫 token 語法**）。
  for (const hit of parseEntityTokens(prompt)) {
    if (resolveEntityTokenKind(hit.kindLabel)) continue;
    push(hit.start, prompt.slice(hit.start, hit.end), "unknown_kind", hit.kindLabel, hit.name);
  }

  // ① 名稱為空（`ENTITY_TOKEN_PATTERN` 不匹配 ⇒ parseEntityTokens 看不到，必須另掃）。
  const emptyName = new RegExp(EMPTY_NAME_TOKEN_PATTERN.source, "g");
  for (let match = emptyName.exec(prompt); match; match = emptyName.exec(prompt)) {
    push(match.index, match[0], "empty_name", match[1], "");
    if (match[0].length === 0) emptyName.lastIndex += 1;
  }

  // ② 缺右括號：名稱字元集不含 `]`，所以「緊接在匹配之後的字元不是 `]`」＝名稱段沒收尾。
  const unclosed = new RegExp(UNCLOSED_TOKEN_PATTERN.source, "g");
  for (let match = unclosed.exec(prompt); match; match = unclosed.exec(prompt)) {
    if (prompt[match.index + match[0].length] === "]") continue; // 正常 token（含名稱剛好頂到上限）
    push(match.index, match[0], "unclosed", match[1], match[2]);
    if (match[0].length === 0) unclosed.lastIndex += 1;
  }

  // 保序：按出現位置（三種形狀互斥，同位置不可能撞）。
  found.sort((a, b) => a.start - b.start);
  return found.map(({ start: _start, ...entry }) => entry);
}

/** 卡的 token 原文：`@[角色:霍辞渊]`。 */
export function serializeEntityToken(card: Pick<CharacterCard, "kind" | "name">): string {
  return `@[${kindLabelForCardKind(card.kind)}:${card.name.trim()}]`;
}

/** 卡 kind → token 用的種類字（簡體，與卡的 token 輸入端一致）。 */
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
 * 把正文裡的 token 就地展開成對應卡的 prompt 片段。
 *
 * 語義：
 *   - 命中：整段 token（start..end）就地替換（**不搬到開頭**）；片段為空字串 → 替換成卡名。
 *   - 未命中（種類字未知 / 沒有同名同 kind 的卡）：原樣保留 token 字串，並記入 unresolved。
 *   - 同名同 kind 多張卡：取 cards 陣列中**第一張**——刻意 fail-safe（不因為重名而炸或全丟）。
 *   - usedCardIds：按首次出現序去重；unresolved：去重（按首次出現序）。
 *   - 零 token：prompt 逐位元不變，回空陣列。
 *
 * 純函式：不改 cards、不 mutate 輸入。
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
      // 未命中：token 原樣保留（fail-open），並記錄原始字串。
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