import type { ReviewClass } from "./delivery-gate-types.ts"

// ─────────────────────────────────────────────────────────────────────────
// F10（2026-10-04）：内审/复核正文从用户可见文字剥离 v2（结构判定 + 分层降级）
//
// 病灶（eval-music-r2/EVAL-R4-retest.md 判据 1/2/3）：F6 的清洗对生产真实文本逐字节 no-op。
// F6 假设泄漏形态是裸露的 `verdict：`／`qc：` 行，但真实 critic 输出是 markdown：
// `**verdict**：pass`、`- **qc**: …`、`1. **【lyrics 栏·数值自证错误】** …`、行内 code span。
// F6 的栏名正则要求「栏名 + 紧邻冒号」（`**` 夹在中间即不命中），且只在命中标签行时删行——
// 审稿编号正文没有对应标签行可删 → 整段留下。R4 取反证：部署版纯函数对 5 条真实 critic
// 摘要 IN len == OUT len。
//
// v2 改用**结构判定**：先问「这段载荷是不是内审/复核产物」，判据对 markdown 变体免疫
// （强调/code span/标题/列表符号/引用标记一律归一，全角半角冒号等价）。判定为内审产物即
// **整段降级**为一句产品语言（只保留成品 URL 与落差），不做逐行手术；编号审稿正文一律不留。
//
// 三出口共用同一纯函数 `scrubSubagentPayload`：① subagent.done.summary（源头 subagent.ts
// finishRun ＋ 咽喉点 sse-core.emitToSession）② subagent.delta.text（sse-core）
// ③ role:"system" 唤醒载体（源头 index.ts wakeSessionForSubagent）。判定逻辑只此一份。
//
// F11（2026-10-04）追加：F10 只按**帧名**治 subagent.*，模型自己的正文（message.delta /
// turn.status）不过 scrubbing → R5 判据 1 里内审语汇改由模型自述上桌。本档把作用面从
// 「网关搬运的帧」扩到「模型自写的正文」：**按内容判定**（同一批判定正则），但只对**用户
// 可见文字帧**生效；正文走逐句定向改写（scrubVisibleProse），不整段掏空。
//
// 不过清洗（R4/R5 判据，F13 重定 oracle）：**用户写的**内容（prompt/歌词/附件）、**成品 URL 与
// 文件名**（含 `video-evidence-*.wav` 的 `evidence` 子串）、**结构化字段键名与值**（`audio_url` 等）、
// 代码区块与 URL 查询串一律逐字不变。**agent 自己写的**契约栏名行/栏名标签（`**qc**:`、`verdict：`、
// `issues：`、`evidence：`、`qcSignature：`、`score_abc = …`、`emotion_contract: …`，含 markdown 包裹、
// 全角/半角冒号、`- `/`1. ` 前缀、`##` 标题形态）一律剥离，无论载荷是 review 还是 scaffold。
// F11 曾以 agent 自写的 U2 报告全文不变为 oracle —— 错的 oracle（U2 本身违反「内审不上桌」）。
// ─────────────────────────────────────────────────────────────────────────

/** 本机/回环地址的内部端点 URL——永远不是给用户的产品链接，直接删。 */
const INTERNAL_ENDPOINT_URL_RE =
  /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s，。；、）)】"'`]*/gi

/** F11：**裸**回环端点（不带 scheme，如 `127.0.0.1:8788`）——R5-A3 D5 漏网形态。 */
const BARE_LOOPBACK_RE = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?|localhost:\d+/gi

/** F11：内部路径 / 源码路径行号 / runId / token 计数——用户可见文字里出现即泄漏。 */
const INTERNAL_PATH_RE = /outputs\/subagent\/[^\s`"'）)】]*|\.opencode\/[^\s`"'）)】]*/gi
const SOURCE_REF_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|md):\d+(?::\d+)?/gi
const RUN_ID_RE = /\brunId\b[\s:：=]*[0-9a-zA-Z_-]*/gi
const TOKEN_COUNT_RE = /\btokens?\b[\s:：=]*\d{2,}|(?:工具调用|tool\s*calls?)[\s:：=]*\d+/gi

/** F11：整行/整帧恰为一个内部栏名或内部身份词的裸形态（如 subagent.delta 的裸 `evidence` 帧）。
 *  仅当**整行去空白后恰为该词**时命中——复合 token（`video-evidence-*.wav`）不误伤（R5 要求）。 */
const BARE_INTERNAL_TOKEN_RE =
  /^(?:evidence|qc|qc[\s\-_.]*signature|score[\s\-_.]*abc|verdict|issues?|needs?[_\s]?fix|emotion[\s\-_.]*contract|melody[\s\-_.]*notation|duration[\s\-_.]*source|prompt[\s\-_.]*used|critic|runId|subagent|审核官|独立审核|機器審核|機器审核|机器审核|复核官)[\s.。:：,，]*$/i

/** F11：正常交付里出现的契约栏名/内部身份词——用于「纯栏位行」判定。
 *  分隔变体（`_ - . 空格`）一并纳入：`score_abc` / `score-abc` / `score abc` 等价命中。 */
const CONTRACT_FIELD_ALT =
  "qc[\\s\\-_.]*signature|score[\\s\\-_.]*abc|emotion[\\s\\-_.]*contract|melody[\\s\\-_.]*notation|duration[\\s\\-_.]*source|prompt[\\s\\-_.]*used|qc"

/** 交付契约栏位区块标题 / 纯栏位标题行（`## qc` / `**qcSignature**`）——整行恰为栏名。 */
const FIELD_HEADING_LINE_RE = new RegExp(
  `^[ \\t]*(?:#{1,6}[ \\t]+)?(?:\\*\\*|__)?[ \\t]*(?:${CONTRACT_FIELD_ALT})[ \\t]*(?:\\*\\*|__)?[ \\t]*$`,
  "i",
)

/** 栏位标签行起始（行首可选列表符 + 栏名 + 冒号/等号）：`- **qc**: …` / `score_abc = null`。 */
const FIELD_LABEL_LINE_RE = new RegExp(
  `^[ \\t]*(?:[-*+]\\s+)?(?:\\*\\*|__)?[ \\t]*(?:${CONTRACT_FIELD_ALT}|verdict|issues|evidence|runId)[ \\t]*(?:\\*\\*|__)?[ \\t]*[:：=]`,
  "i",
)

/** 纯内部栏位行（**仅模型正文逐句改写路径用**）：是栏位标签行，且分隔符后没有中文说明。
 *  F13 口径：契约栏位标签行的剥离不再看冒号后有没有中文（旧「带中文说明＝正常业务」假设
 *  以 agent 自写的 U2 报告当 oracle，是错的 oracle）；scaffold 交付路径改由
 *  `SCAFFOLD_FIELD_LABEL_LINE_RE` 整行剥离，本函式只保留给 `scrubVisibleProse` 的正文改写。 */
function isPureInternalFieldLine(line: string): boolean {
  const m = FIELD_LABEL_LINE_RE.exec(line)
  if (!m) return false
  return !/[\u4e00-\u9fff]/.test(line.slice(m[0].length))
}

/** F13（2026-10-04）：交付契约栏位**区块标题行**（`## 交付契约栏位`）——内审后厨稿面，整行删除。 */
const CONTRACT_BLOCK_HEADING_LINE_RE =
  /^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*|__)?[ \t]*交付契约栏位[ \t]*(?:\*\*|__)?[ \t]*$/

/** F13：契约栏位**标签行**（含 `lyrics`／`audio_url` 等交付契约栏；F10 口径恢复，F11 曾按原文
 *  保留整块）——无论冒号后有无中文说明，整行剥离。带产品 URL 的标签行例外保留：成品链接逐字不变。
 *  覆盖 markdown 包裹、全角/半角冒号与等号、`- `/`1. ` 列表前缀。 */
const SCAFFOLD_FIELD_LABEL_LINE_RE = new RegExp(
  `^[ \\t]*(?:[-*+]\\s+|\\d+[.、]\\s+)?(?:\\*\\*|__)?[ \\t]*(?:${CONTRACT_FIELD_ALT}|verdict|issues?|evidence|lyrics|audio_url)[ \\t]*(?:\\*\\*|__)?[ \\t]*[:：=]`,
  "i",
)

/** F13：内部契约栏名 token（scaffold 载荷里出现即剥离），只在非 URL 段生效（调用端
 *  `scrubOutsideUrls`）。两个安全护栏：
 *  ① 负向环视排除复合 token：成品档名 `video-evidence-*.wav`、工具名 `video_evidence` 及一切
 *     `- _ .` 连接的标识符不误伤（R4/R5 明列的合法误报）；`audio_url`／`lyrics` 等产品字段不在列。
 *  ② `verdict`／`issues`／`evidence` 是英文常用词，**只认标签形态**（`` `evidence` ``／`**evidence**`
 *     这类 markdown 包裹，或 `evidence：`／`evidence =` 带分隔符）；裸词（英文正文 the evidence）
 *     不剥离，避免误伤业务正文。`qc*`／`score_abc`／`emotion_contract` 等不会出现在英文正文，裸词即剥。 */
const SCAFFOLD_FIELD_TOKEN_STRIP_RE = new RegExp(
  "(?<![\\w\\-.])" +
    "(?:" +
    "[`*]{0,2}(?:qc[\\s\\-_.]*signature|score[\\s\\-_.]*abc|prompt[\\s\\-_.]*used|emotion[\\s\\-_.]*contract|melody[\\s\\-_.]*notation|duration[\\s\\-_.]*source|qc)[`*]{0,2}" +
    "|[`*]{1,2}(?:verdict|issues?|evidence)[`*]{1,2}[:：=]?" +
    "|(?:verdict|issues?|evidence)[ \\t]*[:：=]" +
    ")" +
    "(?![\\w\\-.])",
  "gi",
)

/** URL 段切分（URL 段原样保留——产品链接与其查询串不得被当内部赋值误删）。 */
const VISIBLE_URL_SEGMENT_RE = /(https?:\/\/[^\s)）\]」>`"']+)/

/** 只在**非 URL 段**做替换（URL 段原样返回，产品链接/文件名零误伤）。 */
function scrubOutsideUrls(s: string, fn: (chunk: string) => string): string {
  return s
    .split(VISIBLE_URL_SEGMENT_RE)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("")
}

/**
 * 归一化视图（仅用于结构判定）：去 markdown 装饰（`**`/`__`/`*`/`_`/`` ` ``/`#`/`>`/列表符号）、
 * 全角冒号与等号归一为半角、空白压缩。目的是让 `**verdict**：pass`／`` `verdict` ``／
 * `### verdict`／`> verdict`／`1. verdict：` 全部归一为同一可判形态。
 */
function normalizeForReviewDetection(s: string): string {
  return s
    .replace(/\uFF1A/g, ":")
    .replace(/\uFF1D/g, "=")
    .replace(/[`*_~>#|]+/g, " ")
    .replace(/[\s\u3000]+/g, " ")
}

/** 判定视图：先摘掉 URL 段与本机端点（产品链接、成品文件名不得触发判定）。 */
function reviewDetectionView(s: string): string {
  return normalizeForReviewDetection(
    s
      .replace(/\r\n?/g, "\n")
      .replace(INTERNAL_ENDPOINT_URL_RE, " ")
      .replace(VISIBLE_URL_SEGMENT_RE, " "),
  )
}

// ── 判定规则（三族，命中任一即内审产物）─────────────────────────────────────
// 族 1：契约**判决**栏名（verdict/qcSignature 任意 markdown 包裹下命中；issues 须栏位语法）。
// F11：`score_abc` 等**数据**栏名不再单独判 review（否则用户 prompt 里用户自己写的
// `melody_notation / score_abc` 会被整段误降级）——它们走 scaffold 的「纯栏位行」删除。
const REVIEW_FIELD_RE = /\b(?:verdict|qc[\s\-_.]*signature)\b|\bissues?\s*[:：=|]/i
// 族 2：内部审核身份（含繁体变体）。
const CRITIC_IDENTITY_RE =
  /独立审核|獨立審核|审核官|審核官|机器审核|機器審核|复核官|覆核官|\bcritic\b/i
// 族 2'：内审正文结构特征（编号审稿条目 / 逐条引用 / 存在性判词）。
// 注意：`结论如下`／`結論如下` 是普通中文短语（正常交付也会用），不能作为内审判据；
// 真内审仍由 verdict/issues 栏位与审核身份判族拦截。
const CRITIC_STRUCTURE_RE =
  /被审原文|被審原文|栏位存在性|欄位存在性|审核已完成|審核已完成/
const NUMBERED_REVIEW_RE = /(?:^|\s)\d+[.、]\s*【/
// 判词（退回类）——只用于降级句式的方向选择，不单独作判定族。
const REJECT_WORD_RE = /退回|驳回|駁回|不通过|不通過/
const GAP_WORD_RE = /有落差|需修正/

// 族 4（弱信号）：契约数据栏脚手架（非判决类）——正常交付里也会出现，只删脚手架、留正文。
// 刻意**不含** `evidence` 裸词：成品档名 `video-evidence-*.wav` 与工具名 `video_evidence`
// 是 R4 明列的合法误报，裸词命中会造成成品文件名误删。
const SCAFFOLD_FIELD_TOKEN_RE =
  /\b(?:qc[\s\-_.]*signature|score[\s\-_.]*abc|prompt[\s\-_.]*used|emotion[\s\-_.]*contract|melody[\s\-_.]*notation|duration[\s\-_.]*source|qc)\b/i


/**
 * 纯函数：判定一段载荷是否内审/复核产物。
 *  `review`   = 内审/复核产物（判决栏名 / 审核身份 / 审稿结构 / 编号审稿）→ 整段降级；
 *  `scaffold` = 正常交付里夹带的契约栏脚手架 → 只删脚手架行，正文逐字保留；
 *  `clean`    = 正常业务正文 → 原样返回。
 */
export function classifyInternalReviewPayload(s: string): ReviewClass {
  const v = reviewDetectionView(s)
  // 栏位语法视图：保留表格管道、把引号归一为空格。`reviewDetectionView` 会把 `|` 抹成空格，
  // 若只判 v，`| issues |`／`"issues":` 的栏位边界会消失——本视图只补这两个形态，不参与其他判族。
  const fieldView = s
    .replace(/\r\n?/g, "\n")
    .replace(INTERNAL_ENDPOINT_URL_RE, " ")
    .replace(VISIBLE_URL_SEGMENT_RE, " ")
    .replace(/\uFF1A/g, ":")
    .replace(/[`*_~>#]+/g, " ")
    .replace(/["']/g, " ")
    .replace(/\s+/g, " ")
  if (
    REVIEW_FIELD_RE.test(v) ||
    REVIEW_FIELD_RE.test(fieldView) ||
    CRITIC_IDENTITY_RE.test(v) ||
    CRITIC_STRUCTURE_RE.test(v) ||
    NUMBERED_REVIEW_RE.test(v)
  ) {
    return "review"
  }
  if (SCAFFOLD_FIELD_TOKEN_RE.test(v)) return "scaffold"
  return "clean"
}

/** 从载荷中抽取**产品** URL（回环/本机端点不算），去重保序。 */
const PRODUCT_URL_RE = /https?:\/\/[^\s)）\]」>`"'，。；、]+/gi
function extractProductUrls(s: string): string[] {
  const out: string[] = []
  for (const m of s.matchAll(PRODUCT_URL_RE)) {
    const u = m[0]
    if (/^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?/i.test(u)) continue
    if (!out.includes(u)) out.push(u)
  }
  return out
}

/** 降级句式的方向：判词/落差 → 落差句；明确 pass → 通过句。 */
function productLanguageForReview(s: string): string {
  const v = reviewDetectionView(s)
  const passed =
    /(?:判定「通过」|判定「通過」|已复核通过|已覆核通過|无落差|無落差)/.test(v) ||
    /verdict\s*:?\s*(?:pass|approved?|通过|通過)/i.test(v)
  return passed && !REJECT_WORD_RE.test(v) && !GAP_WORD_RE.test(v)
    ? "（这一路已复核通过。）"
    : "（这一路经复核有落差，需修正。）"
}

/** 内审产物 → 整段降级为一句产品语言（+ 该载荷中的成品 URL，逐字）。 */
function degradeInternalReviewPayload(s: string): string {
  const urls = extractProductUrls(s)
  return [productLanguageForReview(s), ...urls].join("\n")
}

/** 正常交付（scaffold）：剥离 agent 自写的**契约栏位区块**——区块标题行、契约栏位标签行
 *  （含带中文说明的标签行，含 `lyrics`／`audio_url` 等交付契约栏）与栏内裸栏名 token。
 *
 *  F13 口径（2026-10-04）：F11 为让 U2 报告「逐字不变」把整块按原文保留——但 U2 是 agent
 *  自写的交付，其「交付契约栏位」区块本身就在违反「内审不上桌」（用户可见文字禁出现
 *  `qc`／`verdict`／`issues`／`evidence` 栏名）。**拿 agent 自写的报告当「不过清洗」oracle
 *  是错的 oracle**。故恢复 F10 的剥离口径，并补上 F10 刻意放行的表格头 `evidence` 标签 token。
 *
 *  本档「不过清洗」判据改为：**用户写的内容**（prompt/歌词/附件）、**成品 URL 与文件名**
 *  （含 `video-evidence-*.wav` 的 `evidence` 子串）、**结构化字段键名与值**（`audio_url` 等）、
 *  代码区块与 URL 查询串一律逐字不变；正文与成品 URL 逐字保留。无任何剥离时**原样返回**。
 */
function stripScaffoldFromDeliverable(s: string): string {
  let changed = false
  const kept: string[] = []
  for (const line of s.split("\n")) {
    if (
      CONTRACT_BLOCK_HEADING_LINE_RE.test(line) ||
      (SCAFFOLD_FIELD_LABEL_LINE_RE.test(line) && !/https?:\/\//i.test(line)) ||
      BARE_INTERNAL_TOKEN_RE.test(line.trim())
    ) {
      changed = true
      continue
    }
    kept.push(line)
  }
  const base = kept.join("\n")
  // 行内裸栏名 token（如表格头「探针 `evidence`」）：只在**非 URL 段**剥离，复合词不误伤。
  const stripped = scrubOutsideUrls(base, (chunk) => chunk.replace(SCAFFOLD_FIELD_TOKEN_STRIP_RE, ""))
  if (stripped !== base) changed = true
  if (!changed) return s
  return stripped
}

// ─────────────────────────────────────────────────────────────────────────
// F11（2026-10-04）：模型自述正文的内审语汇剥离（按内容判定，仅用户可见文字帧）
//
// 病灶（eval-music-r2/EVAL-R5-retest.md 判据 1）：F10 按**帧名**只治 subagent.done /
// subagent.delta；模型自己的正文（message.delta / turn.status）结构性地不过 scrubbing
// → V1 msg[13]「按流程派独立审核官逐栏核验」、msg[14]「拿到 verdict 后」直接上桌。
//
// 与 F10 同源：本段复用同一批判定正则与 URL 保护，只换**改写粒度**——
// 内审产物走整段降级（scrubSubagentPayload）；模型正文走**逐句定向改写**（本段），
// 命中句改写为产品语言、未命中句逐字不动，绝不整段掏空。
// ─────────────────────────────────────────────────────────────────────────

/** 模型正文的定向改写规则（顺序敏感：具体短语先于裸词；先英文判词后中文身份）。
 *  只替换命中片段本身，前后文逐字保留——输出必须是通顺简体，不是残句。 */
const PROSE_REWRITE_RULES: Array<[RegExp, string]> = [
  // 派 X 逐栏核验 → 我已逐栏核对过（覆盖 R5 msg[13] 原句）。
  [
    /按[^。；\n]{0,8}?派\s*(?:一位|一名|一个)?\s*(?:独立审核官|独立审核|审核官|复核官|机器审核|审核|critic)\s*(?:来|去)?\s*(?:逐栏)?\s*(?:核验|复核|审核|检查|审查)/gi,
    "我已逐栏核对过",
  ],
  [/\b(?:dispatch|派遣)\s*(?:an?\s+)?(?:independent\s+)?(?:critic|reviewer)\b/gi, "逐栏核对"],
  [/据其裁决/g, "据此"],
  // 判词族（先整短语后裸词）。
  [/拿到\s*verdict\s*后/gi, "核对结果出来后"],
  [/\bverdict\b/gi, "核对结果"],
  [/\s*\bneeds?[_\s]?fix\b\s*/gi, "需修正，"],
  [/\s*\baccepted\b\s*/gi, "通过，"],
  [/\bissues?\b/gi, "问题"],
  [/\bcritic\b/gi, "复核"],
  // 内部身份裸词。
  [/独立审核官|独立审核|审核官|复核官|机器审核/g, "核对"],
  // 契约栏名裸形 → 产品语言（`_ - . 空格` 分隔变体一并命中）。
  [/\bqc[\s\-_.]*signature\b/gi, "质检签名"],
  [/\bscore[\s\-_.]*abc\b/gi, "乐谱数据"],
  [/\bemotion[\s\-_.]*contract\b/gi, "情感契约"],
  [/\bmelody[\s\-_.]*notation\b/gi, "乐谱记谱"],
  [/\bduration[\s\-_.]*source\b/gi, "时长来源"],
  [/\bprompt[\s\-_.]*used\b/gi, "提示词"],
  [/\bqc\b/gi, "质检"],
]

/** 单块（非代码栅栏）正文的定向清洗：删纯内部栏位行/标题行/裸栏名行，再逐条改写。
 *  无任何命中时**原样返回**（零误伤正常正文）。 */
function scrubProseChunk(chunk: string): string {
  let changed = false
  const kept: string[] = []
  for (const line of chunk.split("\n")) {
    if (FIELD_HEADING_LINE_RE.test(line) || isPureInternalFieldLine(line) || BARE_INTERNAL_TOKEN_RE.test(line.trim())) {
      changed = true
      continue
    }
    kept.push(line)
  }
  const base = kept.join("\n")
  const rewritten = scrubOutsideUrls(base, (c) => {
    let r = c
    for (const [re, rep] of PROSE_REWRITE_RULES) r = r.replace(re, rep)
    r = r.replace(INTERNAL_PATH_RE, "内部工作区").replace(SOURCE_REF_RE, "源码")
    r = r.replace(RUN_ID_RE, "运行编号").replace(TOKEN_COUNT_RE, "用量计数")
    r = r.replace(BARE_LOOPBACK_RE, "本机地址")
    return r
  })
  if (!changed && rewritten === chunk) return chunk
  return rewritten.trim().length === 0 ? "" : rewritten
}

/**
 * 纯函数（F11）：**模型自述正文**（message.delta / turn.status / notice 类）的内审语汇剥离。
 *  = 与 F10 同源判定 + 定向改写；代码栅栏整段跳过，URL 段原样保留。
 */
export function scrubVisibleProse(raw: unknown): string {
  if (typeof raw !== "string") return ""
  if (raw.length === 0) return raw
  // 代码栅栏整段不碰（split 后奇数索引即栅栏段）。
  const parts = raw.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/)
  return parts.map((p, i) => (i % 2 === 1 ? p : scrubProseChunk(p))).join("")
}

/**
 * 弱内部痕迹的**就地脱敏**（clean/scaffold 路径专用，不整段降级）：
 * 内部路径 / runId / 用量计数换成产品语言；UUID 与 task_id 是用户需要的生成回执，保持原样。
 */
function sanitizeWeakInternalArtifacts(s: string): string {
  return s
    .replace(INTERNAL_PATH_RE, "内部工作区")
    .replace(RUN_ID_RE, "运行编号")
    .replace(TOKEN_COUNT_RE, "用量计数")
}

/**
 * 纯函数（三出口共用）：子代理产出/唤醒载荷 → 用户可见文字。
 *  内审/复核产物 → 一句产品语言（+ 成品 URL）；正常交付 → 去纯内部栏位行留正文；正常正文 → 原样。
 *  F11 附加：整行恰为裸栏名单词（如 subagent.delta 的裸 `evidence`）整行删除；裸回环端点先删。
 */
export function scrubSubagentPayload(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return ""
  let s = raw.replace(/\r\n?/g, "\n")
  // 0) 内部端点先删（带 scheme 的 URL 与裸回环端点是同一类内部物证）。
  s = s.replace(INTERNAL_ENDPOINT_URL_RE, "")
  s = s.replace(BARE_LOOPBACK_RE, "")
  // 1) 结构脚手架：落盘指针 / 截断提示 / 用量计数。既非用户内容，也不作内审判据
  //    （否则每个 run 的落盘指针都会把正常交付误判成内审产物）。
  s = s.replace(/\[(?:完整|部分)结果(?:已落盘|落盘失败)[^\]]*\]\s*/g, "")
  s = s.replace(/\n*\[已截断[^\]]*\]\s*/g, "\n")
  s = s.replace(/\n*\[子代理用量\][^\n]*/g, "")
  // 2) 结构判定 → 分层降级。
  const cls = classifyInternalReviewPayload(s)
  if (cls === "review") return degradeInternalReviewPayload(s)
  // scaffold：只删**纯内部栏位行**（无中文说明），再就地脱敏弱内部痕迹；正常报告正文逐字不变。
  if (cls === "scaffold") return sanitizeWeakInternalArtifacts(stripScaffoldFromDeliverable(s))
  // 3) 正常正文：整行恰为裸栏名单词的行删掉（R5 的 138 帧裸 `evidence`），其余逐字不变。
  if (BARE_INTERNAL_TOKEN_RE.test(s.trim())) return ""
  const lines = s.split("\n").filter((line) => !BARE_INTERNAL_TOKEN_RE.test(line.trim()))
  const joined = lines.join("\n")
  // F13：无行被删 → **逐字原样返回**（不再无条件 trim/折叠空行——用户 prompt／歌词／业务正文
  // 必须 OUT==IN；旧行为会把首尾空白与连续空行吃掉，破坏「不过清洗」的长度+sha 判据）。
  const body =
    joined === s ? s : joined.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  // 正常正文里的弱内部痕迹就地脱敏（不再整段降级），UUID/task_id 保留。
  return sanitizeWeakInternalArtifacts(body)
}

/** F11：用户可见**文字**帧（正文/状态/通知）——只清洗这些帧的 `text`；tool/canvas/结构化帧不碰。 */
function isUserVisibleTextFrame(name: string): boolean {
  return name === "message.delta" || name === "turn.status" || name === "notice" || name.endsWith(".notice")
}

/**
 * 用户可见 SSE 帧的单一咽喉点清洗（F11：由「按帧名」改为「按内容判定，但只对用户可见文字帧」）。
 *  ① 携带**子代理内部摘要/正文**的帧 → F10 同源判定（整段降级 / 去纯栏位行 / 原样）；
 *  ② 模型自述**正文/状态/通知**帧 → 同源判定 + 逐句定向改写（scrubVisibleProse）；
 *  其余帧（tool payload、canvas、结构化字段等）一律不碰 → 零误伤。
 */
export function scrubVisibleFrame(name: string, data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return data
  const d = data as Record<string, unknown>
  if (name === "subagent.done") {
    if (typeof d.summary !== "string") return data
    const cleaned = scrubSubagentPayload(d.summary)
    return cleaned === d.summary ? data : { ...d, summary: cleaned }
  }
  if (name === "subagent.delta") {
    if (typeof d.text !== "string") return data
    const cleaned = scrubSubagentPayload(d.text)
    return cleaned === d.text ? data : { ...d, text: cleaned }
  }
  if (isUserVisibleTextFrame(name)) {
    if (typeof d.text !== "string") return data
    const cleaned = scrubVisibleProse(d.text)
    return cleaned === d.text ? data : { ...d, text: cleaned }
  }
  return data
}
