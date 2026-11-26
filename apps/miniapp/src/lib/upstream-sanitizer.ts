// 逐行照搬 src/lib/upstream-sanitizer.ts:22-168,203-211（只取单条文案脱敏出口；JSON/负载清洗属服务端，不搬）。
export const SANITIZED_MESSAGE = "服务暂时不可用，请稍后再试";

/**
 * 紧实形子串指纹（在去掉分隔符的 canonical 串上比对）。
 * `used_quota_v2` → `usedquotav2` 仍含 `usedquota`，故不需词界。
 *
 * 注意（红队 2026-10-05 功能回归修复）：**不再**把资料库栏位名（used_quota/
 * model_price/model_ratio/vendor_id/owner_by）与通用英文短语（does not exist）
 * 放在这里做裸子串指纹——去分隔符后它们会命中正常英文业务文案，把可行动的错误
 * 整段换成通用文案：
 *   · "Model price changed, please retry"（modelprice）
 *   · "Vendor id is required"（vendorid）
 *   · "Please select a resolution from the options"（select…from）
 *   · "The requested template does not exist"（doesnotexist）
 * 这些内部标识符改由下方 `INTERNAL_IDENTIFIER_RE` 在**保留分隔符**的可读形上
 * 匹配：内部栏位名一律带下划线（`used_quota`）或黏连，正常英文是空格，二者可分。
 * `does not exist` 改由 `COLUMN_NOT_EXIST_RE` 要求前置 `column/relation/table`。
 */
const INTERNAL_LEAK_MARKERS: string[] = [
  "newapiuser", // New-Api-User（我们转发用的内部鉴权头名）
  "xuserid", // x-user-id
  "missingxuserid", // missing x-user-id
  "scanerror", // Scan error
  "sqlstate",
  "pq:", // lib/pq 错误前缀
  "pgx",
  "columnindex",
];

/**
 * 内部「标识符型」栏位名（资料库列／上游字段）：在**可读形**（分隔符保留）上匹配，
 * 只认下划线（或黏连）形态，**空格形态的正常英文不命中**：
 *   `used_quota`／`usedquota` 命中；"used quota"（空格）不命中。
 * 允许 `_` 可选，兼容上游去分隔后的黏连输出；不吞尾部（`used_quota_v2` 亦命中）。
 * `completion_ratio` 2026-10-05 补入：与成功负载栏位闸（INTERNAL_SUCCESS_PAYLOAD_KEYS）
 * 同一份判据，避免错误形状信封成为漏点；正常英文 "completion ratio"（空格）仍不命中。
 */
const INTERNAL_IDENTIFIER_RE = /\b(?:used_?quota|model_?price|model_?ratio|vendor_?id|owner_?by|completion_?ratio)/;
/**
 * SQL `SELECT … FROM`：要求真实 SQL 形状（`select *` 或 `select 标识符[,…]` 后接 from 表名），
 * 避免命中正常英文 "please select a resolution from the options"。
 */
const SELECT_FROM_RE =
  /\bselect\s+(?:\*|[\w"`\[\].]+(?:\s*,\s*[\w"`\[\].]+)*)\s+from\s+[\w"`\[\].]+/;
/** `sql:` 必须前一字符非字母：`mysql:`／`postgresql://`／`noSQL:` 不得命中。 */
const SQL_PREFIX_RE = /(?:^|[^a-z])sql\s*[:：]/;
const MISSING_HEADER_RE = /\bmissing\b[\s\S]{0,40}?(?:x-?user-?id|new-?api-?user|authorization)/;
const SCAN_ERROR_RE = /\bscan\s*error\b/;
const ERROR_COLUMN_RE = /\berror\s*[:：]\s*column\b/;
/** `column/relation/table … does not exist`：要求 SQL 物件名作前件，正常英文 "…does not exist" 不命中。 */
const COLUMN_NOT_EXIST_RE = /\b(?:column|relation|table)\b[\s\S]{0,80}?\bdoes\s+not\s+exist\b/;

/**
 * Cyrillic／Greek 视觉同形字 → ASCII。攻击者用同形字可绕过子串指纹
 * （例：`uѕed_quota` 用 Cyrillic ѕ U+0455）。
 */
const HOMOGLYPHS: Record<string, string> = {
  "\u0430": "a", // а
  "\u0435": "e", // е
  "\u043e": "o", // о
  "\u0440": "p", // р
  "\u0441": "c", // с
  "\u0445": "x", // х
  "\u0443": "y", // у
  "\u0455": "s", // ѕ
  "\u0456": "i", // і
  "\u0458": "j", // ј
  "\u0501": "d", // ԁ
  "\u04bb": "h", // һ
  "\u04cf": "l", // ӏ
  "\u043a": "k", // к
  "\u043c": "m", // м
  "\u0442": "t", // т
  "\u03bf": "o", // ο
  "\u03b1": "a", // α
  "\u03bd": "v", // ν
};

function decodeRepresentations(value: string): string {
  let s = value;
  // 百分号编码（含双重编码）：%5F → _
  for (let i = 0; i < 3; i += 1) {
    if (!/%[0-9a-fA-F]{2}/.test(s)) break;
    try {
      const next = decodeURIComponent(s);
      if (next === s) break;
      s = next;
    } catch {
      break;
    }
  }
  // 数字 HTML 实体：&#95; / &#x5F; → _
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)));
}

function foldHomoglyphs(value: string): string {
  let out = "";
  for (const ch of value) out += HOMOGLYPHS[ch] ?? ch;
  return out;
}

/**
 * 保留分隔符的「可读正规形」：小写 + 同形字折叠 + NFKC + 解码 + 去零宽。
 * 用于需要「看前一字符」的规则（如 `sql:` 前不得为字母）。
 */
function folded(value: string): string {
  let s = decodeRepresentations(value.toLowerCase());
  try {
    s = s.normalize("NFKC");
  } catch {
    // 环境不支持 NFKC 时退回原形（其余步骤仍生效）。
  }
  s = s.replace(/[\u200b-\u200d\u2060\ufeff]/g, "");
  return foldHomoglyphs(s);
}

/**
 * 去分隔符的「紧实正规形」：把下划线／连字符／空白／点／中点等一律剔除。
 * 用于子串指纹（`used_quota_v2` → `usedquotav2` 仍含 `usedquota`）。
 * `:`、`/` 等不分隔语义的字符保留（`sql:`、`pq:` 指纹依赖它们）。
 */
function canonical(value: string): string {
  return folded(value).replace(
    /[\s_\-\u2010-\u2015\u2212\u00b7\u2022\u30fb\uFF3F\uFF0D.]+/g,
    "",
  );
}

export function containsInternalLeak(value: string): boolean {
  if (!value) return false;
  const compact = canonical(value);
  if (INTERNAL_LEAK_MARKERS.some((marker) => compact.includes(marker))) return true;
  const readable = folded(value);
  return (
    INTERNAL_IDENTIFIER_RE.test(readable) ||
    SELECT_FROM_RE.test(readable) ||
    SQL_PREFIX_RE.test(readable) ||
    MISSING_HEADER_RE.test(readable) ||
    SCAN_ERROR_RE.test(readable) ||
    ERROR_COLUMN_RE.test(readable) ||
    COLUMN_NOT_EXIST_RE.test(readable)
  );
}

/**
 * 单条错误文案的脱敏出口：命中内部指纹回通用文案，否则原样返回（正常业务文案不受影响）。
 */
export function sanitizeUpstreamMessage(
  message: string | null | undefined,
): string | null | undefined {
  if (typeof message !== "string") return message;
  return containsInternalLeak(message) ? SANITIZED_MESSAGE : message;
}
