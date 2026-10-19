// 上游错误文案脱敏的**纯函式**单一真源（全专案共用）。
//
// 为什么独立成档：本档被 `src/middleware.ts`（Edge runtime）汇入，而 Edge 打包不许
// 出现 `next/server` 之外的 Node 内建或 DB 连线依赖。`src/lib/proxy.ts` 则依赖
// `/lib/new-api-auth-server`（可能拉进 postgres），故脱敏逻辑不能住那里。
// 本档**零 import**，node 路由与 Edge middleware 都能安全引用。
//
// 上游（new-api 等）会把内部实作细节回显进错误文案：SQL／资料库栏位名（例：
// `used_quota`、`Scan error: used_quota`、`ERROR: column "quota" does not exist`），
// 连我们转发时用的内部鉴权头名（`New-Api-User`、`x-user-id`）都会原样吐出。
// 这些字串一离站就是对外泄漏面（红队 2026-10-05 实测）。
//
// 历史破口（同一轮 Hack 实测，本次修正）：
//  ① `sql:` 用裸子串匹配 ⇒ `mysql:3306` / `postgresql://db/host` / `noSQL:ok` 被整段
//     替换，属真实功能损伤（成功负载也被洗）。现改为「前一字符非字母」形态判定。
//  ② canonicalize 只认 ASCII 分隔符与零宽字 ⇒ 全角下划线 U+FF3F、中点 U+00B7、
//     Cyrillic 同形字、`%5F`、`&#95;` 均可穿透。现补 NFKC 折叠、百分号／实体解码、
//     同形字折叠。
//  ③ 裸 SQL（`SELECT * FROM users WHERE quota > 0`）、`ERROR: column`、
//     `missing x-user-id` 无指纹。现补规则。

export const SANITIZED_MESSAGE = "服务暂时不可用，请稍后再试";
/** 内部标识作键名时的占位键（错误负载专用）。 */
export const REDACTED_KEY = "redacted";

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
 * 递归清洗 JSON：字串值命中内部指纹即换成通用文案；`cleanKeys` 为 true（错误负载）
 * 时连内部标识键名也换掉。数字/布林/null 及正常功能键一律保留。
 */
export function sanitizeUpstreamValue(
  value: unknown,
  options: { cleanKeys?: boolean } = {},
): unknown {
  if (typeof value === "string") {
    return containsInternalLeak(value) ? SANITIZED_MESSAGE : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUpstreamValue(item, options));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const safeKey = options.cleanKeys && containsInternalLeak(key) ? REDACTED_KEY : key;
      // 多个内部键折叠成同一个占位键会互相覆盖（2026-10-05 实测：
      // {"New-Api-User":"7","model_ratio":5} → {"redacted":5}，第一个键的值被吞）。
      // 加序号后缀保真；正常键天然不会重复（JSON.parse 已去重），不受影响。
      // 碰撞判定用 Object.hasOwn（自有键），**不用 `in`**——`"__proto__" in {}` 为 true
      // （原型链），旧写法会把 `__proto__` 静默改名 `redacted_2`（H9 反例③）。
      let uniqueKey = safeKey;
      let n = 2;
      while (Object.hasOwn(out, uniqueKey)) uniqueKey = `${REDACTED_KEY}_${n++}`;
      setOwnKey(out, uniqueKey, sanitizeUpstreamValue(val, options));
    }
    return out;
  }
  return value;
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

/**
 * 「原样转发上游响应体」前的脱敏（**错误路径**）：能解析成 JSON 就结构内清洗
 * （错误负载连键名一起洗），解析失败则整段过文案脱敏。成功路径不得套用——成功体
 * 是功能面（图片／正常 JSON），必须逐位透传。
 */
export function sanitizeUpstreamBody(text: string): string {
  if (!text) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(sanitizeUpstreamValue(parsed, { cleanKeys: true }));
  } catch {
    return String(sanitizeUpstreamMessage(text) ?? SANITIZED_MESSAGE);
  }
}

/**
 * 2xx 但 payload 形状是错误时的脱敏：**键名与值一并清洗**。
 * 内部头名／栏位名本身可能就是泄漏面（例：`{"success":false,"New-Api-User":"7"}` 的键名），
 * 故判为错误形状后 `cleanKeys:true`；正常成功体不走此函数（逐位透传）。
 * 用于「HTTP 200 带错误体」的旁路（middleware / pixai-upload / agent-gateway / proxy）。
 */
export function sanitizeErrorShapedPayload(text: string): string {
  const parsed: unknown = JSON.parse(text);
  return JSON.stringify(sanitizeUpstreamValue(parsed, { cleanKeys: true }));
}

/**
 * 成功负载「栏位闸」的键名黑名单：**内部基础设施标识**（new-api 资料库列／上游内部栏位），
 * 且**不在我方公开契约、无我方消费者**。只清键名，不动值。
 *
 * 为什么要有这层（红队 2026-10-05 Hack 实测）：错误形状的负载走键名清洗，但**成功信封**
 * 过去是逐位透传 ⇒ 同一批内部栏位名换到 `success:true` 信封里就原样外泄；而 `proxy.ts`
 * 与 `middleware.ts` 两条入口口径还不一致。本 helper 即两条入口的**共同**栏位闸。
 *
 * 收录判定（逐条给证据，2026-10-05）：
 *  - `vendor_id`／`model_ratio`／`model_price`／`completion_ratio`：new-api 进价成本侧栏位。
 *    ① 不在公开契约（`src/app/api/v1/openapi.json/route.ts` 全档 grep 无、`public/llms.txt`
 *    与 `public/docs` 无）；② 全 repo grep 无任何消费者（仅注释提及）。⇒ 清洗。
 *  - `owner_by`：new-api 内部归属列。同上两条皆无。⇒ 清洗。
 *    注意与 OpenAI 标准的 `owned_by`（`/v1/models` 的功能字段，`owned_by:"image-studio"`）
 *    是**不同**键，本闸按全等键名匹配，绝不误伤 `owned_by`。
 *
 * 明确**不**收录（收集前逐条查证，防止误伤功能面）：
 *  - `channel_id`：我方 agent 闸道 failover 在消费——`deploy-staging/gateway/workflow-gw.ts`
 *    （线上 `/opt/eimu-harness`）的 `resolveActiveModel` 读 `/v1/model-status` 的
 *    `channel_id` 做跨渠道切换（:1133/:1137/:1154）。⇒ 保留。
 *  - `used_quota`：我方前端在消费——`src/components/settings/TeamConsoleClient.tsx`
 *    （`UsagePayload`/`UsageMemberRow`），数据来自 `/api/v1/team/usage`（本闸覆盖路径）。
 *    ⇒ 保留（它是我方团队用量 API 的既有栏位，不是新泄漏）。
 *  - OpenAI 标准键（`owned_by`、`object`、`created`…）：公开契约面，永不收录。
 *
 * 边界（诚实声明，均为**已声明设计边界**、不是漏）：仅覆盖 2xx 且 media type 主型别为
 * JSON（`application/json` 或 `+json` 后缀，大小写不敏感）、体积 ≤512KB 的负载；
 * `text/plain` 等非 JSON 体不缓冲，四条 durable 长时端点（见 middleware 的
 * DURABLE_PASS_THROUGH）按设计不缓冲——这三类仍由生成源／上游语义负责，本闸不覆盖。
 *
 * 键名变体（H9 独立复验反例②）：上游可用零宽／全角／中点／同形字把内部键写成变体绕过
 * 全等比对。故匹配前必须先 `canonicalizeSuccessKey`（NFKC＋去零宽＋分隔符归一＋限定
 * 同形字折叠），再对**正规形**做全等比对。
 */
export const INTERNAL_SUCCESS_PAYLOAD_KEYS: readonly string[] = [
  "vendor_id",
  "model_ratio",
  "model_price",
  "completion_ratio",
  "owner_by",
];

/**
 * 键名正规化（匹配前**必须**先跑）：上游可以把同一个内部键写成多种变体绕过全等比对
 * （H9 独立复验实测：零宽 `vendor\u200b_id`、全角 `model＿ratio`、中点 `model·price`、
 * Cyrillic 同形字 `оwner_by` 在三个入口全部穿透）。步骤：
 *  ① NFKC（全角 `＿`→`_`、全角字母→ASCII）
 *  ② 去零宽／格式控制字符（U+200B..U+200F、U+2060..U+2064、U+FEFF、U+00AD）
 *  ③ 小写
 *  ④ 同形字折叠：**只折叠 deny 集合里出现过的字母**（见下方 DENY_SET_LETTERS 与
 *     KEY_HOMOGLYPHS）——折叠表限定在目标字符集内，正常键的其余字符一律不动，
 *     且最终是**全等**比对而非子串匹配，故 `owned_by` 等正常键绝不误伤。
 *  ⑤ 分隔符归一：空白／`_`／`-`／`.`／`·`／`・`／全角 `＿`／全角 `－`／各类横线一律剔除，
 *     故 `model_price`／`modelprice`／`model price`／`model.price` 折叠到同一形态。
 */
function canonicalizeSuccessKey(key: string): string {
  let s = key;
  try {
    s = s.normalize("NFKC");
  } catch {
    // 环境不支持 NFKC 时退回原形（其余步骤仍生效）。
  }
  s = s.replace(/[\u200b-\u200f\u2060-\u2064\ufeff\u00ad]/g, "").toLowerCase();
  let mapped = "";
  for (const ch of s) mapped += KEY_HOMOGLYPHS[ch] ?? ch;
  return mapped.replace(/[\s_\-.·\u30fb\uFF3F\uFF0D\u2010-\u2015\u2212\u2022]+/g, "");
}

/** deny 集合（INTERNAL_SUCCESS_PAYLOAD_KEYS）里出现过的 ASCII 字母。 */
const DENY_SET_LETTERS = new Set(
  [...INTERNAL_SUCCESS_PAYLOAD_KEYS.join("")].filter((ch) => ch >= "a" && ch <= "z"),
);

/**
 * 键闸专用同形字表：从通用 HOMOGLYPHS 里**只保留目标字母集内的映射**，避免把正常键的
 * 字符也折叠掉（要求：映射表限定在目标键用到的字符）。
 */
const KEY_HOMOGLYPHS: Record<string, string> = {};
for (const [from, to] of Object.entries(HOMOGLYPHS)) {
  if (DENY_SET_LETTERS.has(to)) KEY_HOMOGLYPHS[from] = to;
}
// 通用表未收、但 deny 字母集内确有的 Greek 同形字：ρ→p、ε→e、ι→i、τ→t。
// （通用表用于「值」的子串指纹，扩大它有更广的误伤面；键闸是折叠后**全等**比对，
//  在目标字母集内多折叠几个同形字是安全的。）
KEY_HOMOGLYPHS["\u03c1"] = "p";
KEY_HOMOGLYPHS["\u03b5"] = "e";
KEY_HOMOGLYPHS["\u03b9"] = "i";
KEY_HOMOGLYPHS["\u03c4"] = "t";

/** 目标键的正规形集合（匹配用；对正规形全等比对，不做子串匹配）。 */
const INTERNAL_SUCCESS_KEY_CANONICAL_SET = new Set(
  INTERNAL_SUCCESS_PAYLOAD_KEYS.map(canonicalizeSuccessKey),
);

/**
 * 自有键写入。`out[key] = v` 在 key 为 `__proto__` 时会走 Object.prototype 的 setter
 * （改写原型、**不建自有键**，键被静默丢弃）；`Object.defineProperty` 建的是普通数据属性，
 * 既不丢键也不污染原型（H9 反例③：middleware 丢键 / proxy 改名 `redacted_2`）。
 */
function setOwnKey(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return;
  }
  target[key] = value;
}

/**
 * 递归移除黑名单键名（对象深度不限；数组逐项处理）。只删键、不改值，故不碰任何功能字段。
 * 命中才回 `changed:true`，否则回传原值参照——调用方据此逐位透传原文，避免无谓的
 * 「parse→stringify」改写（键序、浮点格式逐位不动的保证只在未命中时成立）。
 *
 * 键名比对前先 `canonicalizeSuccessKey`（H9 反例②）；自有键写入用 `setOwnKey`，
 * **不依赖 `in`**（`in` 会看原型链），故 `__proto__` 键在三个入口一致保留且无原型污染。
 */
export function stripInternalSuccessKeys(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const result = stripInternalSuccessKeys(item);
      if (result.changed) changed = true;
      return result.value;
    });
    return changed ? { value: out, changed } : { value, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      // 键名大小写不敏感、且容忍零宽／全角／分隔符／同形字变体（canonicalize 后全等比对）；
      // 比对的是全等键名，不做子串匹配。
      if (INTERNAL_SUCCESS_KEY_CANONICAL_SET.has(canonicalizeSuccessKey(key))) {
        changed = true;
        continue;
      }
      const result = stripInternalSuccessKeys(val);
      if (result.changed) changed = true;
      setOwnKey(out, key, result.value);
    }
    return changed ? { value: out, changed } : { value, changed };
  }
  return { value, changed: false };
}

/**
 * 成功负载 JSON 的栏位闸出口：命中黑名单键名回清洗后的 JSON 字串；
 * 无命中或解析失败回 `null`（调用方据此原样透传，绝不改写功能负载）。
 */
export function stripInternalKeysFromJson(text: string): string | null {
  if (!text) return null;
  try {
    const { value, changed } = stripInternalSuccessKeys(JSON.parse(text));
    return changed ? JSON.stringify(value) : null;
  } catch {
    return null;
  }
}

/** 正向「功能数据键」：存在任一即视为功能负载。用于避免把成功体误判成错误体。 */
const FUNCTIONAL_PAYLOAD_KEYS: string[] = [
  "data",
  "result",
  "results",
  "choices",
  "images",
  "videos",
  "output",
  "url",
  "urls",
  "id",
  "task_id",
  "taskId",
  "request_id",
  "mediaId",
  "created",
  "artifacts",
  "object",
];

/** `error` 键的值是否「携带失败内容」（`error:null`／`false`／空容器＝功能占位，不算失败）。 */
function isFailureValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/**
 * payload 是否「错误形状」。判据（保守，宁可漏判也不误伤功能面）：
 *  ① `success === false`（最强信号，布尔假值）；
 *  ② 顶层 `error` 键**携带失败内容**（功能成功体常见 `error:null` 占位，
 *     或 `success:true` 同时带 error 说明，故只认非空失败值）；
 *  ③ success 缺省、无任何正向数据键（见 FUNCTIONAL_PAYLOAD_KEYS）、且存在非空
 *     `message`/`msg` —— 即「裸错误信封」（例 `{"message":"Scan error used_quota"}`）。
 * 含 `data/result/url/id/...` 的负载一律视为功能面，**不洗键名**（红队 2026-10-05：
 * 只洗值不洗键导致 `New-Api-User` 键名原样外泄；此判据即其修正）。
 */
export function isErrorShapedPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (obj.success === false) return true;
  if ("error" in obj && isFailureValue(obj.error)) return true;
  if (typeof obj.success !== "boolean" && !FUNCTIONAL_PAYLOAD_KEYS.some((key) => key in obj)) {
    const text =
      typeof obj.message === "string" ? obj.message : typeof obj.msg === "string" ? obj.msg : null;
    if (text !== null && text.trim().length > 0) return true;
  }
  return false;
}