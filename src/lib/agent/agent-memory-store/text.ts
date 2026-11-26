import { MEMORY_RECONCILE_SUPERSEDE_JACCARD } from "./constants";

// ─────────────────────────── 矛盾／替换启发式（纯确定性，不调 LLM）

/** 否定词：任一出现即视为该侧带否定语义（宁可漏判不误判）。 */
const MEMORY_NEGATION_WORDS = [
  "不",
  "没",
  "别",
  "勿",
  "无",
  "非",
  "never",
  "not",
  "don't",
  "doesn't",
  "dislike",
  "hate",
  "avoid",
  "stop",
];
/** 替换词：出现即表示新事实替代旧事实。 */
const MEMORY_REPLACEMENT_WORDS = [
  "改成",
  "改为",
  "换成",
  "不再",
  "改用",
  "instead",
  "from now on",
  "更新为",
  "替换",
];
const MEMORY_RATIO_PATTERN = /比例|宽高比|\d{1,4}[:：]\d{1,4}/;
const MEMORY_RATIO_VALUE_PATTERN = /(\d{1,4})\s*[:：]\s*(\d{1,4})/;

function hasAnyWord(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word));
}

function stripWords(text: string, words: string[]): string {
  let out = text.toLowerCase();
  for (const word of words) out = out.split(word).join(" ");
  return out;
}

function ratioValue(text: string): string | null {
  const match = text.match(MEMORY_RATIO_VALUE_PATTERN);
  return match ? `${match[1]}:${match[2]}` : null;
}

/**
 * 事实矛盾判定：否定极性相异、带替换词、或宽高比数值不同且其余内容相近。
 * 只在 token Jaccard ≥ 0.35 时才算——阈值刻意保守，避免把措辞差异误判成矛盾。
 */
function looksContradictory(a: string, b: string): boolean {
  const negA = hasAnyWord(a, MEMORY_NEGATION_WORDS);
  const negB = hasAnyWord(b, MEMORY_NEGATION_WORDS);
  if (
    negA !== negB &&
    memoryJaccard(
      stripWords(a, MEMORY_NEGATION_WORDS),
      stripWords(b, MEMORY_NEGATION_WORDS),
    ) >= MEMORY_RECONCILE_SUPERSEDE_JACCARD
  ) {
    return true;
  }
  if (
    (hasAnyWord(a, MEMORY_REPLACEMENT_WORDS) || hasAnyWord(b, MEMORY_REPLACEMENT_WORDS)) &&
    memoryJaccard(a, b) >= MEMORY_RECONCILE_SUPERSEDE_JACCARD
  ) {
    return true;
  }
  if (MEMORY_RATIO_PATTERN.test(a) && MEMORY_RATIO_PATTERN.test(b)) {
    const ratioA = ratioValue(a);
    const ratioB = ratioValue(b);
    if (
      ratioA !== null &&
      ratioB !== null &&
      ratioA !== ratioB &&
      memoryJaccard(
        a.replace(MEMORY_RATIO_VALUE_PATTERN, " "),
        b.replace(MEMORY_RATIO_VALUE_PATTERN, " "),
      ) >= MEMORY_RECONCILE_SUPERSEDE_JACCARD
    ) {
      return true;
    }
  }
  return false;
}

/** 新正文带替换词且两正文相近 → 新事实取代旧事实。 */
function looksReplacement(a: string, b: string): boolean {
  return (
    hasAnyWord(b, MEMORY_REPLACEMENT_WORDS) &&
    memoryJaccard(a, b) >= MEMORY_RECONCILE_SUPERSEDE_JACCARD
  );
}
// ─────────────────────────── 文本切分与 Jaccard（契约 §7，零依赖）

/** token 化：ASCII 词按空白+标点切；CJK 按 bigram。 */
export function memoryTokens(text: string): string[] {
  const source = String(text ?? "");
  const tokens: string[] = [];
  tokens.push(...(source.toLowerCase().match(/[a-z0-9]+/g) ?? []));
  const runs =
    source.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g) ?? [];
  for (const run of runs) {
    const chars = Array.from(run);
    if (chars.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(`${chars[i]}${chars[i + 1]}`);
  }
  return tokens;
}

/** token Jaccard 相似度；任一侧无 token 时回 0（不视为重复）。 */
export function memoryJaccard(a: string, b: string): number {
  const setA = new Set(memoryTokens(a));
  const setB = new Set(memoryTokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

export { looksContradictory, looksReplacement };
