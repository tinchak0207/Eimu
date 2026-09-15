/**
 * Agent 提示詞契約檢查器（吞 AID 產品層單向差，刀 3-③，2026-09-15）。
 *
 * 職責：把 AID §二「通用硬性規則」的第 1／2／4 條（純 JSON、字符串內引號用
 * 「」、必填欄位不省）做成**機械檢查**——運營改完提示詞/模型換版後，當場就能
 * 判定輸出是否仍合契約，不靠人眼讀。
 *
 * 寫法範式 = src/lib/expert-contract.ts（純函數、結構化錯誤、**絕不 throw**、
 * 繁體注釋、violation 逐條帶人話 detail）。本檔零副作用、無外部依賴。
 *
 * 檢查項（rule 名即回報鍵）：
 *   - `no_markdown_fence`：文本含 ``` 圍欄（AID 硬規則 1 的直接觸發面）。
 *   - `pure_json`：contract 為 json 模式時，去圍欄後首字符必須 `{`/`[`、
 *     尾字符 `}`/`]`，且整段可 JSON.parse（任一不成立即 violation）。
 *   - `chinese_quotes_in_values`：字符串值內出現未轉義英文雙引號——以掃描器
 *     判定：每個字符串結束引號之後的下一個非空白字符必須是 `,`／`:`／`}`／`]`
 *     或文本結束；不是即代表該值被內嵌引號截斷（正是 AID 描述的「破壞 JSON
 *     結構」失敗），提示改用「」。
 *   - `required_fields`：contract.fields 中 `required: true` 的欄位名必須出現
 *     在解析後結果的頂層（json 模式且解析成功時才檢查）。
 *   - `frozen_constants`：contract.frozenConstants 每一項必須在文本中出現。
 *
 * 口徑（釘死，勿改）：未命中一律回 violation、永不拋異常；json 模式解析失敗時
 * 只報 `pure_json` 一條（後續解析型檢查無對象，不猜）。
 */

import type { AgentPromptContract } from "./agent-prompt-contracts";

/** 契約違規一筆（rule = 檢查項名，detail = 人話死因與修法）。 */
export interface ContractViolation {
  rule: string;
  detail: string;
}

/** 去除 markdown 代碼圍欄（```json ... ``` / ``` ... ```，只剝最外層一對）。 */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = /^```[A-Za-z0-9_-]*\s*\n([\s\S]*?)\n?```$/;
  const m = fence.exec(trimmed);
  return m ? m[1] : trimmed;
}

/** json 模式下的首尾字符判定（去圍欄後）。 */
function hasJsonBoundaries(s: string): boolean {
  if (s.length === 0) return false;
  const head = s.charAt(0);
  const tail = s.charAt(s.length - 1);
  return (head === "{" && tail === "}") || (head === "[" && tail === "]");
}

/**
 * 字符串掃描器：找出「值內含未轉義英文雙引號」的位置。
 *
 * 演算法：逐字符走，遇 `"` 進/出字符串態；在出字符串態（讀到結束引號）時，
 * 檢查下一個非空白字符是否為結構字符 `,` `:` `}` `]` 或已到文本末尾。不是
 * 結構字符 = 該引號不是合法的字符串終止（原文裡值中混入了 `"`）。
 * 同時把 `\` 轉義跳過（`\"` 是合法轉義，不算違規）。
 */
function findUnescapedQuotesInValues(text: string): string[] {
  const bad: string[] = [];
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (!inString) {
      if (ch === '"') inString = true;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      i += 2; // 跳過轉義序列（\" \\ \n ...）
      continue;
    }
    if (ch === '"') {
      // 出字符串態：下一個非空白字符必須是結構字符或文本末尾。
      let j = i + 1;
      while (j < text.length && /\s/.test(text.charAt(j))) j += 1;
      const next = j < text.length ? text.charAt(j) : "";
      const legal = next === "" || next === "," || next === ":" || next === "}" || next === "]";
      if (!legal) {
        const start = Math.max(0, i - 20);
        const snippet = text.slice(start, Math.min(text.length, j + 8));
        bad.push(
          `第 ${i + 1} 字符处的字符串结束位置后面紧跟「${next}」而非 , : } ]：值内混入了未轉義英文雙引號（片段「…${snippet}…」）。字符串值內引號一律用中文「」，例如 "name": "他说「你好」"。`,
        );
      }
      inString = false;
      i += 1;
      continue;
    }
    i += 1;
  }
  return bad;
}

/**
 * 契約檢查（唯一出口）：文本 + 契約 → 違規清單（空陣列 = 全合契約）。
 * 純函數零副作用，絕不 throw（對齊 expert-contract.ts 錯誤鐵律）。
 */
export function checkJsonOutput(text: string, contract: AgentPromptContract): ContractViolation[] {
  const violations: ContractViolation[] = [];
  try {
    const raw = typeof text === "string" ? text : "";

    // ── no_markdown_fence（原文全形掃描）
    if (raw.includes("```")) {
      violations.push({
        rule: "no_markdown_fence",
        detail: "文本含 ``` 代碼圍欄：純 JSON 輸出前後禁止任何 markdown 圍欄，整段必須直接以 { 或 [ 開頭。",
      });
    }

    const body = stripFences(raw);

    // ── frozen_constants（每項必須逐字出現；json 模式與 structured_text 模式同檢查）
    for (const constant of contract.frozenConstants) {
      if (!body.includes(constant)) {
        violations.push({
          rule: "frozen_constants",
          detail: `契約常量「${constant}」未在文本中出現：占位符名／欄位名／協議標記屬不可動常量，動了就斷鏈路（AID 硬規則 5：改提示詞不改契約）。`,
        });
      }
    }

    const isJsonMode = contract.outputMode === "json";
    if (!isJsonMode) {
      // structured_text（尚無機器契約）：只做常量存在性檢查，不冒充 JSON 檢查。
      return violations;
    }

    // ── pure_json（去圍欄後：首尾字符 + 可解析）
    if (!hasJsonBoundaries(body)) {
      const head = body.charAt(0) || "（空）";
      const tail = body.length > 0 ? body.charAt(body.length - 1) : "（空）";
      violations.push({
        rule: "pure_json",
        detail: `去圍欄後首字符為「${head}」、尾字符為「${tail}」：JSON 模式要求首字符 { 或 [、尾字符 } 或 ]，前後禁止任何說明文字。`,
      });
    }

    // 字符串值內未轉義引號（原文掃描；解析成功與否都能命中）
    const quoteIssues = findUnescapedQuotesInValues(body);
    for (const detail of quoteIssues) {
      violations.push({ rule: "chinese_quotes_in_values", detail });
    }

    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      parseFailed = true;
      violations.push({
        rule: "pure_json",
        detail: `JSON.parse 失敗：${(e as Error)?.message ?? String(e)}。整段回覆必須是合法 JSON（禁註釋、禁尾逗號、值內引號用「」）。`,
      });
    }

    // 解析失敗時後續欄位型檢查無對象，如實停在此處（不猜）。
    if (parseFailed) return violations;

    // ── required_fields（必填欄位必須出現在解析後頂層）
    const required = contract.fields.filter((f) => f.required).map((f) => f.name);
    if (required.length > 0) {
      const top =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
      const missing = required.filter((name) => top === undefined || !(name in top));
      if (missing.length > 0) {
        const seen = top === undefined ? "（頂層不是物件）" : Object.keys(top).join("、") || "（無）";
        violations.push({
          rule: "required_fields",
          detail: `必填欄位缺失：${missing.join("、")}。契約必填欄位缺失即判失敗（不要的內容寫「无」或空數組，不省略欄位）。回覆實際頂層鍵：${seen}。`,
        });
      }
    }

    return violations;
  } catch (e) {
    // 兜底：檢查器自身異常也如實回報（不拋），避免吞錯造成假通過。
    return [
      {
        rule: "checker_error",
        detail: `契約檢查器異常（如實上報，勿吞）：${(e as Error)?.message ?? String(e)}`,
      },
    ];
  }
}
