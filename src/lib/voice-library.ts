// 結構化語音庫（P1-11／對稱差 D33「語音庫有結構化屬性」）。
//
// 對標口徑（唯一）：`Dramagic對稱差-全站-0928.md:300`（D33）——對手語音庫有結構化屬性
// `{Id, Age, Gender, Description, Name}`，`ListVoices` **無參數全量回**；
// 我方「TTS 有模型但無合格語音庫物件」。決策表 `Dramagic對稱差-決策表-0928.md:42`：P1-11「做」。
//
// ── 真源（2026-09-29 逐行實查，禁手寫想像值）────────────────────────────────
// 我方 TTS 上游＝VPS `/opt/edge-tts/tts-proxy.js`（OpenAI 兼容 `/openai/v1/audio/speech`）：
//   ① 主路 SiliconFlow（`:15-16` `SF_BASE`／`SF_DEFAULT_MODEL = 'FunAudioLLM/CosyVoice2-0.5B'`）；
//      `:39-41` **voice 不含 ":" 時一律改寫成 `${model}:alex`** ⇒ 呼叫端傳的普通音色名在主路上
//      **不生效**（實況：`/opt/edge-tts/proxy.log` 近期每一筆都是 `OK siliconflow FunAudioLLM/CosyVoice2-0.5B`）。
//   ② 降級 edge-tts（本機 venv）：`:13` `DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'`；
//      `:18-26` `VOICE_ALIASES`（7 個 OpenAI 風格名 → edge 中文音色）；
//      `:28-35` `resolveEdgeVoice`：符合 `^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$` 直接用，
//      別名查表，**其餘一律靜默回退 DEFAULT_VOICE**。
//   ③ 本檔的 14 個 edge 音色＝`/opt/edge-tts/venv/bin/python -m edge_tts --list-voices`
//      的 `zh-*` 逐字轉錄（Gender／ContentCategories／VoicePersonalities 皆為該清單原值）。
//
// ── 三條誠實規則 ────────────────────────────────────────────────────────────
//   1. **Age 一律不提供**：edge-tts 清單沒有 Age 欄位（Microsoft 不給）⇒ 省略欄位，
//      不編造（照本倉庫「缺值留空」的既有紀律）。對手的 Age 在我方沒有真源。
//   2. **Description 只由真值拼成**：用清單原值的 `ContentCategories`＋`VoicePersonalities`，
//      不寫行銷詞。事實性補充（走哪條上游）寫在 `route`／`source`，不混進描述。
//   3. **接受集 ≠ 描述集**：上游（proxy）對 edge 音色是**按模式接受**的，所以 `normalizeVoiceId`
//      接受「描述集 ∪ edge 模式 ∪ SF `<model>:<preset>` 形式」；`describeVoice` 只描述得出
//      我們有真源的那幾個。呼叫端要能分辨這兩件事，端點回應因此兩者都給。
//
// 葉模組鐵律：本檔只有資料與純函式，不 import DB／`node:*`／catalog（會被前端與端點共用）。

/** 音色性別（對手的 `Gender`）；無真源時欄位缺席。 */
export type VoiceGender = "female" | "male";

/** 實際會走的上游路線。 */
export type VoiceRoute = "siliconflow" | "edge";

export interface VoiceEntry {
  /** 傳給 `POST /v1/tts/generations` 的 `voice` 值（＝對手語音庫的 `Id`）。 */
  id: string;
  /** 人看得懂的名稱（對手的 `Name`）。 */
  name: string;
  /** 對手的 `Gender`；**無真源就缺席**（本檔所有 edge 條目都有真源）。 */
  gender?: VoiceGender;
  /** 對手的 `Description`：由真實清單的 `ContentCategories`／`VoicePersonalities` 逐字組成。 */
  description?: string;
  /** 這顆音色實際走哪條上游（我方特有欄位，讓呼叫端知道降級路徑的存在）。 */
  route: VoiceRoute;
  /** 實查來源（檔案:行號 或 指令）。 */
  source: string;
}

const EDGE_LIST_SOURCE = "/opt/edge-tts/venv/bin/python -m edge_tts --list-voices（zh-* 逐字轉錄，2026-09-29 實查）";
const SF_ROUTE_SOURCE = "/opt/edge-tts/tts-proxy.js:39-41（voice 不含 \":\" 時改寫成 ${model}:alex）＋ :15-16 SF_DEFAULT_MODEL";

/** 主路（SiliconFlow）唯一可證實的預設音色：`<model>:<preset>` 形式，preset 由 proxy 寫死 `alex`。 */
const SILICONFLOW_DEFAULT: VoiceEntry = {
  id: "FunAudioLLM/CosyVoice2-0.5B:alex",
  name: "CosyVoice2 · alex（主路預設）",
  description: "SiliconFlow CosyVoice2 預設音色；呼叫端未給 \"model:preset\" 形式時實際使用的就是這一顆",
  route: "siliconflow",
  source: SF_ROUTE_SOURCE,
};

/**
 * edge 降級路徑音色（14 條，`zh-*` 全量）。`gender` 逐條來自清單原值。
 * `description` ＝ `ContentCategories`（＋ `VoicePersonalities`），原值不改寫。
 */
const EDGE_VOICES: readonly VoiceEntry[] = [
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓（普通话·女）", gender: "female", description: "News, Novel；Warm（温暖）", route: "edge", source: EDGE_LIST_SOURCE },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊（普通话·女）", gender: "female", description: "Cartoon, Novel；Lively（活泼）", route: "edge", source: EDGE_LIST_SOURCE },
  { id: "zh-CN-YunjianNeural", name: "云健（普通话·男）", gender: "male", description: "Sports, Novel；Passion（激情）", route: "edge", source: EDGE_LIST_SOURCE },
  { id: "zh-CN-YunxiNeural", name: "云希（普通话·男）", gender: "male", description: "Novel；Lively, Sunshine（活泼阳光）", route: "edge", source: EDGE_LIST_SOURCE },
  { id: "zh-CN-YunxiaNeural", name: "云夏（普通话·男）", gender: "male", description: "Cartoon, Novel；Cute（可爱）", route: "edge", source: EDGE_LIST_SOURCE },
  { id: "zh-CN-YunyangNeural", name: "云扬（普通话·男）", gender: "male", description: "News；Professional, Reliable（专业可靠）", route: "edge", source: EDGE_LIST_SOURCE },
  { id: "zh-CN-liaoning-XiaobeiNeural", name: "晓北（辽宁方言·女）", gender: "female", description: "Dialect；Humorous（幽默）", route: "edge", source: EDGE_LIST_SOURCE },
  { id: "zh-CN-shaanxi-XiaoniNeural", name: "晓妮（陕西方言·女）", gender: "female", description: "Dialect；Bright（明亮）", route: "edge", source: EDGE_LIST_SOURCE },
  { id: "zh-HK-HiuGaaiNeural", name: "曉佳（粤语·女）", gender: "female", description: "General；Friendly, Positive（友好积极）", route: "edge", source: EDGE_LIST_SOURCE },
  { id: "zh-HK-HiuMaanNeural", name: "曉曼（粤语·女）", gender: "female", description: "General；Friendly, Positive（友好积极）", route: "edge", source: EDGE_LIST_SOURCE },
  { id: "zh-HK-WanLungNeural", name: "雲龍（粤语·男）", gender: "male", description: "General；Friendly, Positive（友好积极）", route: "edge", source: EDGE_LIST_SOURCE },
  { id: "zh-TW-HsiaoChenNeural", name: "曉臻（台湾华语·女）", gender: "female", description: "General；Friendly, Positive（友好积极）", route: "edge", source: EDGE_LIST_SOURCE },
  { id: "zh-TW-HsiaoYuNeural", name: "曉雨（台湾华语·女）", gender: "female", description: "General；Friendly, Positive（友好积极）", route: "edge", source: EDGE_LIST_SOURCE },
  { id: "zh-TW-YunJheNeural", name: "雲哲（台湾华语·男）", gender: "male", description: "General；Friendly, Positive（友好积极）", route: "edge", source: EDGE_LIST_SOURCE },
];

/**
 * OpenAI／Groq 風格的別名（**逐字轉錄** `/opt/edge-tts/tts-proxy.js:18-26` 的 `VOICE_ALIASES`）。
 * 這些名字上游是接受的（會被換成右邊那顆 edge 音色），所以它們也必須是合法的 `voice` 值——
 * 否則既有呼叫端會從「能用」變成 400。
 *
 * ⚠️ 已知缺陷（**不在本刀修**，proxy 在 VPS）：`shimmer` 指向 `zh-CN-XiaoyouNeural`，
 * 而 Microsoft 現行清單**已無這顆音色**（見上方 14 條 zh-* 全量）⇒ 走降級路徑時它會失敗。
 * 修法＝改 VPS `/opt/edge-tts/tts-proxy.js:21` 的目標（要部署）；本檔只把事實記下來。
 */
export const VOICE_ALIASES: Readonly<Record<string, string>> = {
  tara: "zh-CN-XiaoxiaoNeural",
  alloy: "zh-CN-XiaoxiaoNeural",
  shimmer: "zh-CN-XiaoyouNeural",
  nova: "zh-CN-XiaoyiNeural",
  echo: "zh-CN-YunxiNeural",
  onyx: "zh-CN-YunxiNeural",
  fable: "zh-CN-YunyangNeural",
};

/** 別名條目（描述時指向它實際會變成的 edge 音色；`Name` 標明是別名）。 */
const ALIAS_ENTRIES: readonly VoiceEntry[] = Object.entries(VOICE_ALIASES).map(([alias, target]) => ({
  id: alias,
  name: `${alias}（OpenAI 风格别名 → ${target}）`,
  route: "edge" as const,
  description: `别名：上游会把 "${alias}" 换成 ${target}`,
  source: "/opt/edge-tts/tts-proxy.js:18-26（VOICE_ALIASES 逐字轉錄）",
}));

/**
 * 語音庫全集（＝`ListVoices` 無參數回傳的內容）：1 顆主路預設 ＋ 14 顆 edge ＋ 7 個別名。
 * 排序穩定（主路 → edge → 別名），呼叫端可比對 id 集合。
 */
export const VOICE_LIBRARY: readonly VoiceEntry[] = [SILICONFLOW_DEFAULT, ...EDGE_VOICES, ...ALIAS_ENTRIES];

// ── 值域判據 ────────────────────────────────────────────────────────────────

/** 上游 proxy 對 edge 音色的**模式接受規則**（`tts-proxy.js:30` 逐字）。 */
const EDGE_VOICE_PATTERN = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/;
/**
 * SiliconFlow 的 `<model>:<preset>` 形式（`tts-proxy.js:39-44`：含 ":" 者原樣送去 SF）。
 * **刻意要求模型名帶 "/"**（例 `FunAudioLLM/CosyVoice2-0.5B:alex`）：
 * 只帶 ":" 而模型名不像真實模型 id 的字串（如 `foo:bar`），上游 SF 會拒、接著降級 edge、
 * 最後靜默變成 DEFAULT_VOICE——那正是本刀要消滅的靜默降級，故不收。
 * preset 是否存在**不檢查**：上游才知道有哪些 preset，我方沒有可列舉的真源（見檔頭第 3 條）。
 */
const SILICONFLOW_VOICE_PATTERN = /^[^\s:]+:[A-Za-z0-9_.-]+$/;

const BY_ID = new Map(VOICE_LIBRARY.map((voice) => [voice.id, voice]));

/** 查描述（清單裡查得到才回；查不到＝沒有真源可描述，不是「這顆不存在」）。 */
export function describeVoice(id: string | null | undefined): VoiceEntry | undefined {
  if (!id) return undefined;
  return BY_ID.get(id);
}

/**
 * 這顆音色**此刻能不能提交**。接受集＝描述集 ∪ edge 模式 ∪ SF 形式——照上游真正的接受規則，
 * 不放寬也不收緊：收緊會讓既有可用的 edge 音色變成 400（假陰性），放寬則等於我們承諾了
 * 上游會靜默回退的東西（那正是本刀要消滅的「靜默降級」）。
 */
export function isServableVoice(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const id = value.trim();
  if (!id) return false;
  if (BY_ID.has(id)) return true;
  if (EDGE_VOICE_PATTERN.test(id)) return true;
  return SILICONFLOW_VOICE_PATTERN.test(id) && id.includes("/");
}

/** 清洗 `voice`：合法（可提交）回 trim 後的原值，否則 null。 */
export function normalizeVoiceId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return isServableVoice(id) ? id : null;
}

/** `ListVoices` 語義：**無參數全量回**（對手的 `ListVoices` 就是這個形狀）。 */
export function listVoices(): readonly VoiceEntry[] {
  return VOICE_LIBRARY;
}

/** 未帶 voice 時上游實際用的音色（proxy `DEFAULT_VOICE`，`:13`）——讓預設值也是明示的。 */
export const DEFAULT_TTS_VOICE = "zh-CN-XiaoxiaoNeural";
