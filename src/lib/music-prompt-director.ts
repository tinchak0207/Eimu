/**
 * Music Prompt Director — 規則層音樂提示詞導演。
 *
 * 用戶的短 prompt 在進上游之前被這層自動「導演化」：偵測六層風格公式
 * (GENRE + MOOD + INSTRUMENTATION + VOCAL + STRUCTURE + PRODUCTION) 的缺漏
 * 並補齊中性指令、把 `[BPM: 120]` 這類所有平台都不解析的偽裝參數改寫成散文、
 * 把空泛／缺陷詞換成庫內有依據的具體語彙、修剪超過兩個的 MOOD，最後依目標
 * 通路執行硬規則：flowmusic 剝除死掉的時間戳、無歌詞標籤時壓成單行並壓進
 * 220 runes（超限依 CORE_01 權重由低到高整層丟棄，仍超才硬截——硬截盡量用滿預算：
 * 先取前 cap runes，≥60% cap 有子句邊界才退、否則退到最後空白或就地切）；
 * lyria 保留官方時間戳、不設 220 上限；yue2 剝除時間戳（YuE2 不認時間戳結構控制）但
 * **保留 [Verse]/[Chorus] 段落標籤**（那是歌詞欄必需語法）、允許換行、上限 3000 runes。
 * 全程在後端發生，用戶無感。
 *
 * 知識來源：SunoForge v3.0 配方庫（repo `skills/music-director/files/`，MIT，
 * 上游 sanic732/SunoForge）＋本專案對生產通路 FlowMusic2API 的實測
 * （`DATA_FLOWMUSIC_2026-09.md`，2026-09-11，n=3×2 clips）。每個規則對應
 * 一項「某種音樂 prompt 為什麼會掛」的生產事實，註釋逐條引用來源檔行號。
 *
 * 兩處刻意的「不建」——庫無依據就留空，禁止發明：
 *   1. 同義詞陷阱（homograph）表：庫的四檔裡沒有任何音樂域同義詞／雙義詞條目
 *      （grep 無 homograph/synonym/ambiguity 條目），故 HOMOGRAPH_FIXES 留空。
 *   2. 中文空泛詞（好聽／震撼…）：庫內無對應詞條或替換目標，未建替換表。
 *   3. 中文偵測詞表同理：六層偵測用庫內英文詞條＋DATA_FLOWMUSIC 的方括號
 *      段落標籤；純中文用詞偵測不到時，layers 如實回報 false 並補中性指令。
 *
 * 零依賴（同 `music-lyria.ts` 慣例）：VPS 落位檔必須自足，本檔不 import 任何模組。
 */

/** 目標通路。`flowmusic` = 生產 FlowMusic2API；`lyria` = Google Lyria；`yue2` = YuE2（Modal，白盒樂譜）。 */
export type MusicChannel = "flowmusic" | "lyria" | "yue2";

/** 六層風格公式的槽位 id。 */
export type MusicLayerId = "genre" | "mood" | "instrumentation" | "vocal" | "structure" | "production";

/** 六層固定順序（＝組裝順序）。來源：CORE_01_STYLE.md:35-40 §1、:965-973 §13。 */
export const MUSIC_LAYER_IDS: readonly MusicLayerId[] = [
  "genre",
  "mood",
  "instrumentation",
  "vocal",
  "structure",
  "production",
];

export interface MusicDirectorOptions {
  /** 目標通路。缺省 `"lyria"`（保守：不動時間戳；時間戳在 flowmusic 是死控件）。 */
  channel?: MusicChannel;
  /** 文本是否含歌詞／段落標籤。缺省自動偵測（判別式同 DATA_FLOWMUSIC_2026-09.md:113-115 §3 step 2）。 */
  hasLyrics?: boolean;
  /** 上游模型 id。規則庫對 model 家族無 prompt 控制差異（CORE_01／DATA_* 無此依據），收下不用。 */
  modelId?: string;
  /** 目標時長（秒）。≥120 時結構補層改用整曲措辭（DATA_FLOWMUSIC §4 實測成品 162–182s）。 */
  durationSeconds?: number;
}

export interface MusicDirectorResult {
  /** 導演化後的 prompt（純函數決定性產物）。 */
  prompt: string;
  /** 用戶原 prompt 的六層偵測結果（如實回報，不因補齊而變 true）。 */
  layers: Record<MusicLayerId, boolean>;
  /** 實際改寫過的規則 id；沒改就是空陣列。 */
  applied: string[];
  /** 偵測到但無法確定性修補的缺口（不得虛報）。 */
  warnings: string[];
  /** 因長度上限被整層丟棄的層 id。 */
  truncated: MusicLayerId[];
}

/**
 * 通路長度硬上限（runes = Unicode code points，Go 的 rune 語義）。
 * 來源：DATA_FLOWMUSIC_2026-09.md:94 §2 row ⑦、:117-121 §3 step 3-4（無歌詞標籤壓單行 220；
 * 帶 `歌词`／`lyrics`／段落標籤走保版面分支 3000）；:204 §5 checklist 4（壓在 ~220 內）。
 */
const CHANNEL_LIMITS = {
  flowmusicFlat: 220,
  flowmusicLayout: 3000,
  /**
   * YuE2 style 欄上限 600 runes。依據（2026-09-28 本機 8GB 卡實測）：style 進 NAR prefill 的
   * prefix，1353 字 style＋500 token ABC 在 NAR 階段 OOM；同單截到 600 字 → prefix 675、
   * 峰值 7.10 GiB、52.4 秒成片。自譜成功單 prefix 皆 ≤846。凍結合約無字數條款，這是顯存預算。
   */
  yue2Style: 600,
} as const;

/** 整曲門檻（秒）：≥ 此值時結構補層講「整曲」。來源：DATA_FLOWMUSIC_2026-09.md:148-159 §4（成品 162–182s）。 */
const LONG_TRACK_SECONDS = 120;

/**
 * 由低到高的丟棄權重：GENRE 承重排第一，其餘依 CORE_01 §13 組裝序遞減。
 * 來源：CORE_01_STYLE.md:42 §1 Layer 1「load-bearing, goes first」、:965-973 §13 ORDER OF OPERATIONS、
 * :1010-1016 §13 LENGTH DISCIPLINE「Front-loading matters more than word count」。
 */
const LAYER_WEIGHT: Record<MusicLayerId, number> = {
  genre: 6,
  mood: 5,
  instrumentation: 4,
  vocal: 3,
  structure: 2,
  production: 1,
};

/** 六層偵測詞條（庫內英文／羅馬化詞條；中文用詞無庫內依據，見檔首說明）。 */
const GENRE_WORDS =
  "glam metal|heavy metal|metal|death metal|black metal|grunge|post-?punk|hardcore|punk|rockabilly|surf rock|math rock|alt-?rock|rock|nb-?rock|cool jazz|bebop|swing|jazz|delta blues|blues|bluegrass|americana|country|folk|soul|motown|funk|disco|r&b|rnb|boom bap|hip-?hop|trap|drill|phonk|rap|acid house|deep house|house|techno|trance|uk garage|garage|dubstep|drum and bass|dnb|dub|dancehall|reggae|ska|trip-?hop|downtempo|ambient|drone|shoegaze|dream pop|synthwave|vaporwave|retrowave|city pop|synth-?pop|k-?pop|j-?pop|electro|electronic|edm|idm|lo-?fi|bedroom pop|indie|alternative|emo|pop|baroque|classical|orchestral|cinematic|score|soundtrack|chamber|opera|choral|gospel|salsa|bossa nova|samba|tango|flamenco|cumbia|afrobeat|celtic|klezmer|gamelan|ballad|waltz|post-?rock|progressive|psychedelic|slowcore|neo-?soul|guofeng";

/** MOOD 詞表＝CORE_01 §4 PALETTE 的 26 個主詞＋括號內同義詞。來源：CORE_01_STYLE.md:256-300 §4（PALETTE :261）。 */
const MOOD_WORDS =
  "uplifting|positive|lifting|melancholic|melancholy|sad|contemplative|haunting|eerie|lingering|dark|gloomy|ominous|joyful|happy|celebratory|nostalgic|wistful|romantic|tender|intense|powerful|dramatic|dreamy|ethereal|floating|peaceful|calm|unhurried|anxious|tense|unsettled|euphoric|blissful|ecstatic|mysterious|enigmatic|aggressive|confrontational|playful|teasing|bittersweet|triumphant|victorious|somber|grave|intimate|defiant|rebellious|vulnerable|exposed|sultry|sensual|brooding|introspective|weary|reverent|devotional";

/** INSTRUMENTATION 詞表＝CORE_01 §5 的主張（樂器名）＋DATA_VOCAB §6 目錄內的樂器項。 */
const INSTRUMENT_WORDS =
  "nylon-string|acoustic guitar|electric guitar|guitars?|grand piano|upright piano|pianos?|rhodes|wurlitzer|harpsichord|accordion|keyboards?|keys|synths?|synthesizers?|moog|pads?|organs?|violins?|violas?|cellos?|double bass|upright bass|strings|harps?|flutes?|dizi|piccolo|clarinets?|oboes?|bassoons?|saxophones?|sax|flugelhorn|trumpets?|trombones?|french horn|horns?|brass|tuba|drum kit|drums|kicks?|snares?|hi-?hats?|toms?|cymbals?|percussion|congas|congas?|bongos|timbales|tabla|taiko|timpani|glockenspiel|marimba|vibraphone|xylophone|808|sub bass|bassline|bass|banjos?|mandolins?|ukulele|sitars?|kotos?|shakuhachi|guzheng|erhu|pipa|sarod|oud|didgeridoo|steel drums?|pedal steel|lap steel|choir|vocoder";

/** VOCAL 詞表＝CORE_01 §6 的四要素（性別／音域／角色／唱法）＋DATA_FLOWMUSIC 的器樂聲明。 */
const VOCAL_WORDS =
  "vocals?|vocalist|singers?|voices?|male|female|tenor|alto|soprano|baritones?|falsetto|choir|choral|harmonies|harmony|backing vocals|ad-?libs|duet|humming|whispered|spoken word|rapped|instrumental|no vocals|a cappella|acapella";

/** STRUCTURE 偵測：方括號段落標籤（DATA_FLOWMUSIC 判別式）＋結構詞＋時間戳。 */
const STRUCTURE_WORDS =
  "\\[(?:verse|chorus|bridge|intro|outro|pre-?chorus|hook|refrain|breakdown|drop|主歌|副歌|导歌|桥段|前奏|尾奏|间奏)\\]|\\b(?:verses?|choruses|bridges?|intros?|outros?|pre-?chorus|hooks?|refrain|coda|middle eight|call and response|aaba|twelve-?bar|strophic|through-?composed|buildups?|build-?up|breakdowns?|drops?)\\b|\\b\\d{1,2}:\\d{2}\\b";

/** PRODUCTION 偵測＝CORE_01 §9 的環境／混音語彙＋速度與調性的散文寫法。 */
const PRODUCTION_WORDS =
  "\\b(?:produced|production|mixes?|mixing|master(?:ed|ing)?|reverbs?|delays?|echo(?:es)?|compression|compressed|sidechain|stereo|mono|width|tape|vinyl|analog(?:ue)?|valve|saturation|saturated|warm|polished|raw|gritty|spacious|punchy|minimal|dry|wet|close-?mic|room|hall|cathedral|studio|stage|live|concert|bpm|tempo|key of|front-?to-?back|hi-?fi|console|decay|headroom)\\b|\\b[a-g](?:\\s*#|\\s*b)?\\s*(?:major|minor)\\b";

/**
 * 六層偵測用正則。層存在時保留用戶原話，缺漏時才補中性指令。
 * 來源：CORE_01_STYLE.md:29-100 §1（六層定義）、:965-973 §13（組裝序）。
 */
const MUSIC_LAYER_PATTERNS: Record<MusicLayerId, RegExp> = {
  genre: new RegExp(`(?:${GENRE_WORDS})`, "i"),
  mood: new RegExp(`\\b(?:${MOOD_WORDS})\\b`, "i"),
  instrumentation: new RegExp(`\\b(?:${INSTRUMENT_WORDS})\\b`, "i"),
  vocal: new RegExp(`\\b(?:${VOCAL_WORDS})\\b`, "i"),
  structure: new RegExp(`(?:${STRUCTURE_WORDS})`, "i"),
  production: new RegExp(`(?:${PRODUCTION_WORDS})`, "i"),
};

/** MOOD 全域版（計數／修剪用）。 */
const MOOD_WORD_GLOBAL = new RegExp(`\\b(?:${MOOD_WORDS})\\b`, "gi");

/** 樂器全域版（計數用，CORE_03 §2 CHECK 3）。 */
const INSTRUMENT_GLOBAL = new RegExp(`\\b(?:${INSTRUMENT_WORDS})\\b`, "gi");

/**
 * Anti-slop：空泛／缺陷詞 → 具體可採樣語彙。regex 只做標記，替換由 mapping 決定。
 * 語境相依的詞（distortion／shimmer／compressed）刻意不收：
 * CORE_03_DIAGNOSE.md:389-395 §4 註 1-3 說它們在搖滾／pad 語境是合法描述，只在「用來排除」時才是 trigger，
 * 無上下文無法確定性判定，故不替換。
 */
const SLOP_WORDS: ReadonlyArray<[RegExp, string]> = [
  // CORE_03_DIAGNOSE.md:359-404 §4 TRIGGER WORDS → WRITE INSTEAD 逐條
  [/\bartifact(?:s)?\b/gi, "clean tone"],
  [/\bglitch(?:es)?\b/gi, "smooth, continuous"],
  [/\bclipping\b/gi, "balanced dynamics"],
  [/\bbackground noise\b/gi, "clean background"],
  [/\bhiss\b/gi, "warm tone"],
  [/\bmuddy\b/gi, "clear and defined"],
  [/\bharsh\b/gi, "smooth top end"],
  [/\bthin\b/gi, "full-bodied"],
  [/\bboomy\b/gi, "tight low end"],
  [/\bstatic\b/gi, "clean signal"],
  [/\blow quality\b/gi, "studio-grade"],
  [/\bamateur\b/gi, "professionally recorded"],
  // CORE_03_DIAGNOSE.md:190-203 §3 row 1：品質模式標籤不存在 → 用描述表達
  // （[QUALITY: MAX] 等由 rewritePseudoTags 直接刪除）
  // DATA_VOCAB.md:48-56 §1 THE SUBSTITUTION HABIT 的替換習慣逐條
  [/\bgood production\b/gi, "warm, close-mic, lightly compressed"],
  [/\bnice guitar\b/gi, "jangly clean tone with spring reverb"],
  [/\bcool drums\b/gi, "tight, punchy, slightly behind the beat"],
  [/\bbig sound\b/gi, "wide stereo with long hall decay"],
  [/\bprofessional\b/gi, "balanced, controlled, commercially polished"],
  // CORE_01_STYLE.md:303-313 §4：「epic」是 border case，trailer／cinematic 之外用 intense 表達
  [/\bepic\b/gi, "intense"],
];

/**
 * CORE_01 §4 的「看似情緒、其實沒有音樂資訊」的空詞。庫內未給具體替換目標
 * （只說「spend prompt weight and return nothing」），故不替換、只記 warnings。
 * `cool` 刻意不收：CORE_01_STYLE.md:187 §3 的 substitution table 用「1959 New York cool jazz」
 * 當流派名，同庫內雙義，無上下文無法確定性判定。
 */
const EMPTY_WORDS: readonly string[] = ["nice", "great", "beautiful", "amazing", "wonderful", "good", "vibey"];

/**
 * 偽標籤：`[Key: Value]` 形式的假參數。key 必須以字母開頭（排除 `[0:00]` 時間戳與
 * `[End - 2:15]` 這類舊式時間碼），value 到 `]` 為止。
 * 來源：CORE_01_STYLE.md:100-110 §1「Bracketed parameter syntax was never parsed by any covered platform」、
 * CORE_03_DIAGNOSE.md:105-109 §2 CHECK 6「the highest-volume defect in circulating prompts」。
 */
const PSEUDO_TAG_PATTERN = /\[([A-Za-z][A-Za-z0-9_ -]*?)\s*:\s*([^\]]+)\]/g;

/** 內容為 MAX 的品質模式假參數 key（整條刪除）。來源：CORE_03_DIAGNOSE.md:190-203 §3 row 1。 */
const MAX_MODE_KEYS: readonly string[] = ["is_max_mode", "quality", "realism", "real_instruments"];

/** ENERGY 假標籤 → CORE_01 §4 的散文寫法（ENERGY, AS PROSE）。來源：CORE_01_STYLE.md:290-297 §4。 */
const ENERGY_PROSE: Record<string, string> = {
  low: "low energy, barely moving",
  medium: "steady mid-tempo drive",
  high: "full-force, everything at once",
  "low→high": "builds from near-silence to a wall",
  "low->high": "builds from near-silence to a wall",
  "low-high": "builds from near-silence to a wall",
};

/** 無冒號的死參數（CORE_03 §3 row 1／row 3 的 FIND 清單形式）。來源：CORE_03_DIAGNOSE.md:190-213 §3。 */
const DEAD_PLAIN_TAGS: ReadonlyArray<[RegExp, string]> = [
  [/\[\s*wide stereo field\s*\]/gi, "wide stereo"],
  [/\[\s*sidechain\s*\]/gi, "pumping sidechain"],
  [/\(\s*max\s*\)(?:\s*\(\s*max\s*\))*/gi, ""],
];

/**
 * flowmusic 死控件：時間戳。來源：DATA_FLOWMUSIC_2026-09.md:88 §2 row ③「DOES NOT WORK —
 * time codes vanish before the song tool」、:95 row ⑧（`:`,`,`,`.` 被換成空格）、
 * CORE_03_DIAGNOSE.md:257-265 §3 row 9（含舊式 `Intro (0–15s)`／`[End - 2:15]`）。
 */
const TIMESTAMP_BRACKETED = /\[\s*(?:end\s*[-–—]\s*)?\d{1,2}:\d{2}(?:\s*[-–—]\s*\d{1,2}:\d{2})?\s*\]/gi;
const TIMESTAMP_OLD_PARENTHETICAL = /\(\s*\d{1,2}(?:\s*[-–—]\s*\d{1,2})?\s*s\s*\)/gi;
const TIMESTAMP_BARE = /\b\d{1,2}:\d{2}(?:\s*[-–—]\s*\d{1,2}:\d{2})?/g;

/**
 * 歌詞標籤判別式（決定 flowmusic 走 220 單行分支還是 3000 保版面分支）。
 * 來源：DATA_FLOWMUSIC_2026-09.md:113-117 §3 step 2-3（`歌词`／`lyrics` 或
 * `[verse] [chorus] [bridge] [intro] [outro] [pre-chorus] [主歌] [副歌] [导歌] [桥段] [前奏] [尾奏]`）。
 */
const LYRICS_MARKER_PATTERN = /(歌词|lyrics)/i;
const SECTION_TAG_PATTERN =
  /\[(?:verse|chorus|bridge|intro|outro|pre-?chorus|主歌|副歌|导歌|桥段|前奏|尾奏|间奏)\]/i;

/**
 * 缺層補中性指令——不替用戶決定流派／樂器／唱的人。
 * 措辭依 CORE_01_STYLE.md:965-973 §13 的六個決策問題（每層問什麼就補什麼指令）。
 */
const LAYER_FILLS: Record<MusicLayerId, string> = {
  genre: "Genre: name the tradition with its era or scene, first in the line.",
  mood: "Mood: one or two compatible feeling words.",
  instrumentation: "Instrumentation: two or three hero instruments, each with a playing-style word.",
  vocal: "Vocal: state who sings and how, positively — or say instrumental only, no vocals.",
  structure: "Structure: how it unfolds, section by section.",
  production: "Production: era, mix character and the room, with tempo and key as prose.",
};

function replaceAll(prompt: string, table: ReadonlyArray<[RegExp, string]>): string {
  let out = prompt;
  for (const [pattern, replacement] of table) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** runes = Unicode code points（Go rune 語義；DATA_FLOWMUSIC 的上限以 rune 計）。 */
function countRunes(text: string): number {
  return Array.from(text).length;
}

/** 每層缺漏時要補的句子；長曲的結構層講「整曲」。 */
function layerFill(id: MusicLayerId, durationSeconds?: number): string {
  const isLongTrack = durationSeconds !== undefined && durationSeconds >= LONG_TRACK_SECONDS;
  if (id === "structure" && isLongTrack) {
    return "Structure: how it unfolds across the full runtime, section by section.";
  }
  return LAYER_FILLS[id];
}

/** 偵測用戶原 prompt 的六層在場情形（回報用，不因補齊而變真）。 */
function detectLayers(prompt: string): Record<MusicLayerId, boolean> {
  const layers = {} as Record<MusicLayerId, boolean>;
  for (const id of MUSIC_LAYER_IDS) {
    layers[id] = MUSIC_LAYER_PATTERNS[id].test(prompt);
  }
  return layers;
}

/** 偽標籤 → 散文／刪除。來源：CORE_03_DIAGNOSE.md:190-251 §3 row 1／3／4／5／6／7。 */
function rewritePseudoTags(prompt: string): string {
  return prompt.replace(PSEUDO_TAG_PATTERN, (_match, rawKey: string, rawValue: string) => {
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    // row 1：沒有隱藏品質模式，整條刪除
    if (MAX_MODE_KEYS.includes(key) && /^max$/i.test(value)) return "";
    // row 4：樂理參數落成 Style 內的散文，「120 BPM」「key of A minor」
    if (key === "bpm" || key === "tempo") return /\bbpm\b/i.test(value) ? value : `${value} BPM`;
    if (key === "key") return `key of ${value}`;
    // row 5：情緒／能量／氛圍假標籤 → 詞本身就是意義，去括號與冒號
    if (key === "energy") return ENERGY_PROSE[value.toLowerCase()] ?? `${value} energy`;
    // row 6：`[Sound: Rain]` → 章節級 `[Rain]`
    if (key === "sound") return `[${value}]`;
    // row 7：唱法方向 → 散文；唱的人是另一層，這裡只把 value 交還
    if (key === "vocal" || key === "vocal style") return `${value} lead vocal`;
    if (key === "choir") return `${value} choir`;
    // row 3：混音參數 → Style 內的散文
    if (key === "eq") return `${value} mids`;
    if (key === "compression") return /^heavy/i.test(value) ? "heavily compressed" : `${value} compression`;
    if (key === "focus") return `${value} focus`;
    if (key === "reverb") return `${value} reverb`;
    return value;
  });
}

/** 修掉刪標籤／修剪留下的空子句分隔（`, ,`、行尾逗號）；只動標點，不動文字。 */
function tidySeparators(prompt: string): string {
  return prompt
    .replace(/([,;，；])\s*(?=[,;，；])/g, "$1")
    .replace(/[,;，；]\s*$/, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** 找出庫內「沒有音樂資訊」的空詞（只回報，不替換）。來源：CORE_01_STYLE.md:303-313 §4。 */
function findEmptyWords(prompt: string): string[] {
  const found: string[] = [];
  for (const word of EMPTY_WORDS) {
    if (new RegExp(`\\b${word}\\b`, "i").test(prompt) && !found.includes(word)) found.push(word);
  }
  return found;
}

/** 收集 MOOD 在場詞（去重、依出現序）。來源：CORE_01_STYLE.md:261-288 §4 PALETTE。 */
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
 * 超過兩個的 MOOD 移除（保留前兩個出現的）。相容性判定（例如 dark + euphoric 會被平均掉）
 * 庫內沒有可用的相容／衝突對照表，故只能確定性修剪數量、把相容性留給 warnings。
 * 來源：CORE_01_STYLE.md:54-60 §1 Layer 2「Two moods maximum」、CORE_03_DIAGNOSE.md:94-99 §2 CHECK 4。
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

/** flowmusic 保版面分支不適用：時間戳一律剝除（時間碼在上游消失），描述文字保留。 */
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

/** flowmusic 平面分支：全文壓成一行（換行不帶語義，上游會壓平）。 */
function collapseToSingleLine(prompt: string): string {
  return prompt
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** 歌詞標籤在場？（options.hasLyrics 明示時以明示為準）。 */
function hasLyricsMarker(prompt: string): boolean {
  return LYRICS_MARKER_PATTERN.test(prompt) || SECTION_TAG_PATTERN.test(prompt);
}

/** 首個子句是否就是流派（front-loading）。來源：CORE_03_DIAGNOSE.md:78-87 §2 CHECK 1、CORE_01_STYLE.md:42 §1。 */
function isGenreFrontLoaded(prompt: string): boolean {
  const firstClause = prompt.split(/[,;.\n，；。]/)[0] ?? "";
  return MUSIC_LAYER_PATTERNS.genre.test(firstClause);
}

/** 樂器數量（去重、去從屬寫法如 horn ⊂ french horn）。來源：CORE_03_DIAGNOSE.md:89-93 §2 CHECK 3、CORE_01_STYLE.md:329-340 §5。 */
function countDistinctInstruments(prompt: string): number {
  const matches = (prompt.match(INSTRUMENT_GLOBAL) ?? []).map((match) => match.toLowerCase().replace(/s$/, ""));
  const distinct = matches.filter((match) => !matches.some((other) => other !== match && other.includes(match)));
  return new Set(distinct).size;
}

/**
 * 硬截的預算下限：退讓後至少留 60% cap（用滿預算的硬性下限，防「一路退到首個
 * 邊界」把 mood／樂器／結構整段丟掉——2026-09-12 實錘：`Intro: soft pad.` 之後
 * 是無逗號長串時舊邏輯只留 15 runes＝7% 預算）。
 */
const MIN_KEEP_RATIO = 0.6;

/** 子句邊界（硬截退讓點）＝中西文逗號／分號／句號／中文列舉頓號。 */
const CLAUSE_BOUNDARIES: readonly string[] = [",", ";", ".", "，", "；", "。", "、"];

/** 保版面分支多認一個換行邊界。 */
const LAYOUT_BOUNDARIES: readonly string[] = [...CLAUSE_BOUNDARIES, "\n"];

/** 去掉硬截尾端的殘留分隔（只動標點空白，不動文字）。 */
function trimBoundaryTail(text: string): string {
  return text.replace(/[\s,;.，；。、]+$/, "");
}

/**
 * 硬截：盡量用滿預算。
 * ① 取前 cap runes；② 若 ≥60% cap 處存在子句邊界 → 退到該邊界（保語義完整）；
 * ③ 否則退到最後一個空白（拉丁文避免切斷單詞）；④ 無空白或空白退讓會低於
 * 60% cap 時就地在 cap 處切（CJK 長串不為找邊界大幅退讓）。
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
  /** 實際留在 prompt 裡的補層 id。 */
  kept: MusicLayerId[];
  /** 因上限被整層丟棄的層 id。 */
  truncated: MusicLayerId[];
  /** 是否在丟無可丟之後仍超限、走了子句邊界硬截。 */
  hardCapped: boolean;
}

/**
 * 依上限組裝：超限時依 CORE_01 權重由低到高整層丟棄，仍超才硬截。
 * 來源：CORE_01_STYLE.md:42 §1（genre 承重）、:965-973 §13（組裝序＝權重序）、
 * DATA_FLOWMUSIC_2026-09.md:94 §2 row ⑦（上限存在）。
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
  if (limit === null) {
    return { prompt: text, kept: kept.map((fill) => fill.id), truncated, hardCapped: false };
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
    return {
      prompt: truncateAtBoundary(text, limit, allowNewline),
      kept: kept.map((fill) => fill.id),
      truncated,
      hardCapped: true,
    };
  }
  return { prompt: text, kept: kept.map((fill) => fill.id), truncated, hardCapped: false };
}

/**
 * 優化一段音樂 prompt。純函數、無副作用、同步執行——零成本零延遲。
 * 輸入已 trim 過。與 `invisible-prompt-director` 的規則層同構：偵測槽位 →
 * anti-slop → 偽標籤剝除 → mood 修剪 → 通路硬規則 → 補層 → 長度上限。
 */
export function directMusicPrompt(rawPrompt: string, options: MusicDirectorOptions = {}): MusicDirectorResult {
  const channel = options.channel ?? "lyria";
  const user = rawPrompt.trim();
  const layers = detectLayers(user);
  if (!user) {
    return { prompt: user, layers, applied: [], warnings: [], truncated: [] };
  }

  const applied: string[] = [];
  const warnings: string[] = [];

  // 1. anti-slop：缺陷詞／空泛片語 → 具體語彙；沒有替換目標的空詞只回報。
  const slopped = replaceAll(user, SLOP_WORDS);
  if (slopped !== user) applied.push("anti-slop");
  for (const word of findEmptyWords(slopped)) {
    warnings.push(
      `anti-slop: "${word}" carries no musical information and the library gives no concrete substitute (CORE_01_STYLE §1 Layer 2 · §4)`,
    );
  }

  // 2. 偽標籤剝除：假參數改寫成散文或刪除（所有平台都不解析）。
  const detagged = replaceAll(slopped, DEAD_PLAIN_TAGS);
  const tagRewritten = rewritePseudoTags(detagged);
  const rewroteTags = tagRewritten !== slopped;
  const untagged = rewroteTags ? tidySeparators(tagRewritten) : detagged;
  if (rewroteTags) applied.push("strip-pseudo-tags");

  // 3. MOOD ≤2：多的移除，並如實回報（相容性庫內無對照表，只能報數量）。
  const moods = findMoodWords(untagged);
  let shaped = untagged;
  if (moods.length > 2) {
    shaped = tidySeparators(trimExtraMoods(untagged, moods));
    applied.push("trim-mood");
    warnings.push(
      `mood: ${moods.length} mood words (${moods.join(", ")}) — keep one or two compatible ones (CORE_01_STYLE §1 Layer 2 · §4; CORE_03_DIAGNOSE §2 CHECK 4)`,
    );
  }

  // 4. 通路硬規則。
  let core = shaped;
  let limit: number | null = null;
  let allowNewline = true;
  if (channel === "flowmusic") {
    const stripped = stripTimestamps(core);
    if (stripped !== core) applied.push("strip-timestamps");
    core = stripped;
    if (options.hasLyrics ?? hasLyricsMarker(core)) {
      // 保版面分支：換行與標點保留，上限 3000 runes。
      limit = CHANNEL_LIMITS.flowmusicLayout;
    } else {
      // 平面分支：壓成單行，上限 220 runes。
      const collapsed = collapseToSingleLine(core);
      if (collapsed !== core) applied.push("collapse-single-line");
      core = collapsed;
      allowNewline = false;
      limit = CHANNEL_LIMITS.flowmusicFlat;
    }
  } else if (channel === "yue2") {
    // YuE2 硬規則（依凍結合約的能力邊界，2026-09-18）：
    //  ① 時間戳剝除：`[0:00 - 0:10]` 只有 Lyria 認，YuE2 不支援時間戳結構控制 → 剝掉
    //     （用同一個 stripTimestamps，只吃數字時間碼與舊式 (0-15s)）。
    //  ② [Verse]/[Chorus] 段落標籤**保留**：那是 YuE2 歌詞欄的必需語法，不是偽標籤，
    //     stripTimestamps 不動它（它只認數字時間碼），標籤原樣穿過。
    //  ③ style 是散文描述：允許換行，不做 collapse-single-line、不套 220 平面分支。
    //  ④ 上限 yue2Style＝600 runes 顯存預算（依據見 CHANNEL_LIMITS 註釋）。
    const stripped = stripTimestamps(core);
    if (stripped !== core) applied.push("strip-timestamps");
    core = stripped;
    limit = CHANNEL_LIMITS.yue2Style;
  }

  // 5. 缺層補中性指令（不替用戶決定流派／樂器／唱的人），再依上限組裝。
  const fills: Array<{ id: MusicLayerId; text: string }> = [];
  for (const id of MUSIC_LAYER_IDS) {
    if (!layers[id]) fills.push({ id, text: layerFill(id, options.durationSeconds) });
  }
  const assembled = assembleWithLimit(core, fills, limit, allowNewline);
  for (const id of assembled.kept) applied.push(`fill-${id}`);
  if (assembled.hardCapped) {
    applied.push(`truncate-${limit}-hard`);
  }

  // 6. 偵測到但無法確定性修補的缺口（如實回報，不虛報）。
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

  return {
    prompt: assembled.prompt,
    layers,
    applied,
    warnings,
    truncated: assembled.truncated,
  };
}
