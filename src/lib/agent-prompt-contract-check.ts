/**
 * Agent 提示词契约检查器（吞 AID 产品层单向差，刀 3-③，2026-09-15）。
 *
 * 【未接线·仅测试引用（2026-10-06 P0-10）】本档当前**未接**入运行时；全库仅
 * agent-prompt-contracts.test.ts 与 editor-timeline-activation.test.ts 引用，零生产消费者
 * ——「运营当场就能判定」目前不成立。若要启用：接线点在 Expert 回执入口——`src/lib/*-delegate.ts`
 * 的 collect*DeliverableFromToolResult（如 editor-delegate.ts:353、music-delegate.ts:329），
 * 接入后须配一条真路径行为证据。
 *
 * 职责：把 AID §二「通用硬性规则」的第 1／2／4 条（纯 JSON、字符串内引号用
 * 「」、必填栏位不省）做成**机械检查**——运营改完提示词/模型换版后，当场就能
 * 判定输出是否仍合契约，不靠人眼读。
 *
 * 写法范式 = src/lib/expert-contract.ts（纯函数、结构化错误、**绝不 throw**、
 * 繁体注释、violation 逐条带人话 detail）。本档零副作用、无外部依赖。
 *
 * 检查项（rule 名即回报键）：
 *   - `no_markdown_fence`：文本含 ``` 围栏（AID 硬规则 1 的直接触发面）。
 *   - `pure_json`：contract 为 json 模式时，去围栏后首字符必须 `{`/`[`、
 *     尾字符 `}`/`]`，且整段可 JSON.parse（任一不成立即 violation）。
 *   - `chinese_quotes_in_values`：字符串值内出现未转义英文双引号——以扫描器
 *     判定：每个字符串结束引号之后的下一个非空白字符必须是 `,`／`:`／`}`／`]`
 *     或文本结束；不是即代表该值被内嵌引号截断（正是 AID 描述的「破坏 JSON
 *     结构」失败），提示改用「」。
 *   - `required_fields`：contract.fields 中 `required: true` 的栏位名必须出现
 *     在解析后结果的顶层（json 模式且解析成功时才检查）。
 *   - `frozen_constants`：contract.frozenConstants 每一项必须在文本中出现。
 *
 * 口径（钉死，勿改）：未命中一律回 violation、永不抛异常；json 模式解析失败时
 * 只报 `pure_json` 一条（后续解析型检查无对象，不猜）。
 */

import type { AgentPromptContract } from "./agent-prompt-contracts";

/** 契约违规一笔（rule = 检查项名，detail = 人话死因与修法）。 */
export interface ContractViolation {
  rule: string;
  detail: string;
}

/** 去除 markdown 代码围栏（```json ... ``` / ``` ... ```，只剥最外层一对）。 */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = /^```[A-Za-z0-9_-]*\s*\n([\s\S]*?)\n?```$/;
  const m = fence.exec(trimmed);
  return m ? m[1] : trimmed;
}

/** json 模式下的首尾字符判定（去围栏后）。 */
function hasJsonBoundaries(s: string): boolean {
  if (s.length === 0) return false;
  const head = s.charAt(0);
  const tail = s.charAt(s.length - 1);
  return (head === "{" && tail === "}") || (head === "[" && tail === "]");
}

/**
 * 字符串扫描器：找出「值内含未转义英文双引号」的位置。
 *
 * 演算法：逐字符走，遇 `"` 进/出字符串态；在出字符串态（读到结束引号）时，
 * 检查下一个非空白字符是否为结构字符 `,` `:` `}` `]` 或已到文本末尾。不是
 * 结构字符 = 该引号不是合法的字符串终止（原文里值中混入了 `"`）。
 * 同时把 `\` 转义跳过（`\"` 是合法转义，不算违规）。
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
      i += 2; // 跳过转义序列（\" \\ \n ...）
      continue;
    }
    if (ch === '"') {
      // 出字符串态：下一个非空白字符必须是结构字符或文本末尾。
      let j = i + 1;
      while (j < text.length && /\s/.test(text.charAt(j))) j += 1;
      const next = j < text.length ? text.charAt(j) : "";
      const legal = next === "" || next === "," || next === ":" || next === "}" || next === "]";
      if (!legal) {
        const start = Math.max(0, i - 20);
        const snippet = text.slice(start, Math.min(text.length, j + 8));
        bad.push(
          `第 ${i + 1} 字符处的字符串结束位置后面紧跟「${next}」而非 , : } ]：值内混入了未转义英文双引号（片段「…${snippet}…」）。字符串值内引号一律用中文「」，例如 "name": "他说「你好」"。`,
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
 * 契约检查（唯一出口）：文本 + 契约 → 违规清单（空阵列 = 全合契约）。
 * 纯函数零副作用，绝不 throw（对齐 expert-contract.ts 错误铁律）。
 */
export function checkJsonOutput(text: string, contract: AgentPromptContract): ContractViolation[] {
  const violations: ContractViolation[] = [];
  try {
    const raw = typeof text === "string" ? text : "";

    // ── no_markdown_fence（原文全形扫描）
    if (raw.includes("```")) {
      violations.push({
        rule: "no_markdown_fence",
        detail: "文本含 ``` 代码围栏：纯 JSON 输出前后禁止任何 markdown 围栏，整段必须直接以 { 或 [ 开头。",
      });
    }

    const body = stripFences(raw);

    // ── frozen_constants（每项必须逐字出现；json 模式与 structured_text 模式同检查）
    for (const constant of contract.frozenConstants) {
      if (!body.includes(constant)) {
        violations.push({
          rule: "frozen_constants",
          detail: `契约常量「${constant}」未在文本中出现：占位符名／栏位名／协议标记属不可动常量，动了就断链路（AID 硬规则 5：改提示词不改契约）。`,
        });
      }
    }

    const isJsonMode = contract.outputMode === "json";
    if (!isJsonMode) {
      // structured_text（尚无机器契约）：只做常量存在性检查，不冒充 JSON 检查。
      return violations;
    }

    // ── pure_json（去围栏后：首尾字符 + 可解析）
    if (!hasJsonBoundaries(body)) {
      const head = body.charAt(0) || "（空）";
      const tail = body.length > 0 ? body.charAt(body.length - 1) : "（空）";
      violations.push({
        rule: "pure_json",
        detail: `去围栏后首字符为「${head}」、尾字符为「${tail}」：JSON 模式要求首字符 { 或 [、尾字符 } 或 ]，前后禁止任何说明文字。`,
      });
    }

    // 字符串值内未转义引号（原文扫描；解析成功与否都能命中）
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
        detail: `JSON.parse 失败：${(e as Error)?.message ?? String(e)}。整段回覆必须是合法 JSON（禁注释、禁尾逗号、值内引号用「」）。`,
      });
    }

    // 解析失败时后续栏位型检查无对象，如实停在此处（不猜）。
    if (parseFailed) return violations;

    // ── required_fields（必填栏位必须出现在解析后顶层）
    const required = contract.fields.filter((f) => f.required).map((f) => f.name);
    if (required.length > 0) {
      const top =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
      const missing = required.filter((name) => top === undefined || !(name in top));
      if (missing.length > 0) {
        const seen = top === undefined ? "（顶层不是物件）" : Object.keys(top).join("、") || "（无）";
        violations.push({
          rule: "required_fields",
          detail: `必填栏位缺失：${missing.join("、")}。契约必填栏位缺失即判失败（不要的内容写「无」或空数组，不省略栏位）。回覆实际顶层键：${seen}。`,
        });
      }
    }

    return violations;
  } catch (e) {
    // 兜底：检查器自身异常也如实回报（不抛），避免吞错造成假通过。
    return [
      {
        rule: "checker_error",
        detail: `契约检查器异常（如实上报，勿吞）：${(e as Error)?.message ?? String(e)}`,
      },
    ];
  }
}
