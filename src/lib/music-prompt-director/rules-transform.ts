import { CHANNEL_LIMITS, CONTROL_CHARS, DEAD_PLAIN_TAGS, EMPTY_WORDS, ENERGY_PROSE, INSTRUMENT_GLOBAL, LAYER_WEIGHT, LYRICS_MARKER_PATTERN, MARKUP_NOISE, MAX_MODE_KEYS, MOOD_WORD_GLOBAL, MUSIC_LAYER_IDS, MUSIC_LAYER_PATTERNS, PSEUDO_TAG_PATTERN, SECTION_TAG_KEY_PATTERN, SECTION_TAG_PATTERN, SLOP_WORDS, STRUCTURE_WORDS, TIMESTAMP_BARE, TIMESTAMP_BARE_LINE, TIMESTAMP_BRACKETED, TIMESTAMP_BRACKETED_DETECT, TIMESTAMP_OLD_PARENTHETICAL, TIMESTAMP_OLD_PARENTHETICAL_DETECT, countRunes, detectLayers, layerFill, replaceAll, stripLayerFills } from "./rules-core";
import type { MusicDirectorOptions, MusicDirectorResult, MusicLayerId, PromptCheck, RetainedPromptInfo } from "./rules-core";

/**
 * 依最终 prompt 的**实际字串**反推「还在场」的层与承重元素——回执诚实性用。
 * 判定一律 grep 字符串（BPM／key 真的在串里才算「保住」），不看层名，
 * 杜绝「宣称保住 X 但输出里没有 X」（2026-10-04 F2 回执说谎根因）。
 *
 * 无人声宣告（2026-10-06 修假阳）：先从待判文本剥离补层文案再测 `INSTRUMENTAL_DECLARATION_PATTERN`
 * ——补层的 `no vocals` 是规则层自加的建议文案，不代表用户宣告；用户自己的
 * `Instrumental only, no vocals.`（buildToolPrompt/尾端宣告）不在补层集里，剥离后仍会被测到。
 * layers/tempo/key 仍按原样整串判定（本次只修无人声宣告这一条假阳，不动其他口径）。
 */
export function describeRetainedLayers(prompt: string): RetainedPromptInfo {
  return {
    layers: MUSIC_LAYER_IDS.filter((id) => MUSIC_LAYER_PATTERNS[id].test(prompt)),
    tempo: BPM_PATTERN.test(prompt),
    key: KEY_PATTERN.test(prompt),
    instrumentalDeclaration: INSTRUMENTAL_DECLARATION_PATTERN.test(stripLayerFills(prompt)),
  };
}

/** 「实际保留」的简体中文清单（无人声宣告在场时不再单列 vocal 层，以免与人声混淆）。 */
export function describeRetainedParts(prompt: string): string[] {
  const retained = describeRetainedLayers(prompt);
  const layers = retained.layers.filter((id) => !(id === "vocal" && retained.instrumentalDeclaration));
  return [
    ...layers.map((id) => MUSIC_LAYER_LABELS[id]),
    ...(retained.tempo ? ["速度"] : []),
    ...(retained.key ? ["调性"] : []),
    ...(retained.instrumentalDeclaration ? ["无人声宣告"] : []),
  ];
}

// ─────────────────────────────────────────────── 结构化校验账（P0-11）

/**
 * 段落时长列表的侦测式（输入缺结构化 sectionSeconds 时退回文本侦测）：
 * ① 带标签：`段落时长: 3.04、9.12 …`／`section durations: 3.04, 9.12`／`ssection: …`；
 * ② 带尾单位：`3.04/9.12/6.08 小节`／`3.04, 9.12 bars`／`… seconds`。
 * 只认**≥2 个由 / 、 , ／ 分隔的十进制数**，避免把单个数字误当段落时长。
 * 分隔符类含全角斜线 `／`（U+FF0F）：同类的 `，`／`、` 早已在内，属归一化补全——
 * 缺它会让 `2／4 seconds` 整串落空、两条都静默「跳过（缺 段落时长）」（2026-10-06 对抗验收）。
 */
const SECTION_SECONDS_LABELED_PATTERN =
  /(?:section(?:s)?\s*(?:durations?|lengths?)|段落(?:时长|长度)|段长|小节)\s*[:：]\s*((?:-?\d+(?:\.\d+)?)(?:\s*[/、,／，]\s*-?\d+(?:\.\d+)?)+)/i;
// 尾单位的文字交替接 `(?![A-Za-z])`：`secs?` 会吃掉 `sections` 的前缀 `sec`，把 `7 sections`
// 误当段落秒数；负向先行断言挡住「单位其实是更长的英文单词前缀」的情形（不能用 `\b`，
// 后面可能是 CJK `小节`／`秒`，`\b` 在 CJK 边界语义不可靠）。
const SECTION_SECONDS_UNITED_PATTERN =
  /((?:-?\d+(?:\.\d+)?)(?:\s*[/、,／，]\s*-?\d+(?:\.\d+)?)+)\s*(?:小节|bars?|measures?|seconds?|secs?|秒)(?![A-Za-z])/i;

/**
 * 全角数字／小数点归一到 ASCII（`０-９`→`0-9`、`．`→`.`）。
 * **只在解析器内部的副本上做**——直接改 prompt 本体等于污染送上游的内容。
 */
function widenFullWidthDigits(text: string): string {
  return text
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\uFF0E/g, ".");
}

/** 从文本的「段落时长声明」取秒数列表（侦测不到回 null）。负号进捕获组，负值留给判定层当异常。 */
function parseSectionSeconds(prompt: string): number[] | null {
  const text = widenFullWidthDigits(prompt);
  const match = text.match(SECTION_SECONDS_LABELED_PATTERN) ?? text.match(SECTION_SECONDS_UNITED_PATTERN);
  if (!match) return null;
  const values = match[1]
    .split(/[/、,／，]/)
    .map((token) => Number(token.trim()))
    .filter((value) => Number.isFinite(value));
  return values.length > 0 ? values : null;
}

/** 中文数字（仅 1–99 的常见写法）→ 数值；不认的回 null。 */
const CN_NUMERALS: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
function parseChineseNumber(token: string): number | null {
  if (!token) return null;
  if (token === "十") return 10;
  const shi = token.indexOf("十");
  if (shi === -1) return CN_NUMERALS[token] ?? null;
  const head = token.slice(0, shi);
  const tail = token.slice(shi + 1);
  const tens = head === "" ? 1 : CN_NUMERALS[head];
  const ones = tail === "" ? 0 : CN_NUMERALS[tail];
  if (tens === undefined || ones === undefined) return null;
  return tens * 10 + ones;
}

/**
 * 从文本侦测「声明的段落数」（`7 sections`／`七段落`／`7 段`）；侦测不到回 null。
 * 先做全角数字归一（复用 widenFullWidthDigits）：`３ sections`／`７ 段` 与本节其他解析器同口径，
 * 否则段数写作全角时静默跳过判定（2026-10-06 对抗验收）。数字分支与 `段`／`sections?` 两路都走归一后文本。
 */
function parseDeclaredSectionCount(prompt: string): number | null {
  const text = widenFullWidthDigits(prompt);
  const digit = text.match(/(\d{1,3})\s*(?:sections?|段)/i);
  if (digit) return Number(digit[1]);
  const chinese = text.match(/([一二两三四五六七八九十]{1,3})\s*段/);
  if (chinese) return parseChineseNumber(chinese[1]);
  return null;
}

/**
 * BPM 侦测：四条形状——① 后缀形 `146 BPM`（`[BPM: 146]` 由 rewritePseudoTags 改写成它）；
 * ② 标签形 `BPM: 146`／`BPM：146`（非方括号，不会被伪标签改写）；③ 前缀冒号形 `Tempo: 146`／`tempo：146`
 * （含 tempo 这一全球通用的速度词）；④ 前缀空格形 `BPM 146`／`tempo 146`。③④ 不是方括号伪标签，
 * rewritePseudoTags 不会改写，旧版因此静默跳过（2026-10-06 对抗验收）。值放宽到 1-4 位整数＋可选小数
 * （`87.5 BPM` 不再静默跳过）。
 * 不做负号捕获：捕获负号会把减号区间（`120-140 BPM`）误当负值，代价大于收益。带符号的写法本就属
 * 无意义输入，按无符号判即可。
 * 多形状同时命中时取**文本中先出现**的那个（与既有「取首值」语义一致）；
 * 同一起点先取后缀形。`tempo`／`bpm` 后不接数字（如 `tempo: slow`）不匹配。全角数字先归一。
 */
function parseBpm(prompt: string): number | null {
  const text = widenFullWidthDigits(prompt);
  const patterns = [
    /\b(\d{1,4}(?:\.\d+)?)\s*bpm\b/gi,
    /\bbpm\s*[:：]\s*(\d{1,4}(?:\.\d+)?)/gi,
    /\b(?:bpm|tempo)\s*[:：]\s*(\d{1,4}(?:\.\d+)?)/gi,
    /\b(?:bpm|tempo)\s+(\d{1,4}(?:\.\d+)?)/gi,
  ];
  let bestIndex = Number.POSITIVE_INFINITY;
  let bestValue: number | null = null;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match || match.index >= bestIndex) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      bestIndex = match.index;
      bestValue = value;
    }
  }
  return bestValue;
}

/**
 * 结构化校验账（P0-11，纯函数、只判定不改 prompt）：把创作方**声明的音乐学约束**落成
 * 可判定的机读结果。判定对象＝提交文本里的声明（BPM／段落秒数／段数）＋ options 的结构化输入；
 * 输入不足的判据 ok:true 并在 detail 写明跳过原因（既不凭空判失败，也不假装通过）。
 *
 * 判据：
 *  ① bpm-section-alignment：有 BPM 与段落秒数时，逐段算 `秒数 ÷ (60/BPM×4)`（一小节＝四拍），
 *     非整数即失败，detail 逐段列出「第 N 段 Ms ÷ Xs = Y 小节（非整数）」。
 *     **判定域边界（2026-10-06 第五轮收窄）**：只判 BPM ∈ [20, 400] 且段落秒数 ∈ (0, 3600] 的域；
 *     域外一律走跳过（ok:true，detail 写明「不判」）——极小／极大 BPM 与天文秒数会让容差
 *     退化成恒真（0.00001 BPM ⇒ bars≈0；>2^53 秒 ⇒ IEEE754 舍入成偶整数），此时启发式
 *     没有收敛点，老实说判不动，而不是装作判得动。
 *  ② section-count：声明的段数与实际给出的段落时长个数不符即失败。
 *
 * 只判定：**不因失败修改 prompt**（时长是否在拍上是创作方/上游的事，规则层只如实回报）。
 */
export function evaluatePromptChecks(
  prompt: string,
  options: Pick<MusicDirectorOptions, "sectionSeconds" | "declaredSectionCount"> = {},
): PromptCheck[] {
  const bpm = parseBpm(prompt);
  // ── 收窄判定域（2026-10-06 第五轮，终止轮）────────────────────────────────────
  // 前四轮都在「补写法」（补零值→小数与浮点又漏；每补一处冒一处新误判），证明这个启发式
  // **没有收敛点**。正确的收法是收窄它声称能判的域：域内判得动就判，域外老实说「不判」。
  // ① BPM 可信域 [20, 400]：域外（含 0／负／极小／极大）一律走跳过。极小正 BPM（如 0.00001）
  //    令 barSeconds 成天文数字、bars≈0，会被绝对容差判成「落在第 0 小节」假通过；
  //    原 `!(bpm > 0)` 只挡字面 0，`0 < bpm ≲ 5e-5` 整段裸奔。范围判据一并取代它。
  const bpmOutOfRange = bpm !== null && (bpm < 20 || bpm > 400);
  const sectionSeconds =
    options.sectionSeconds && options.sectionSeconds.length > 0
      ? options.sectionSeconds.filter((value) => Number.isFinite(value))
      : parseSectionSeconds(prompt);
  const declaredCount = options.declaredSectionCount ?? parseDeclaredSectionCount(prompt);
  const hasSections = sectionSeconds !== null && sectionSeconds.length > 0;
  const barSeconds = bpm !== null && bpm > 0 ? (60 / bpm) * 4 : Number.NaN;
  // ② 段落秒数可信域 (0, 3600]（barSeconds 非有限同属判不动）：域外走跳过。天文秒数超过 2^53
  //    后被 IEEE754 舍入成偶整数，bars 假成整数（10000000000000001 ⇒ 假通过）。
  //    语义区分：≤0 是**不合规声明**（该判 ok:false，见下 loop）；>3600 是**判不动**（跳过）。
  const secondsOutOfRange =
    sectionSeconds !== null &&
    sectionSeconds.length > 0 &&
    (sectionSeconds.some((value) => value > 3600) || !Number.isFinite(barSeconds));

  // ① 小节对齐
  let alignment: PromptCheck;
  if (bpmOutOfRange) {
    // BPM 落在可信域外 ⇒ 判不动；既不判成「全部落在小节线上」，也不凭空判失败。
    alignment = {
      kind: "bpm-section-alignment",
      ok: true,
      detail: "BPM 超出可信范围（20–400），跳过小节对齐判定。",
    };
  } else if (bpm === null || !hasSections) {
    alignment = {
      kind: "bpm-section-alignment",
      ok: true,
      detail: `未提供 BPM/段落时长，跳过（缺${bpm === null ? " BPM" : ""}${!hasSections ? " 段落时长" : ""}）`,
    };
  } else if (secondsOutOfRange) {
    alignment = {
      kind: "bpm-section-alignment",
      ok: true,
      detail: "段落时长超出可信范围或不可判定，跳过小节对齐判定。",
    };
  } else {
    const offBeat: string[] = [];
    for (let index = 0; index < sectionSeconds.length; index += 1) {
      const seconds = sectionSeconds[index];
      const bars = seconds / barSeconds;
      if (seconds <= 0) {
        // 零长度与负值同规：零时长 bars=0 会被 Math.round 判成「落在小节线上」假通过。
        // 这是**不合规声明**（该判失败），与域外「判不动」（跳过）语义不同，勿合并。
        offBeat.push(`第 ${index + 1} 段 ${seconds}s 非正（段落时长不可为 0 或负）`);
      } else if (Math.abs(bars - Math.round(bars)) > Math.max(1, bars) * 1e-3) {
        // 容差改**相对**（约千分之一小节）：绝对 1e-6 在 bars 稍大时把「人写三位小数四舍五入」
        // 的合规时长判成非整数（87.5 BPM 配 2.743/5.486 差 5.2e-5 被误判）。
        offBeat.push(`第 ${index + 1} 段 ${seconds}s ÷ ${barSeconds.toFixed(4)}s = ${bars.toFixed(3)} 小节（非整数）`);
      }
    }
    alignment = {
      kind: "bpm-section-alignment",
      ok: offBeat.length === 0,
      expected: sectionSeconds.length,
      actual: sectionSeconds.length - offBeat.length,
      detail:
        offBeat.length === 0
          ? `${bpm} BPM 下一小节 = ${barSeconds.toFixed(4)}s，${sectionSeconds.length} 段全部落在小节线上。`
          : `${bpm} BPM 下一小节 = ${barSeconds.toFixed(4)}s；${offBeat.length}/${sectionSeconds.length} 段不在小节线上：${offBeat.join("；")}。`,
    };
  }

  // ② 段数一致
  let count: PromptCheck;
  if (!hasSections || declaredCount === null) {
    count = {
      kind: "section-count",
      ok: true,
      detail: `未提供 BPM/段落时长，跳过（缺${!hasSections ? " 段落时长" : " 段落声明段数"}）`,
    };
  } else {
    const actual = sectionSeconds.length;
    count = {
      kind: "section-count",
      ok: declaredCount === actual,
      expected: declaredCount,
      actual,
      detail:
        declaredCount === actual
          ? `声明 ${declaredCount} 段，与给出的 ${actual} 个段落时长一致。`
          : `声明 ${declaredCount} 段，但只给出 ${actual} 个段落时长（${sectionSeconds.join("/")}）。`,
    };
  }

  return [alignment, count];
}

/** 伪标签 → 散文／删除。来源：CORE_03_DIAGNOSE.md:190-251 §3 row 1／3／4／5／6／7。 */
function rewritePseudoTags(prompt: string): string {
  return prompt.replace(PSEUDO_TAG_PATTERN, (_match, rawKey: string, rawValue: string) => {
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    // 段落标签（`[Verse 1: gentle piano]`／`[Chorus: big]`）是结构语法不是伪参数，整条原样保留。
    if (SECTION_TAG_KEY_PATTERN.test(rawKey.trim())) return _match;
    // row 1：没有隐藏品质模式，整条删除
    if (MAX_MODE_KEYS.includes(key) && /^max$/i.test(value)) return "";
    // row 4：乐理参数落成 Style 内的散文，「120 BPM」「key of A minor」
    if (key === "bpm" || key === "tempo") return /\bbpm\b/i.test(value) ? value : `${value} BPM`;
    if (key === "key") return `key of ${value}`;
    // row 5：情绪／能量／氛围假标签 → 词本身就是意义，去括号与冒号
    if (key === "energy") return ENERGY_PROSE[value.toLowerCase()] ?? `${value} energy`;
    // row 6：`[Sound: Rain]` → 章节级 `[Rain]`
    if (key === "sound") return `[${value}]`;
    // row 7：唱法方向 → 散文；唱的人是另一层，这里只把 value 交还
    if (key === "vocal" || key === "vocal style") return `${value} lead vocal`;
    if (key === "choir") return `${value} choir`;
    // row 3：混音参数 → Style 内的散文
    if (key === "eq") return `${value} mids`;
    if (key === "compression") return /^heavy/i.test(value) ? "heavily compressed" : `${value} compression`;
    if (key === "focus") return `${value} focus`;
    if (key === "reverb") return `${value} reverb`;
    return value;
  });
}

/** 修掉删标签／修剪留下的空子句分隔（`,,,`、`, ,`、行尾逗号）；只动标点，不动文字。 */
function tidySeparators(prompt: string): string {
  return prompt
    .replace(/([,;，；])(?:\s*[,;，；])+/g, "$1")
    .replace(/[,;，；]\s*$/, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** 找出库内「没有音乐资讯」的空词（只回报，不替换）。来源：CORE_01_STYLE.md:303-313 §4。 */
function findEmptyWords(prompt: string): string[] {
  const found: string[] = [];
  for (const word of EMPTY_WORDS) {
    if (new RegExp(`\\b${word}\\b`, "i").test(prompt) && !found.includes(word)) found.push(word);
  }
  return found;
}

/** 收集 MOOD 在场词（去重、依出现序）。来源：CORE_01_STYLE.md:261-288 §4 PALETTE。 */
function findMoodWords(prompt: string): string[] {
  const matches = prompt.match(MOOD_WORD_GLOBAL) ?? [];
  const seen: string[] = [];
  for (const match of matches) {
    const word = match.toLowerCase();
    if (!seen.includes(word)) seen.push(word);
  }
  return seen;
}

/**
 * 超过两个的 MOOD 移除（保留前两个出现的）。相容性判定（例如 dark + euphoric 会被平均掉）
 * 库内没有可用的相容／冲突对照表，故只能确定性修剪数量、把相容性留给 warnings。
 * 来源：CORE_01_STYLE.md:54-60 §1 Layer 2「Two moods maximum」、CORE_03_DIAGNOSE.md:94-99 §2 CHECK 4。
 */
function trimExtraMoods(prompt: string, moods: readonly string[]): string {
  let out = prompt;
  for (const mood of moods.slice(2)) {
    out = out.replace(new RegExp(`\\b${mood}\\b`, "gi"), " ");
  }
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;，；。])/g, "$1")
    .replace(/([,;，；])\s*(?=[,;，；])/g, "$1")
    .trim();
}

/** flowmusic 保版面分支不适用：时间戳一律剥除（时间码在上游消失），描述文字保留。 */
function stripTimestamps(prompt: string): string {
  return prompt
    .replace(TIMESTAMP_BRACKETED, " ")
    .replace(TIMESTAMP_OLD_PARENTHETICAL, " ")
    .replace(TIMESTAMP_BARE, " ")
    .replace(/\[\s*\]|（\s*）|\(\s*\)/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;，；。])/g, "$1")
    .trim();
}

/**
 * 单行歌词的时间码剥除：只吃被 `[ ]`／`( )` 包住的数字时间码（与剥后留下的空括号）。
 * **不碰正文里的数字时间**（`we left at 0:12 that night`／`3:45 AM` 原样），
 * 也不套拉丁标点前的空白收敛（`散开 ，曙光` 的空格保留）。
 */
function stripLyricsLine(line: string): string {
  return line
    .replace(TIMESTAMP_BRACKETED, " ")
    .replace(TIMESTAMP_OLD_PARENTHETICAL, " ")
    .replace(/\[\s*\]|（\s*）|\(\s*\)/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * 歌词栏的时间码剥除（供工具层对 flowmusic／yue2 的歌词做与 style 相同的处理）。
 * 只动被 `[ ]`／`( )` 包住的数字时间码、其空括号，以及「整行恰为裸时间码」的行；
 * `[Verse]`／`[Chorus]` 等段落标签原样保留（yue2 上游必需语法）；Lyria 认时间码，呼叫方对该通路不要用本函式。
 * `hadTimestamp` ＝ **实际发生了剥除**（不是「侦测到时间码字样」）——避免回执谎报剥了没剥的东西。
 */
export function stripLyricsTimestamps(lyrics: string): { lyrics: string; hadTimestamp: boolean } {
  let removed = false;
  const lines = lyrics.split("\n").map((line) => {
    if (TIMESTAMP_BARE_LINE.test(line)) {
      removed = true;
      return "";
    }
    if (!TIMESTAMP_BRACKETED_DETECT.test(line) && !TIMESTAMP_OLD_PARENTHETICAL_DETECT.test(line)) return line;
    removed = true;
    return stripLyricsLine(line);
  });
  if (!removed) return { lyrics, hadTimestamp: false };
  const cleaned = lines
    .join("\n")
    // 剥除时间码后留在段落标签内的空白（`[Outro (0-15s)]` → `[Outro ]`）收干净。
    .replace(/\[\s*([^\]]*?)\s*\]/g, "[$1]")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
  return { lyrics: cleaned, hadTimestamp: true };
}

/** flowmusic 平面分支：全文压成一行（换行不带语义，上游会压平）。 */
function collapseToSingleLine(prompt: string): string {
  return prompt
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** 歌词标签在场？（options.hasLyrics 明示时以明示为准）。 */
function hasLyricsMarker(prompt: string): boolean {
  return LYRICS_MARKER_PATTERN.test(prompt) || SECTION_TAG_PATTERN.test(prompt);
}

/** 首个子句是否就是流派（front-loading）。来源：CORE_03_DIAGNOSE.md:78-87 §2 CHECK 1、CORE_01_STYLE.md:42 §1。 */
function isGenreFrontLoaded(prompt: string): boolean {
  const firstClause = prompt.split(/[,;.\n，；。]/)[0] ?? "";
  return MUSIC_LAYER_PATTERNS.genre.test(firstClause);
}

/** 乐器数量（去重、去从属写法如 horn ⊂ french horn）。来源：CORE_03_DIAGNOSE.md:89-93 §2 CHECK 3、CORE_01_STYLE.md:329-340 §5。 */
function countDistinctInstruments(prompt: string): number {
  const matches = (prompt.match(INSTRUMENT_GLOBAL) ?? []).map((match) => match.toLowerCase().replace(/s$/, ""));
  const distinct = matches.filter((match) => !matches.some((other) => other !== match && other.includes(match)));
  return new Set(distinct).size;
}

/**
 * 硬截的预算下限：退让后至少留 60% cap（用满预算的硬性下限，防「一路退到首个
 * 边界」把 mood／乐器／结构整段丢掉——2026-09-12 实锤：`Intro: soft pad.` 之后
 * 是无逗号长串时旧逻辑只留 15 runes＝7% 预算）。
 */
const MIN_KEEP_RATIO = 0.6;

/** 子句边界（硬截退让点）＝中西文逗号／分号／句号／中文列举顿号。 */
const CLAUSE_BOUNDARIES: readonly string[] = [",", ";", ".", "，", "；", "。", "、"];

/** 保版面分支多认一个换行边界。 */
const LAYOUT_BOUNDARIES: readonly string[] = [...CLAUSE_BOUNDARIES, "\n"];

/**
 * 承重栏位：速度与调性（含 key of X / X major|minor / 和弦级数写法）。六层侦测把它归进
 * PRODUCTION（低权重），但 220 压缩时**必须保住**——2026-10-04 R1 实锤：无歌词器乐分支被
 * 硬截后 BPM 76／A 小调／Am7–Dm7–G7–Cmaj7 全没进模型，成品速度调性失控＝白做一版。
 */
const TEMPO_KEY_PATTERN =
  /\b\d{2,3}\s*bpm\b|\bbpm\b|\btempo\b|\bkey of\b|\b[a-g](?:\s*#|\s*b)?\s*(?:major|minor)\b|\b(?:[a-g](?:m|maj|min|dim|aug|7|9|11|13)[0-9a-z]*)(?:\s*[-–—]\s*[a-g](?:m|maj|min|dim|aug|7|9|11|13)[0-9a-z]*)+/i;

/** 速度散文写法（回执判定「速度是否真的留在最终串里」用）。 */
const BPM_PATTERN = /\b\d{2,3}\s*bpm\b|\bbpm\b|\btempo\b/i;

/** 调性散文写法（key of X／X major|minor）。 */
const KEY_PATTERN = /\bkey of\b|\b[a-g](?:\s*#|\s*b)?\s*(?:major|minor)\b/i;

/**
 * 段落结构子句（决定性参数之一）：段落如何展开的散文写法（verses／chorus／bridge／
 * call and response／build-up …）与方括号段落标签。与 STRUCTURE_WORDS 的差别＝刻意
 * 不含时间戳（时间轴顺序敏感，且本前置只对 flowmusic 生效）。
 */
const SECTION_DECIDING_PATTERN =
  /\b(?:verses?|chorus(?:es)?|bridges?|intros?|outros?|pre-?chorus|hooks?|refrain|coda|middle eight|call[- ]and[- ]response|aaba|twelve-?bar|strophic|through-?composed|buildups?|build-?up|breakdowns?|drops?|section by section)\b|\[(?:verse|chorus|bridge|intro|outro|pre-?chorus|hook|refrain|breakdown|drop|主歌|副歌|导歌|桥段|前奏|尾奏|间奏)\]/i;

/**
 * 无人声宣告＝承重子句（2026-10-04 F2 实锤）：压缩时若被当低权重 vocal 子句丢掉，
 * 纯器乐请求可能被上游补上人声，而回执只说「丢掉：vocal」。故它的子句权重高于 BPM／调性，
 * 并另有一条「从尾端整体抽出、压缩后接回」的保命路径（见 directMusicPrompt 步骤 5）。
 */
const INSTRUMENTAL_DECLARATION_PATTERN = /instrumental only|no vocals/i;

/** 追加在 prompt 尾端的无人声宣告（buildToolPrompt 的固定写法；容许与前文无标点直接相连）。 */
const INSTRUMENTAL_DECLARATION_TAIL = /\s*(Instrumental only,?\s*no vocals\.?)\s*$/i;

/** 层 id → 简体中文标签（回执人话用）。 */
export const MUSIC_LAYER_LABELS: Readonly<Record<MusicLayerId, string>> = {
  genre: "流派",
  mood: "情绪",
  instrumentation: "编制",
  vocal: "人声",
  structure: "结构",
  production: "制作",
};

/** 子句切分（保留每段尾端分隔符，重建时可逐字还原）；分隔符同硬截退让点。 */
const CLAUSE_SPLIT_PATTERN = /[^,;.，；。、\n]+[,;.，；。、\n]?/g;

/**
 * 裸段落标签：整句只有段落名本身（可带序号／冒号／标点），没有任何描述性内容。
 * 例：`Intro`、`[Verse]`、`[Chorus 2]`。这类标签决定结构但**不承载风格信息**，
 * 压缩时不得压过 genre（2026-10-19 回归：裸 `Intro` 权重 7 高于 genre 6，导致
 * 「Intro: soft pad.」句被留下、genre／BPM／调性全被丢光）。带描述的段落句
 * （`Intro: soft pad.`）仍是承重子句。
 */
const BARE_SECTION_LABEL_PATTERN =
  /^[\s[\](){}，；。、:：-]*(?:pre-?chorus|chorus|verse|bridge|intro|outro|hook|refrain|breakdown|drop|主歌|副歌|导歌|桥段|前奏|尾奏|间奏)(?:\s*\d+)?[\s[\](){}，；。、:：-]*$/i;

/** 未匹配任何层的细节子句（环境音／时长／乐手描述）＝中等权重：先于 STRUCTURE／PRODUCTION 被丢。 */
const UNMATCHED_CLAUSE_WEIGHT = 3;

/**
 * 子句权重：决定性参数（BPM／调性／和弦进行／段落结构）承重最高；其余取命中层的
 * LAYER_WEIGHT（多层取最大）；未命中＝中权重。压缩据此优先丢低权重的描述性修饰子句
 * （混音／空间／年代感），而不是用户给定的风格参数（2026-10-04 G3）。
 */
function clauseWeight(clause: string): number {
  // 无人声宣告承重最高（高于 BPM／调性）：压缩必须保住它，否则纯器乐请求会被上游补人声。
  if (INSTRUMENTAL_DECLARATION_PATTERN.test(clause)) return 8;
  // 速度／调性／和弦进行＝承重：压缩不得把它们当低权重层丢掉。
  if (TEMPO_KEY_PATTERN.test(clause)) return 7;
  // 段落结构是决定性参数，但**裸标签**（`Intro`／`[Verse]`，无描述）只决定结构、
  // 不含风格信息：权重不得高于 genre（6），否则压缩会为了留一个空标签丢掉整段风格
  // （2026-10-19 回归：`Intro: soft pad.` 被留、genre／BPM／调性全丢）。带描述的
  // 段落句仍按 7 承重（段落如何展开是可采样信息）。
  if (SECTION_DECIDING_PATTERN.test(clause)) {
    return BARE_SECTION_LABEL_PATTERN.test(clause) ? LAYER_WEIGHT.genre : 7;
  }
  let best = 0;
  for (const id of MUSIC_LAYER_IDS) {
    if (MUSIC_LAYER_PATTERNS[id].test(clause)) best = Math.max(best, LAYER_WEIGHT[id]);
  }
  return best > 0 ? best : UNMATCHED_CLAUSE_WEIGHT;
}

/** 子句命中的最高权重层（回报「丢了哪几层」用；未命中回 null）。 */
function clauseLayer(clause: string): MusicLayerId | null {
  let bestId: MusicLayerId | null = null;
  let bestWeight = 0;
  for (const id of MUSIC_LAYER_IDS) {
    if (MUSIC_LAYER_PATTERNS[id].test(clause) && LAYER_WEIGHT[id] > bestWeight) {
      bestId = id;
      bestWeight = LAYER_WEIGHT[id];
    }
  }
  return bestId;
}

/** 把文本切成可由分隔符逐字还原的子句（空白子句丢弃）。 */
function splitClauses(text: string): string[] {
  const matched = text.match(CLAUSE_SPLIT_PATTERN) ?? [];
  return matched.filter((clause) => clause.trim() !== "");
}

/** 去掉头尾残留分隔／空白（只动标点空白，不动文字）。 */
function trimClauseEdges(text: string): string {
  return text
    .replace(/^[\s,;.，；。、\n]+/, "")
    .replace(/[\s,;.，；。、\n]+$/, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * 决定性参数前置（2026-10-04 G3 交付，仅 flowmusic）：FlowMusic 上游回吐的
 * `sound_prompt` 摘要只逐字保留前段——把 BPM／调性／和弦进行／段落结构写在尾部
 * 会整层丢失（G1 实测样本 B：`key of C major` 整丢、STRUCTURE 整层丢，只有句尾的
 * BPM 被搬到回吐串末尾；样本 A 亦见规则层补的 STRUCTURE 被丢）。
 *
 * 故在组装前把「决定性参数子句」整句前移，紧随居首的 GENRE 子句之后（让它们落在
 * 实送文本的前 1/3，进入上游摘要逐字保留的区间）；描述性修饰子句（混音／空间／
 * 年代感等 PRODUCTION 描述）留在后方，仍可被长度压缩或上游摘要裁掉。
 *
 * 只重排整句、逐字不改；首子句（genre front-loading 承重位）永不移动；无参数可移
 * 或参数已在最前时原样返回（不制造无谓的标点归一化）。
 */
function frontLoadDecidingParams(text: string): string {
  const clauses = splitClauses(text);
  if (clauses.length <= 2) return text;
  const isDeciding = (clause: string) =>
    TEMPO_KEY_PATTERN.test(clause) || SECTION_DECIDING_PATTERN.test(clause);
  const [head, ...tail] = clauses;
  const params = tail.filter(isDeciding);
  // 无决定性参数可移，或它们本就全在 head 之后（顺序未变）→ 不重排。
  if (params.length === 0 || params.length === tail.length) return text;
  const rest = tail.filter((clause) => !isDeciding(clause));
  const ordered = [head, ...params, ...rest];
  // 被前移的参数可能原是全文最后一句（无尾部分隔符）——移位后它不再居末，
  // 补一个逗号防与后句黏连（正常情形子句自带分隔符，逐字不变）。
  const joined = ordered
    .map((clause, index) =>
      // 尾分隔符也要认换行：保版面分支（歌词／段落标签）的一行本身就是一条完整子句，
      // 前移参数时不得把行尾 `\n` 吃掉补逗号，否则整篇歌词会被压成单行（2026-10-19 回归）。
      index < ordered.length - 1 && !/[,;.，；。、\n]\s*$/.test(clause)
        ? `${clause.replace(/[ \t]+$/, "")}, `
        : clause,
    )
    .join("");
  return trimClauseEdges(joined);
}

/**
 * 超限时的「按层压缩」（2026-10-04，修 R1 白工）：
 * 保住承重子句（GENRE／MOOD／INSTRUMENTATION 与 BPM／调性），由低到高整句丢弃低权重子句
 * （PRODUCTION → STRUCTURE → …），**绝不切在半句／半词**。只有「单一子句本身就长过上限」
 * 这种无法两全的极端情形才退回词界硬截（回报 hardCapped）。
 */
function compressByClause(
  text: string,
  limit: number,
  allowNewline: boolean,
): { text: string; droppedLayers: MusicLayerId[]; droppedOther: number; clauseCompressed: boolean; hardCapped: boolean } {
  const clauses = splitClauses(text);
  if (clauses.length <= 1) {
    // 没有可整句丢弃的子句边界：交给截断器（词界安全；仍不动半个单词）。
    return { text, droppedLayers: [], droppedOther: 0, clauseCompressed: false, hardCapped: countRunes(text) > limit };
  }
  let kept = clauses.map((clause, index) => ({ clause, index }));
  const droppedLayers: MusicLayerId[] = [];
  let droppedOther = 0;
  const joinKept = () => trimClauseEdges(kept.map((entry) => entry.clause).join(""));
  while (countRunes(joinKept()) > limit && kept.length > 1) {
    let pick = 0;
    for (let index = 1; index < kept.length; index += 1) {
      const weight = clauseWeight(kept[index].clause);
      const pickWeight = clauseWeight(kept[pick].clause);
      // 同权重丢后段（保留前段＝front-loading，CORE_01 §13）。
      if (weight < pickWeight || (weight === pickWeight && kept[index].index > kept[pick].index)) pick = index;
    }
    const layer = clauseLayer(kept[pick].clause);
    if (layer) droppedLayers.push(layer);
    else droppedOther += 1;
    kept = kept.filter((_entry, index) => index !== pick);
  }
  const compressed = joinKept();
  // 预算地板（2026-10-19 回归）：同权重时「丢后段」会一路丢到只剩首个短子句，实测
  // 15 runes（`Intro: soft pad`）／30 runes，genre／BPM／调性全没，远低于 60% cap。
  // 这种压缩结果比「保留压前文本再按边界硬截」更差 → 回退到压前文本，交给
  // truncateAtBoundary 用满预算，并如实置 hardCapped（不做整句丢弃，故不回报被丢层）。
  if (countRunes(compressed) < Math.ceil(limit * MIN_KEEP_RATIO) && countRunes(text) > limit) {
    return {
      text,
      droppedLayers: [],
      droppedOther: 0,
      clauseCompressed: false,
      hardCapped: true,
    };
  }
  return {
    text: compressed,
    droppedLayers,
    droppedOther,
    clauseCompressed: true,
    hardCapped: countRunes(compressed) > limit,
  };
}

/** 去掉硬截尾端的残留分隔（只动标点空白，不动文字）。 */
function trimBoundaryTail(text: string): string {
  return text.replace(/[\s,;.，；。、]+$/, "");
}

/**
 * 硬截：尽量用满预算。
 * ① 取前 cap runes；② 若 ≥60% cap 处存在子句边界 → 退到该边界（保语义完整）；
 * ③ 否则退到最后一个空白（拉丁文避免切断单词）；④ 无空白或空白退让会低于
 * 60% cap 时就地在 cap 处切（CJK 长串不为找边界大幅退让）。
 */
function truncateAtBoundary(text: string, limit: number, allowNewline: boolean): string {
  const chars = Array.from(text);
  const head = chars.slice(0, limit).join("");
  if (chars.length <= limit) return trimBoundaryTail(head);
  const floor = Math.ceil(limit * MIN_KEEP_RATIO);
  const boundaries = allowNewline ? LAYOUT_BOUNDARIES : CLAUSE_BOUNDARIES;
  let cut = -1;
  for (const boundary of boundaries) {
    const at = head.lastIndexOf(boundary);
    if (at > cut) cut = at;
  }
  if (cut < floor) {
    let space = -1;
    for (let index = head.length - 1; index >= floor; index -= 1) {
      if (/\s/.test(head[index])) {
        space = index;
        break;
      }
    }
    cut = space >= floor ? space : head.length;
  }
  return trimBoundaryTail(head.slice(0, cut));
}

interface AssembledPrompt {
  prompt: string;
  /** 实际留在 prompt 里的补层 id。 */
  kept: MusicLayerId[];
  /** 因上限被整层丢弃的补层 id。 */
  truncated: MusicLayerId[];
  /** 超限按层压缩核心时、整句丢弃的层 id。 */
  compressed: MusicLayerId[];
  /** 超限按层压缩时、整句丢弃的非层细节子句数。 */
  compressedOther: number;
  /** 是否真的走了按层压缩（整句丢弃）而非直接硬截。 */
  clauseCompressed: boolean;
  /** 是否在丢无可丢之后仍超限、走了子句边界硬截。 */
  hardCapped: boolean;
}

/**
 * 依上限组装：超限时先依 CORE_01 权重由低到高整层丢弃补层；仍超则对核心文本
 * **按层压缩**（整句丢低权重子句、保 BPM／调性与承重层，绝不切半句）；只有单一子句
 * 本身就长过上限才退回词界硬截。
 * 来源：CORE_01_STYLE.md:42 §1（genre 承重）、:965-973 §13（组装序＝权重序）、
 * DATA_FLOWMUSIC_2026-09.md:94 §2 row ⑦（上限存在）、:204 §5 checklist 4（压在 ~220 内）。
 */
function assembleWithLimit(
  core: string,
  fills: ReadonlyArray<{ id: MusicLayerId; text: string }>,
  limit: number | null,
  allowNewline: boolean,
): AssembledPrompt {
  let kept = fills.slice();
  const join = (parts: ReadonlyArray<{ text: string }>) =>
    [core, ...parts.map((part) => part.text)].filter(Boolean).join(" ");
  let text = join(kept);
  const truncated: MusicLayerId[] = [];
  const compressed: MusicLayerId[] = [];
  let compressedOther = 0;
  let clauseCompressed = false;
  let hardCapped = false;
  if (limit === null) {
    return { prompt: text, kept: kept.map((fill) => fill.id), truncated, compressed, compressedOther, clauseCompressed, hardCapped };
  }
  while (countRunes(text) > limit && kept.length > 0) {
    let lowest = 0;
    for (let index = 1; index < kept.length; index += 1) {
      if (LAYER_WEIGHT[kept[index].id] < LAYER_WEIGHT[kept[lowest].id]) lowest = index;
    }
    truncated.push(kept[lowest].id);
    kept = kept.filter((_fill, index) => index !== lowest);
    text = join(kept);
  }
  if (countRunes(text) > limit) {
    const byClause = compressByClause(text, limit, allowNewline);
    compressed.push(...byClause.droppedLayers);
    compressedOther = byClause.droppedOther;
    clauseCompressed = byClause.clauseCompressed;
    text = byClause.text;
    // 单一子句仍长过上限＝无法两全，退回词界安全硬截（尽量不切断单词；如实标记）。
    if (byClause.hardCapped) {
      text = truncateAtBoundary(text, limit, allowNewline);
      hardCapped = true;
    }
  }
  return { prompt: text, kept: kept.map((fill) => fill.id), truncated, compressed, compressedOther, clauseCompressed, hardCapped };
}

/**
 * 优化一段音乐 prompt。纯函数、无副作用、同步执行——零成本零延迟。
 * 输入已 trim 过。与 `invisible-prompt-director` 的规则层同构：侦测槽位 →
 * anti-slop → 伪标签剥除 → mood 修剪 → 通路硬规则 → 补层 → 长度上限。
 */
export function directMusicPrompt(rawPrompt: string, options: MusicDirectorOptions = {}): MusicDirectorResult {
  const channel = options.channel ?? "lyria";
  // 控制字元先清（NUL/VT 等混入 prompt 会污染上游；保留 \t \n \r）——所有通路受益。
  const sanitized = rawPrompt.replace(CONTROL_CHARS, " ");
  const user = sanitized.trim();
  const layers = detectLayers(user);
  if (!user) {
    // 保持判定对象＝`user`（此处为空串）：空输入在 `untagged` 计算出之前就早退，且没有
    // 任何声明可判——evaluatePromptChecks 只会按 options 走、对空文本回跳过，无空转可言。
    return { prompt: user, layers, applied: [], warnings: [], truncated: [], checks: evaluatePromptChecks(user, options) };
  }

  const applied: string[] = [];
  const warnings: string[] = [];
  if (sanitized !== rawPrompt) applied.push("strip-control-chars");

  // 1. anti-slop：缺陷词／空泛片语 → 具体语汇；没有替换目标的空词只回报。
  const slopped = replaceAll(user, SLOP_WORDS);
  if (slopped !== user) applied.push("anti-slop");
  for (const word of findEmptyWords(slopped)) {
    warnings.push(
      `anti-slop: "${word}" carries no musical information and the library gives no concrete substitute (CORE_01_STYLE §1 Layer 2 · §4)`,
    );
  }

  // 2. 伪标签剥除＋明文噪声（JSON/HTML/代码围篱）剥除：假参数改写成散文或删除。
  const detagged = replaceAll(slopped, DEAD_PLAIN_TAGS);
  const denoised = replaceAll(detagged, MARKUP_NOISE);
  if (denoised !== detagged) applied.push("strip-markup");
  const tagRewritten = rewritePseudoTags(denoised);
  const rewroteTags = tagRewritten !== denoised;
  const untagged = rewroteTags || denoised !== detagged ? tidySeparators(tagRewritten) : detagged;
  if (rewroteTags) applied.push("strip-pseudo-tags");

  // 3. MOOD ≤2：多的移除，并如实回报（相容性库内无对照表，只能报数量）。
  const moods = findMoodWords(untagged);
  let shaped = untagged;
  if (moods.length > 2) {
    shaped = tidySeparators(trimExtraMoods(untagged, moods));
    applied.push("trim-mood");
    warnings.push(
      `mood: ${moods.length} mood words (${moods.join(", ")}) — keep one or two compatible ones (CORE_01_STYLE §1 Layer 2 · §4; CORE_03_DIAGNOSE §2 CHECK 4)`,
    );
  }

  // 4. 通路硬规则。
  let core = shaped;
  let limit: number | null = null;
  let allowNewline = true;
  if (channel === "flowmusic") {
    const stripped = stripTimestamps(core);
    if (stripped !== core) applied.push("strip-timestamps");
    core = stripped;
    // 保版面判准＝明示有歌词，**或**文本自带歌词／段落标签（含 `[Verse 1]`／`[Chorus: …]`）。
    // 旧版写 `??`：生产恒传 Boolean(lyrics)，明示 false 时右侧永不触发＝自动侦测成死码，
    // 文件教 agent「写 [Verse] 走 3000」却实际走 220 被切（2026-10-04 组 9-7）。
    if (options.hasLyrics || hasLyricsMarker(core)) {
      // 保版面分支：换行与标点保留，上限 3000 runes。
      limit = CHANNEL_LIMITS.flowmusicLayout;
    } else {
      // 平面分支：压成单行，上限 220 runes。
      const collapsed = collapseToSingleLine(core);
      if (collapsed !== core) applied.push("collapse-single-line");
      core = collapsed;
      allowNewline = false;
      limit = CHANNEL_LIMITS.flowmusicFlat;
    }
  } else if (channel === "yue2") {
    // YuE2 硬规则（依冻结合约的能力边界，2026-09-18）：
    //  ① 时间戳剥除：`[0:00 - 0:10]` 只有 Lyria 认，YuE2 不支援时间戳结构控制 → 剥掉
    //     （用同一个 stripTimestamps，只吃数字时间码与旧式 (0-15s)）。
    //  ② [Verse]/[Chorus] 段落标签**保留**：那是 YuE2 歌词栏的必需语法，不是伪标签，
    //     stripTimestamps 不动它（它只认数字时间码），标签原样穿过。
    //  ③ style 是散文描述：允许换行，不做 collapse-single-line、不套 220 平面分支。
    //  ④ 上限 yue2Style＝600 runes 显存预算（依据见 CHANNEL_LIMITS 注释）。
    const stripped = stripTimestamps(core);
    if (stripped !== core) applied.push("strip-timestamps");
    core = stripped;
    limit = CHANNEL_LIMITS.yue2Style;
  }

  // 4.5 决定性参数前置（仅 flowmusic，2026-10-04 G3）：把 BPM／调性／和弦进行／段落
  // 结构整句前移到居首的 GENRE 之后，避免它们落在尾段被上游的 sound_prompt 摘要整层
  // 丢弃（G1 实测：key of C major 整丢、STRUCTURE 整层丢，仅句尾 BPM 被搬到回吐串末尾）。
  if (channel === "flowmusic") {
    const frontLoaded = frontLoadDecidingParams(core);
    if (frontLoaded !== core) {
      core = frontLoaded;
      applied.push("front-load-params");
    }
  }

  // 5. 缺层补中性指令（不替用户决定流派／乐器／唱的人），再依上限组装。
  const fills: Array<{ id: MusicLayerId; text: string }> = [];
  for (const id of MUSIC_LAYER_IDS) {
    if (!layers[id]) fills.push({ id, text: layerFill(id, options.durationSeconds) });
  }
  // 无人声宣告是承重子句（2026-10-04 F2）：它常被 buildToolPrompt 直接接在用户文本尾端、
  // 与正文融成同一子句，按权重丢子句仍可能把它一起硬截掉。故这里先把它整体抽出，
  // 压缩预算扣掉它，压缩后再原样接回——保证「纯器乐」宣告不会在压缩中蒸发。
  let protectedDeclaration = "";
  let body = core;
  if (limit !== null) {
    const declaration = core.match(INSTRUMENTAL_DECLARATION_TAIL);
    if (declaration) {
      protectedDeclaration = declaration[1].trim();
      body = core.slice(0, core.length - declaration[0].length);
    }
  }
  const bodyLimit =
    limit === null ? null : Math.max(0, limit - (protectedDeclaration ? countRunes(protectedDeclaration) + 1 : 0));
  const assembled = assembleWithLimit(body, fills, bodyLimit, allowNewline);
  if (protectedDeclaration) {
    assembled.prompt = assembled.prompt ? `${assembled.prompt} ${protectedDeclaration}` : protectedDeclaration;
  }
  for (const id of assembled.kept) applied.push(`fill-${id}`);
  if (assembled.clauseCompressed) {
    applied.push(`compress-${limit}-by-layer`);
  }
  if (assembled.hardCapped) {
    applied.push(`truncate-${limit}-hard`);
  }
  // 压缩 warning 由**实际被丢的层**与**最终 prompt 的实际内容**反推，绝不写死成功句
  // （2026-10-04 F2：旧版在 genre 被丢、句子被硬截时仍宣称「保住了流派…不做半句截断」）。
  // 同层可能有多条子句（被丢的子句命中 genre，但另一条同层子句仍在场）：只有最终
  // prompt 里再也找不到的层才算「被丢」，否则回执会把仍在场的 genre 报成截断
  // （2026-10-19：丢后段时每条 folk 子句都记 genre，实际输出仍有 folk）。
  const retained = describeRetainedLayers(assembled.prompt);
  const droppedCompressed = assembled.compressed.filter((id) => !retained.layers.includes(id));
  if (assembled.clauseCompressed || assembled.hardCapped) {
    const droppedLayers = [...new Set(droppedCompressed)];
    const dropDesc =
      droppedLayers.length > 0 || assembled.compressedOther > 0
        ? "，已按层权重整句丢弃低优先子句" +
          (droppedLayers.length > 0 ? `（涉及层：${droppedLayers.join("、")}）` : "") +
          (assembled.compressedOther > 0 ? `及 ${assembled.compressedOther} 条非层细节子句` : "")
        : "，按层压缩不足以在不切半句的前提下用满预算";
    const keptText = describeRetainedParts(assembled.prompt);
    warnings.push(
      `长度压缩：提示词超出本通路 ${limit} runes 硬上限${dropDesc}。` +
        `最终 prompt 实际保留：${keptText.length > 0 ? keptText.join("、") : "（无完整子句）"}。` +
        (assembled.hardCapped ? "尾端已按边界硬截，结尾可能不完整。" : "未做半句截断。"),
    );
  }

  // 6. 侦测到但无法确定性修补的缺口（如实回报，不虚报）。
  if (layers.genre && !isGenreFrontLoaded(user)) {
    warnings.push(
      "front-loading: genre is present but not in the opening clause (CORE_03_DIAGNOSE §2 CHECK 1; CORE_01_STYLE §1 Layer 1)",
    );
  }
  const instrumentCount = countDistinctInstruments(user);
  if (instrumentCount > 4) {
    warnings.push(
      `instrumentation: ${instrumentCount} instruments named — two or three hero instruments plus one texture word (CORE_01_STYLE §5; CORE_03_DIAGNOSE §2 CHECK 3)`,
    );
  }
  // 速度／调性矛盾或非法值（2026-10-04 F2 实测 5-3/5-4/5-5）：原样送出会互相打架，如实警告不静默。
  const bpmValues = [
    ...new Set((shaped.match(/\b(\d{2,3})\s*bpm\b/gi) ?? []).map((match) => match.replace(/\s*bpm/i, "").trim())),
  ];
  if (bpmValues.length > 1) {
    warnings.push(
      `production: ${bpmValues.length} conflicting BPM values present (${bpmValues.join(", ")}) — keep a single tempo (CORE_01_STYLE §9; CORE_03_DIAGNOSE §2 CHECK 6)`,
    );
  }
  const keyPhrases = [...shaped.matchAll(/\bkey of ([^,;.，；。]{1,24})/gi)].map((match) => match[1].trim());
  const invalidKeys = [
    ...new Set(keyPhrases.filter((key) => !/^[A-Ga-g](?:\s*(?:#|b|sharp|flat))?\s*(?:major|minor|maj|min)?$/i.test(key))),
  ];
  if (invalidKeys.length > 0) {
    warnings.push(
      `production: unrecognized key spelling (${invalidKeys.join(", ")}) — name the key as "key of A minor" (CORE_01_STYLE §9; CORE_03_DIAGNOSE §2 CHECK 6)`,
    );
  }

  return {
    prompt: assembled.prompt,
    layers,
    applied,
    warnings,
    truncated: [...new Set([...assembled.truncated, ...droppedCompressed])],
    // P0-11：结构化校验账随回执一并输出。判定对象＝**伪标签改写后的提交侧文本** `untagged`
    // （原始 `user` 里 `[BPM: 146]` 还没变成可读的 `146 BPM`，判定必然空转；而最终
    // `assembled.prompt` 会被截断/压缩，反而制造新的假跳过）。
    checks: evaluatePromptChecks(untagged, options),
    ...(assembled.clauseCompressed || assembled.hardCapped
      ? {
          compressedClauses: assembled.compressed.length + assembled.compressedOther,
          compressedLayers: [...new Set(droppedCompressed)],
        }
      : {}),
    ...(assembled.hardCapped ? { hardTruncated: true } : {}),
  };
}
