import { CHANNEL_LIMITS, CLAUSE_BOUNDARIES, CONTROL_CHARS, DEAD_PLAIN_TAGS, INSTRUMENTAL_DECLARATION_PATTERN, INSTRUMENTAL_DECLARATION_TAIL, LAYER_WEIGHT, LAYOUT_BOUNDARIES, MARKUP_NOISE, MIN_KEEP_RATIO, MUSIC_LAYER_IDS, MUSIC_LAYER_PATTERNS, SECTION_DECIDING_PATTERN, SLOP_WORDS, TEMPO_KEY_PATTERN, collapseToSingleLine, countDistinctInstruments, countRunes, describeRetainedParts, detectLayers, evaluatePromptChecks, findEmptyWords, findMoodWords, hasLyricsMarker, isGenreFrontLoaded, layerFill, replaceAll, rewritePseudoTags, stripTimestamps, tidySeparators, trimExtraMoods } from "./music_prompt_director_defs";
import type { MusicDirectorOptions, MusicDirectorResult, MusicLayerId } from "./music_prompt_director_defs";

/** 子句切分（保留每段尾端分隔符，重建时可逐字还原）；分隔符同硬截退让点。 */
const CLAUSE_SPLIT_PATTERN = /[^,;.，；。、\n]+[,;.，；。、\n]?/g;

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
  // 决定性参数（速度／调性／和弦进行／段落结构）＝承重：压缩不得把它们当低权重层丢掉。
  if (TEMPO_KEY_PATTERN.test(clause) || SECTION_DECIDING_PATTERN.test(clause)) return 7;
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
      index < ordered.length - 1 && !/[,;.，；。、]\s*$/.test(clause)
        ? `${clause.replace(/\s+$/, "")}, `
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
  if (assembled.clauseCompressed || assembled.hardCapped) {
    const droppedLayers = [...new Set(assembled.compressed)];
    const dropDesc =
      droppedLayers.length > 0 || assembled.compressedOther > 0
        ? "，已按层权重整句丢弃低优先子句" +
          (droppedLayers.length > 0 ? `（涉及层：${droppedLayers.join("、")}）` : "") +
          (assembled.compressedOther > 0 ? `及 ${assembled.compressedOther} 条非层细节子句` : "")
        : "，且已无更低优先级的整句子句可丢";
    const keptText = describeRetainedParts(assembled.prompt);
    warnings.push(
      `长度压缩：提示词超出本通路 ${limit} runes 硬上限${dropDesc}。` +
        `最终 prompt 实际保留：${keptText.length > 0 ? keptText.join("、") : "（无完整子句）"}。` +
        (assembled.hardCapped ? "单一子句仍超限，尾端已硬截，结尾可能不完整。" : "未做半句截断。"),
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
    truncated: [...new Set([...assembled.truncated, ...assembled.compressed])],
    // P0-11：结构化校验账随回执一并输出。判定对象＝**伪标签改写后的提交侧文本** `untagged`
    // （原始 `user` 里 `[BPM: 146]` 还没变成可读的 `146 BPM`，判定必然空转；而最终
    // `assembled.prompt` 会被截断/压缩，反而制造新的假跳过）。
    checks: evaluatePromptChecks(untagged, options),
    ...(assembled.clauseCompressed || assembled.hardCapped
      ? {
          compressedClauses: assembled.compressed.length + assembled.compressedOther,
          compressedLayers: [...new Set(assembled.compressed)],
        }
      : {}),
    ...(assembled.hardCapped ? { hardTruncated: true } : {}),
  };
}
