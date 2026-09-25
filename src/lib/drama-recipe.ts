// 短剧配方（drama-recipe）：小说→短剧五段管线的确定性部分（纯函数）。
//
// 吞自 eternityspring/shuohao-skills（Apache 2.0）：outline/cast/art/script/storyboard
// 五段 JSON 接力收敛为本平台「一条配方」（契约见 docs/skills/drama-recipe.md）。
// 资产引用复用 character-cards 卡体系（C/P/PR 编号惯例对应 character/scene/prop 卡 id），
// 锁定注入复用 applyCharacterCards（卡 id 序稳定拼接、幂等），不建第二套注入。
//
// 「能算的不让模型猜」：
//   - 分镜秒数 → deriveDurations（台词按语速折算，总时长=求和不存冗余）
//   - 批次切分 → storyboardToBatchTasks（每个分镜一段一生成任务）
//   - 资产清单 → deriveRequiredAssets（引用卡 id 全集，代码可复验）
// 模型只产出语义字段；本文件所有函数零副作用、零 IO。

import { applyCharacterCards, mergeTokenReferencedCards } from "./character-cards";
import type { CharacterCard, CharacterCardKind, CharacterCardReferenceImage } from "./character-cards";

// ─────────────────────────────────────────── 段名与常量

export const DRAMA_SEGMENT_NAMES = ["outline", "cast", "art", "script", "storyboard"] as const;
export type DramaSegmentName = (typeof DRAMA_SEGMENT_NAMES)[number];

/** 台词折算默认语速（字/秒），可用参数覆盖。 */
export const DEFAULT_SPEECH_RATE = 4;

const MAX_TEXT_LENGTH = 4000; // 单字段文本上限
const MAX_SHORT_TEXT_LENGTH = 200;
const MAX_EPISODES = 200;
const MAX_ENTRIES = 200; // cast/art 条目上限
const MAX_SCENES = 200;
const MAX_BEATS = 400;
const MAX_SHOTS = 400;
const MAX_CARD_REFS_PER_SHOT = 16; // 单分镜引用卡 id 上限（角色/场景/道具各算一次，每栏各自截断）

// ─────────────────────────────────────────── 宽松清洗小工具

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= max ? clean : null;
}

function boundedStringArray(value: unknown, maxItems: number, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => boundedString(item, max))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems);
}

function boundedNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 从段对象里宽松提取条目数组：段本身是数组，或常见键名下的数组。 */
function looseEntries(raw: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  return [];
}

// ─────────────────────────────────────────── 五段类型

export interface DramaOutlineEpisode {
  /** 集号（1 起整数；集数=episodes.length，不另存冗余计数字段）。 */
  ep: number;
  synopsis: string;
}

export interface DramaOutlineSegment {
  title: string | null;
  logline: string | null;
  episodes: DramaOutlineEpisode[];
  /** 资产清单：管线引用的卡 id 全集（代码可复验，不由模型凭空列）。 */
  assetCardIds: string[];
}

export interface DramaCastEntry {
  /** character-cards 卡 id（kind=character，惯例 C 前缀编号）。 */
  cardId: string;
  name: string;
  /** 形象提示词（建议同步为该卡 prompt 锁定片段）。 */
  appearancePrompt: string;
  /** 音色提示词（对接 TTS）。 */
  voicePrompt: string | null;
}

export interface DramaArtEntry {
  /** character-cards 卡 id（kind=scene，惯例 P 前缀编号）。 */
  cardId: string;
  name: string;
  /** 场景/道具提示词。 */
  prompt: string;
  /** 光照/状态变体。 */
  variants: string[];
}

export type DramaBeatType = "action" | "dialogue";

export interface DramaScriptBeat {
  type: DramaBeatType;
  /** dialogue 的角色名/卡 id；action 为 null。 */
  speaker: string | null;
  text: string;
}

export interface DramaScriptScene {
  /** 场次编号（如 S01）。 */
  sceneId: string;
  heading: string | null;
  beats: DramaScriptBeat[];
}

export interface DramaScriptSegment {
  /** 集号（如 E01）。 */
  episode: string | null;
  scenes: DramaScriptScene[];
}

export interface DramaStoryboardShot {
  /** 分镜编号（如 E01-01）。 */
  shotId: string;
  /** 段提示词（画面描述，锁定片段由代码按卡注入）。 */
  prompt: string;
  /** 引用角色卡 id（C 编号）。 */
  characterCardIds: string[];
  /** 引用场景卡 id（P 编号）。 */
  sceneCardIds: string[];
  /**
   * 引用道具卡 id（2026-09-24 新增；`kind==="prop"` 的卡，惯例 PR 前缀）。
   * 可選：舊分鏡 JSON 沒有此欄（缺省＝無道具引用，零回歸）。
   */
  propCardIds?: string[];
  /** 段级负面词（与卡负面词合并）。 */
  negativePrompt: string | null;
  size: string | null;
  /** 外部给定秒数；未给则由 deriveDurations 从 script 台词折算。 */
  durationSeconds: number | null;
}

export interface DramaStoryboardSegment {
  shots: DramaStoryboardShot[];
}

export interface NormalizedDramaPipeline {
  outline: DramaOutlineSegment | null;
  cast: DramaCastEntry[] | null;
  art: DramaArtEntry[] | null;
  script: DramaScriptSegment | null;
  storyboard: DramaStoryboardSegment | null;
  /** 缺失或清洗后为空而被跳过的段（按管線 canonical 顺序，明说跳过）。 */
  skipped: DramaSegmentName[];
}

// ─────────────────────────────────────────── 段级清洗

function normalizeOutline(raw: unknown): DramaOutlineSegment | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const episodes = looseEntries(obj.episodes ?? obj.eps, ["episodes", "eps", "items"])
    .map((item): DramaOutlineEpisode | null => {
      if (!item || typeof item !== "object") return null;
      const e = item as Record<string, unknown>;
      const ep = boundedNumber(e.ep ?? e.index ?? e.no);
      const synopsis = boundedString(e.synopsis ?? e.summary ?? e.text, MAX_TEXT_LENGTH);
      if (ep === null || ep < 1 || !synopsis) return null;
      return { ep: Math.floor(ep), synopsis };
    })
    .filter((item): item is DramaOutlineEpisode => item !== null)
    .slice(0, MAX_EPISODES);
  if (episodes.length === 0) return null;
  return {
    title: boundedString(obj.title, MAX_SHORT_TEXT_LENGTH),
    logline: boundedString(obj.logline, MAX_TEXT_LENGTH),
    episodes,
    assetCardIds: boundedStringArray(obj.assetCardIds ?? obj.assets, MAX_ENTRIES, MAX_SHORT_TEXT_LENGTH),
  };
}

function normalizeCast(raw: unknown): DramaCastEntry[] | null {
  const entries = looseEntries(raw, ["characters", "entries", "cast", "items"])
    .map((item): DramaCastEntry | null => {
      if (!item || typeof item !== "object") return null;
      const e = item as Record<string, unknown>;
      const cardId = boundedString(e.cardId ?? e.card_id ?? e.id, MAX_SHORT_TEXT_LENGTH);
      const name = boundedString(e.name, MAX_SHORT_TEXT_LENGTH);
      if (!cardId || !name) return null;
      return {
        cardId,
        name,
        appearancePrompt: boundedString(e.appearancePrompt ?? e.appearance_prompt ?? e.prompt, MAX_TEXT_LENGTH) ?? "",
        voicePrompt: boundedString(e.voicePrompt ?? e.voice_prompt, MAX_TEXT_LENGTH),
      };
    })
    .filter((item): item is DramaCastEntry => item !== null)
    .slice(0, MAX_ENTRIES);
  return entries.length > 0 ? entries : null;
}

function normalizeArt(raw: unknown): DramaArtEntry[] | null {
  const entries = looseEntries(raw, ["scenes", "props", "entries", "items", "art"])
    .map((item): DramaArtEntry | null => {
      if (!item || typeof item !== "object") return null;
      const e = item as Record<string, unknown>;
      const cardId = boundedString(e.cardId ?? e.card_id ?? e.id, MAX_SHORT_TEXT_LENGTH);
      const name = boundedString(e.name, MAX_SHORT_TEXT_LENGTH);
      if (!cardId || !name) return null;
      return {
        cardId,
        name,
        prompt: boundedString(e.prompt ?? e.description, MAX_TEXT_LENGTH) ?? "",
        variants: boundedStringArray(e.variants, 16, MAX_SHORT_TEXT_LENGTH),
      };
    })
    .filter((item): item is DramaArtEntry => item !== null)
    .slice(0, MAX_ENTRIES);
  return entries.length > 0 ? entries : null;
}

/** 节拍类型宽松归一：中英别名 → 归一；未知但有 speaker 推 dialogue，否则 action。 */
function toBeatType(value: unknown, hasSpeaker: boolean): DramaBeatType {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["dialogue", "line", "d", "台词", "对白"].includes(v)) return "dialogue";
    if (["action", "beat", "a", "动作", "行动"].includes(v)) return "action";
  }
  return hasSpeaker ? "dialogue" : "action";
}

function normalizeScript(raw: unknown): DramaScriptSegment | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const scenes = looseEntries(obj.scenes, ["scenes", "sceneList", "items"])
    .map((item): DramaScriptScene | null => {
      if (!item || typeof item !== "object") return null;
      const s = item as Record<string, unknown>;
      const sceneId = boundedString(s.sceneId ?? s.scene_id ?? s.id, MAX_SHORT_TEXT_LENGTH);
      if (!sceneId) return null;
      const beats = looseEntries(s.beats, ["beats", "flow", "items"])
        .map((beat): DramaScriptBeat | null => {
          if (!beat || typeof beat !== "object") return null;
          const b = beat as Record<string, unknown>;
          const text = boundedString(b.text ?? b.line ?? b.content, MAX_TEXT_LENGTH);
          if (!text) return null;
          const speaker = boundedString(b.speaker ?? b.character ?? b.who, MAX_SHORT_TEXT_LENGTH);
          return { type: toBeatType(b.type, speaker !== null), speaker, text };
        })
        .filter((beat): beat is DramaScriptBeat => beat !== null)
        .slice(0, MAX_BEATS);
      if (beats.length === 0) return null;
      return { sceneId, heading: boundedString(s.heading ?? s.title, MAX_SHORT_TEXT_LENGTH), beats };
    })
    .filter((scene): scene is DramaScriptScene => scene !== null)
    .slice(0, MAX_SCENES);
  if (scenes.length === 0) return null;
  return { episode: boundedString(obj.episode ?? obj.ep, MAX_SHORT_TEXT_LENGTH), scenes };
}

function normalizeStoryboard(raw: unknown): DramaStoryboardSegment | null {
  const shots = looseEntries(raw, ["shots", "storyboard", "frames", "items"])
    .map((item): DramaStoryboardShot | null => {
      if (!item || typeof item !== "object") return null;
      const s = item as Record<string, unknown>;
      const shotId = boundedString(s.shotId ?? s.shot_id ?? s.id, MAX_SHORT_TEXT_LENGTH);
      const prompt = boundedString(s.prompt ?? s.description, MAX_TEXT_LENGTH);
      if (!shotId || !prompt) return null;
      const characterCardIds = boundedStringArray(s.characterCardIds ?? s.character_card_ids ?? s.characters, MAX_CARD_REFS_PER_SHOT, MAX_SHORT_TEXT_LENGTH);
      const sceneCardIds = boundedStringArray(s.sceneCardIds ?? s.scene_card_ids ?? s.scenes, MAX_CARD_REFS_PER_SHOT, MAX_SHORT_TEXT_LENGTH);
      const propCardIds = boundedStringArray(s.propCardIds ?? s.prop_card_ids ?? s.props, MAX_CARD_REFS_PER_SHOT, MAX_SHORT_TEXT_LENGTH);
      const duration = boundedNumber(s.durationSeconds ?? s.duration_seconds ?? s.duration);
      return {
        shotId,
        prompt,
        characterCardIds,
        sceneCardIds,
        propCardIds,
        negativePrompt: boundedString(s.negativePrompt ?? s.negative_prompt, MAX_TEXT_LENGTH),
        size: boundedString(s.size, 40),
        durationSeconds: duration !== null && duration > 0 ? duration : null,
      };
    })
    .filter((shot): shot is DramaStoryboardShot => shot !== null)
    .slice(0, MAX_SHOTS);
  return shots.length > 0 ? { shots } : null;
}

/**
 * 五段 JSON 宽松清洗（缺段容忍，明说跳过）：
 *   - 每段独立清洗，缺失或清洗后为空 → 该段为 null 且名字进 skipped
 *   - 不抛错：单段脏数据不拖垮整条管线，有效条目照常保留
 */
export function normalizeDramaPipeline(payload: unknown): NormalizedDramaPipeline {
  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const outline = normalizeOutline(obj.outline);
  const cast = normalizeCast(obj.cast);
  const art = normalizeArt(obj.art);
  const script = normalizeScript(obj.script);
  const storyboard = normalizeStoryboard(obj.storyboard);
  const present: Record<DramaSegmentName, boolean> = {
    outline: outline !== null,
    cast: cast !== null,
    art: art !== null,
    script: script !== null,
    storyboard: storyboard !== null,
  };
  const skipped = DRAMA_SEGMENT_NAMES.filter((name) => !present[name]);
  return { outline, cast, art, script, storyboard, skipped };
}

// ─────────────────────────────────────────── 秒数折算（deriveDurations）

export interface DramaBeatDuration {
  /** 该拍在所属场次 beats 数组中的下标。 */
  beatIndex: number;
  type: DramaBeatType;
  speaker: string | null;
  /** 台词折算秒数；动作拍为 0（本配方只折算台词）。 */
  seconds: number;
}

export interface DramaSceneDuration {
  sceneId: string;
  /** 场内各拍秒数之和。 */
  seconds: number;
  beats: DramaBeatDuration[];
}

export interface DramaDurationReport {
  /** 实际使用的语速（字/秒）。 */
  speechRate: number;
  scenes: DramaSceneDuration[];
  /** 总时长 = 各场求和（派生值，不在输入 JSON 里冗余存储）。 */
  totalSeconds: number;
}

/**
 * 台词按语速折算秒数（默认 4 字/秒，可覆盖）：
 *   - 单条台词秒数 = max(1, ceil(字数 / 语速))——最短 1 秒（短句也有呼吸位）
 *   - 动作拍不折算（0 秒），只保留节拍位
 *   - 字数按 Unicode 码点计（Array.from），中文安全
 *   - 输入宽松：直接喂原始 script 段，内部走同一清洗
 *   - 无有效场次 → null（调用方决定如何降级）
 */
export function deriveDurations(script: unknown, options?: { speechRate?: number }): DramaDurationReport | null {
  const normalized = normalizeScript(script);
  if (!normalized) return null;
  const rate = typeof options?.speechRate === "number" && Number.isFinite(options.speechRate) && options.speechRate > 0
    ? options.speechRate
    : DEFAULT_SPEECH_RATE;
  const scenes: DramaSceneDuration[] = normalized.scenes.map((scene) => {
    const beats: DramaBeatDuration[] = scene.beats.map((beat, beatIndex) => ({
      beatIndex,
      type: beat.type,
      speaker: beat.speaker,
      seconds:
        beat.type === "dialogue"
          ? Math.max(1, Math.ceil(Array.from(beat.text).length / rate))
          : 0,
    }));
    return { sceneId: scene.sceneId, seconds: beats.reduce((sum, b) => sum + b.seconds, 0), beats };
  });
  return {
    speechRate: rate,
    scenes,
    totalSeconds: scenes.reduce((sum, s) => sum + s.seconds, 0),
  };
}

// ─────────────────────────────────────────── 卡解析与批次切分（storyboardToBatchTasks）

export interface DramaBatchTask {
  shotId: string;
  /** 段提示词 + 卡锁定片段前缀（卡 id 序稳定拼接，applyCharacterCards 注入、幂等）。 */
  prompt: string;
  /** 引用卡的参考图（url 去重、角色保留；卡 id 序）。 */
  referenceImages: CharacterCardReferenceImage[];
  /** 段级负面词 + 卡负面词合并（", " 连接、去重）；无则 null。 */
  negativePrompt: string | null;
  /** 引用卡的 LoRA 关联合并去重（卡 id 序）；generate_image 装配时仍受单选铁律约束。 */
  loraIds: string[];
  size: string | null;
  durationSeconds: number | null;
  /** 引用了不存在或种类不符的卡 id：任务不可提交（needs_asset），先补资产再重切。 */
  needsAsset: boolean;
  missingCardIds: string[];
}

/** 负面词合并：", "/"，" 分词、trim、去重、", " 连接。 */
function mergeNegativePrompts(...parts: Array<string | null | undefined>): string | null {
  const out: string[] = [];
  for (const part of parts) {
    for (const item of (part ?? "").split(/[,，]/)) {
      const clean = item.trim();
      if (clean && !out.includes(clean)) out.push(clean);
    }
  }
  return out.length > 0 ? out.join(", ") : null;
}

/**
 * 解析引用卡 id → 卡实体（`found`）/ 未解析（`missing`，任务不可提交）。
 * `expectedKind` 認三族：`"character"`（角色）/ `"scene"`（場景）/ `"prop"`（道具）。
 * 2026-09-24：`"prop"` 由本參數的聯集加入（道具卡與角色/場景卡走**逐字同一條**解析規則，
 * 不另立第二套）；`CharacterCardKind` 本體由 character-cards.ts 擁有，本檔不越權改它。
 */
function resolveCardRefs(
  ids: string[],
  byId: Map<string, CharacterCard>,
  expectedKind: CharacterCardKind | "prop",
): { found: CharacterCard[]; missing: string[] } {
  const found: CharacterCard[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const card = byId.get(id);
    // C/P/PR 编号惯例：characterCardIds 必须解析到 character 卡、sceneCardIds 到 scene 卡、
    // propCardIds 到 prop 卡；id 存在但种类不符视同资产缺失（needs_asset），不做静默替换。
    if (!card || card.kind !== expectedKind) missing.push(id);
    else found.push(card);
  }
  return { found, missing };
}

/**
 * 分镜段 → 生成任务参数数组（批次切分由代码推导，每个分镜一任务）：
 *   - prompt = 段提示词 + 被引用卡锁定片段（applyCharacterCards：卡 id 升序前缀、幂等）
 *   - referenceImages = 被引用卡参考图（url 去重、角色保留）
 *   - negativePrompt = 段级负面词 + 卡负面词合并
 *   - 段提示词里的 `@[種類:名]` token 會就地解析：命中**卡庫全量**（不只分鏡宣告的卡）時
 *     併入注入集（mergeTokenReferencedCards）——卡在庫即可被引用，不必先手動鎖定
 *   - propCardIds 的道具卡与角色/场景卡**同批**进 applyCharacterCards（同一把注入尺，不另开通道）
 *   - 引用卡 id 不存在或种类不符 → 该任务 needsAsset=true + missingCardIds，
 *     已解析卡照常注入（补齐资产后重切结果稳定）
 *   - 输入宽松：直接喂原始 storyboard 段；cards 来自 character-card-store 的当前态
 */
export function storyboardToBatchTasks(storyboard: unknown, cards: CharacterCard[]): DramaBatchTask[] {
  const normalized = normalizeStoryboard(storyboard);
  if (!normalized) return [];
  const byId = new Map(cards.map((card) => [card.id, card]));
  return normalized.shots.map((shot) => {
    const characterRefs = resolveCardRefs(shot.characterCardIds, byId, "character");
    const sceneRefs = resolveCardRefs(shot.sceneCardIds, byId, "scene");
    const propRefs = resolveCardRefs(shot.propCardIds ?? [], byId, "prop");
    const missingCardIds = [...characterRefs.missing, ...sceneRefs.missing, ...propRefs.missing];
    // 卡 id 序稳定拼接：applyCharacterCards 内部按 id 升序注入，与传入顺序无关。
    // 顺序照写 character → scene → prop（只影响可读性：applyCharacterCards 内部本就按 id 升序重排）。
    const appliedCards = [...characterRefs.found, ...sceneRefs.found, ...propRefs.found];
    // 本段 prompt token 就地解析（2026-09-25）：卡在庫即可被 `@[種類:名]` 引用，不必先手動鎖定。
    // 判準/聯集全在 mergeTokenReferencedCards（純函式）；零 token／全未命中＝回同一陣列參考，
    // 故既有「只注入分鏡宣告的卡」行為逐位元不變。
    const injectedCards = mergeTokenReferencedCards(appliedCards, cards, shot.prompt);
    const applied = applyCharacterCards(shot.prompt, injectedCards);
    const loraIds: string[] = [];
    for (const card of injectedCards) {
      for (const loraId of card.loraIds ?? []) {
        if (!loraIds.includes(loraId)) loraIds.push(loraId);
      }
    }
    return {
      shotId: shot.shotId,
      prompt: applied.prompt,
      referenceImages: applied.references,
      negativePrompt: mergeNegativePrompts(shot.negativePrompt, applied.negativePrompt),
      loraIds,
      size: shot.size,
      durationSeconds: shot.durationSeconds,
      needsAsset: missingCardIds.length > 0,
      missingCardIds,
    };
  });
}

/**
 * 资产清单（代码推导）：分镜段引用的卡 id 全集，id 升序去重。
 * 与 outline.assetCardIds 对账：模型列的清单必须 ⊆ 本函数结果，多出的即凭空捏造。
 */
export function deriveRequiredAssets(storyboard: unknown): string[] {
  const normalized = normalizeStoryboard(storyboard);
  if (!normalized) return [];
  const ids = new Set<string>();
  for (const shot of normalized.shots) {
    for (const id of [...shot.characterCardIds, ...shot.sceneCardIds, ...(shot.propCardIds ?? [])]) ids.add(id);
  }
  return [...ids].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}
