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