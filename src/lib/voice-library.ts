// 结构化语音库（P1-11／对称差 D33「语音库有结构化属性」）。
//
// 对标口径（唯一）：`Dramagic对称差-全站-0928.md:300`（D33）——对手语音库有结构化属性
// `{Id, Age, Gender, Description, Name}`，`ListVoices` **无参数全量回**；
// 我方「TTS 有模型但无合格语音库物件」。决策表 `Dramagic对称差-决策表-0928.md:42`：P1-11「做」。
//
// ── 真源（2026-09-29 逐行实查，禁手写想像值）────────────────────────────────
// 我方 TTS 上游＝VPS `/opt/edge-tts/tts-proxy.js`（OpenAI 兼容 `/openai/v1/audio/speech`）：
//   ① 主路 SiliconFlow（`:15-16` `SF_BASE`／`SF_DEFAULT_MODEL = 'FunAudioLLM/CosyVoice2-0.5B'`）；
//      `:39-41` **voice 不含 ":" 时一律改写成 `${model}:alex`** ⇒ 呼叫端传的普通音色名在主路上
//      **不生效**（实况：`/opt/edge-tts/proxy.log` 近期每一笔都是 `OK siliconflow FunAudioLLM/CosyVoice2-0.5B`）。
//   ② 降级 edge-tts（本机 venv）：`:13` `DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'`；
//      `:18-26` `VOICE_ALIASES`（7 个 OpenAI 风格名 → edge 中文音色）；
//      `:28-35` `resolveEdgeVoice`：符合 `^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$` 直接用，
//      别名查表，**其余一律静默回退 DEFAULT_VOICE**。
//   ③ 本档的 14 个 edge 音色＝`/opt/edge-tts/venv/bin/python -m edge_tts --list-voices`
//      的 `zh-*` 逐字转录（Gender／ContentCategories／VoicePersonalities 皆为该清单原值）。
//
// ── 三条诚实规则 ────────────────────────────────────────────────────────────
//   1. **Age 一律不提供**：edge-tts 清单没有 Age 栏位（Microsoft 不给）⇒ 省略栏位，
//      不编造（照本仓库「缺值留空」的既有纪律）。对手的 Age 在我方没有真源。
//   2. **Description 只由真值拼成**：用清单原值的 `ContentCategories`＋`VoicePersonalities`，
//      不写行销词。事实性补充（走哪条上游）写在 `route`／`source`，不混进描述。
//   3. **接受集 ≠ 描述集**：上游（proxy）对 edge 音色是**按模式接受**的，所以 `normalizeVoiceId`
//      接受「描述集 ∪ edge 模式 ∪ SF `<model>:<preset>` 形式」；`describeVoice` 只描述得出
//      我们有真源的那几个。呼叫端要能分辨这两件事，端点回应因此两者都给。
//
// 叶模组铁律：本档只有资料与纯函式，不 import DB／`node:*`／catalog（会被前端与端点共用）。

/** 音色性别（对手的 `Gender`）；无真源时栏位缺席。 */
export type VoiceGender = "female" | "male";

/** 实际会走的上游路线。 */
export type VoiceRoute = "primary" | "fallback";

export interface VoiceEntry {
  /** 传给 `POST /v1/tts/generations` 的 `voice` 值（＝对手语音库的 `Id`）。 */
  id: string;
  /** 人看得懂的名称（对手的 `Name`）。 */
  name: string;
  /** 对手的 `Gender`；**无真源就缺席**（本档所有 edge 条目都有真源）。 */
  gender?: VoiceGender;
  /** 对手的 `Description`：由真实清单的 `ContentCategories`／`VoicePersonalities` 逐字组成。 */
  description?: string;
  /** 这颗音色实际走哪条上游（我方特有栏位，让呼叫端知道降级路径的存在）。 */
  route: VoiceRoute;
  /** 实查来源（档案:行号 或 指令）。 */
  source: string;
}

const EDGE_LIST_SOURCE = "上游语音清单实查（zh-* 逐字转录，2026-09-29）";
const SF_ROUTE_SOURCE = "上游 TTS proxy 实查（voice 改写规则＋默认模型，2026-09-29）";

/** 主路（SiliconFlow）唯一可证实的预设音色：`<model>:<preset>` 形式，preset 由 proxy 写死 `alex`。 */
const SILICONFLOW_DEFAULT: VoiceEntry = {
  id: "FunAudioLLM/CosyVoice2-0.5B:alex",
  name: "CosyVoice2 · alex（主路预设）",
  description: "主路 CosyVoice2 预设音色；呼叫端未给 \"model:preset\" 形式时实际使用的就是这一颗",
  route: "primary",
  source: SF_ROUTE_SOURCE,
};

/**
 * edge 降级路径音色（14 条，`zh-*` 全量）。`gender` 逐条来自清单原值。
 * `description` ＝ `ContentCategories`（＋ `VoicePersonalities`），原值不改写。
 */
const EDGE_VOICES: readonly VoiceEntry[] = [
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓（普通话·女）", gender: "female", description: "News, Novel；Warm（温暖）", route: "fallback", source: EDGE_LIST_SOURCE },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊（普通话·女）", gender: "female", description: "Cartoon, Novel；Lively（活泼）", route: "fallback", source: EDGE_LIST_SOURCE },
  { id: "zh-CN-YunjianNeural", name: "云健（普通话·男）", gender: "male", description: "Sports, Novel；Passion（激情）", route: "fallback", source: EDGE_LIST_SOURCE },
  { id: "zh-CN-YunxiNeural", name: "云希（普通话·男）", gender: "male", description: "Novel；Lively, Sunshine（活泼阳光）", route: "fallback", source: EDGE_LIST_SOURCE },
  { id: "zh-CN-YunxiaNeural", name: "云夏（普通话·男）", gender: "male", description: "Cartoon, Novel；Cute（可爱）", route: "fallback", source: EDGE_LIST_SOURCE },
  { id: "zh-CN-YunyangNeural", name: "云扬（普通话·男）", gender: "male", description: "News；Professional, Reliable（专业可靠）", route: "fallback", source: EDGE_LIST_SOURCE },
  { id: "zh-CN-liaoning-XiaobeiNeural", name: "晓北（辽宁方言·女）", gender: "female", description: "Dialect；Humorous（幽默）", route: "fallback", source: EDGE_LIST_SOURCE },
  { id: "zh-CN-shaanxi-XiaoniNeural", name: "晓妮（陕西方言·女）", gender: "female", description: "Dialect；Bright（明亮）", route: "fallback", source: EDGE_LIST_SOURCE },
  { id: "zh-HK-HiuGaaiNeural", name: "晓佳（粤语·女）", gender: "female", description: "General；Friendly, Positive（友好积极）", route: "fallback", source: EDGE_LIST_SOURCE },
  { id: "zh-HK-HiuMaanNeural", name: "晓曼（粤语·女）", gender: "female", description: "General；Friendly, Positive（友好积极）", route: "fallback", source: EDGE_LIST_SOURCE },
  { id: "zh-HK-WanLungNeural", name: "云龙（粤语·男）", gender: "male", description: "General；Friendly, Positive（友好积极）", route: "fallback", source: EDGE_LIST_SOURCE },
  { id: "zh-TW-HsiaoChenNeural", name: "晓臻（台湾华语·女）", gender: "female", description: "General；Friendly, Positive（友好积极）", route: "fallback", source: EDGE_LIST_SOURCE },
  { id: "zh-TW-HsiaoYuNeural", name: "晓雨（台湾华语·女）", gender: "female", description: "General；Friendly, Positive（友好积极）", route: "fallback", source: EDGE_LIST_SOURCE },
  { id: "zh-TW-YunJheNeural", name: "云哲（台湾华语·男）", gender: "male", description: "General；Friendly, Positive（友好积极）", route: "fallback", source: EDGE_LIST_SOURCE },
];

/**
 * OpenAI／Groq 风格的别名（**逐字转录** `/opt/edge-tts/tts-proxy.js:18-26` 的 `VOICE_ALIASES`）。
 * 这些名字上游是接受的（会被换成右边那颗 edge 音色），所以它们也必须是合法的 `voice` 值——
 * 否则既有呼叫端会从「能用」变成 400。
 *
 * `shimmer` 不再指向已下架的 `zh-CN-XiaoyouNeural`，改到清单里仍在的 `zh-CN-XiaoyiNeural`。
 * `normalizeVoiceId` 不把呼叫端传入的音色改写成 alex。
 */
export const VOICE_ALIASES: Readonly<Record<string, string>> = {
  tara: "zh-CN-XiaoxiaoNeural",
  alloy: "zh-CN-XiaoxiaoNeural",
  shimmer: "zh-CN-XiaoyiNeural",
  nova: "zh-CN-XiaoyiNeural",
  echo: "zh-CN-YunxiNeural",
  onyx: "zh-CN-YunxiNeural",
  fable: "zh-CN-YunyangNeural",
};

/** 别名条目（描述时指向它实际会变成的 edge 音色；`Name` 标明是别名）。 */
const ALIAS_ENTRIES: readonly VoiceEntry[] = Object.entries(VOICE_ALIASES).map(([alias, target]) => ({
  id: alias,
  name: `${alias}（OpenAI 风格别名 → ${target}）`,
  route: "fallback" as const,
  description: `别名：上游会把 "${alias}" 换成 ${target}`,
  source: "上游 TTS proxy 实查（VOICE_ALIASES 逐字转录，2026-09-29）",
}));

/**
 * 语音库全集（＝`ListVoices` 无参数回传的内容）：1 颗主路预设 ＋ 14 颗 edge ＋ 7 个别名。
 * 排序稳定（主路 → edge → 别名），呼叫端可比对 id 集合。
 */
export const VOICE_LIBRARY: readonly VoiceEntry[] = [SILICONFLOW_DEFAULT, ...EDGE_VOICES, ...ALIAS_ENTRIES];

// ── 值域判据 ────────────────────────────────────────────────────────────────

/** 上游 proxy 对 edge 音色的**模式接受规则**（`tts-proxy.js:30` 逐字）。 */
const EDGE_VOICE_PATTERN = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/;
/**
 * SiliconFlow 的 `<model>:<preset>` 形式（`tts-proxy.js:39-44`：含 ":" 者原样送去 SF）。
 * **刻意要求模型名带 "/"**（例 `FunAudioLLM/CosyVoice2-0.5B:alex`）：
 * 只带 ":" 而模型名不像真实模型 id 的字串（如 `foo:bar`），上游 SF 会拒、接著降级 edge、
 * 最后静默变成 DEFAULT_VOICE——那正是本刀要消灭的静默降级，故不收。
 * preset 是否存在**不检查**：上游才知道有哪些 preset，我方没有可列举的真源（见档头第 3 条）。
 */
const SILICONFLOW_VOICE_PATTERN = /^[^\s:]+:[A-Za-z0-9_.-]+$/;

const BY_ID = new Map(VOICE_LIBRARY.map((voice) => [voice.id, voice]));

/** 查描述（清单里查得到才回；查不到＝没有真源可描述，不是「这颗不存在」）。 */
export function describeVoice(id: string | null | undefined): VoiceEntry | undefined {
  if (!id) return undefined;
  return BY_ID.get(id);
}

/**
 * 这颗音色**此刻能不能提交**。接受集＝描述集 ∪ edge 模式 ∪ SF 形式——照上游真正的接受规则，
 * 不放宽也不收紧：收紧会让既有可用的 edge 音色变成 400（假阴性），放宽则等于我们承诺了
 * 上游会静默回退的东西（那正是本刀要消灭的「静默降级」）。
 */
export function isServableVoice(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const id = value.trim();
  if (!id) return false;
  if (BY_ID.has(id)) return true;
  if (EDGE_VOICE_PATTERN.test(id)) return true;
  return SILICONFLOW_VOICE_PATTERN.test(id) && id.includes("/");
}

/** 清洗 `voice`：合法（可提交）回 trim 后的原值，否则 null。不改写成 alex。 */
export function normalizeVoiceId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!isServableVoice(id)) return null;
  return id;
}

/** `ListVoices` 语义：**无参数全量回**（对手的 `ListVoices` 就是这个形状）。 */
export function listVoices(): readonly VoiceEntry[] {
  return VOICE_LIBRARY;
}

/** 未带 voice 时上游实际用的音色（proxy `DEFAULT_VOICE`，`:13`）——让预设值也是明示的。 */
export const DEFAULT_TTS_VOICE = "zh-CN-XiaoxiaoNeural";
