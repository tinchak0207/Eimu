/** 目标通路。`flowmusic` = 生产 FlowMusic2API；`lyria` = Google Lyria；`yue2` = YuE2（Modal，白盒乐谱）。 */
export type MusicChannel = "flowmusic" | "lyria" | "yue2";

/** 六层风格公式的槽位 id。 */
export type MusicLayerId = "genre" | "mood" | "instrumentation" | "vocal" | "structure" | "production";

/**
 * 六层固定顺序（＝侦测与权重序）。来源：CORE_01_STYLE.md:35-40 §1、:965-973 §13。
 * 实送 flowmusic 的**有效排布**另经 frontLoadDecidingParams 前置决定性参数：
 * GENRE → 决定性参数（BPM／key／和弦进行／段落结构）→ MOOD → INSTRUMENTATION → VOCAL
 * → PRODUCTION（混音／空间修饰，放最后可被裁）。
 */
export const MUSIC_LAYER_IDS: readonly MusicLayerId[] = [
  "genre",
  "mood",
  "instrumentation",
  "vocal",
  "structure",
  "production",
];

export interface MusicDirectorOptions {
  /** 目标通路。缺省 `"lyria"`（保守：不动时间戳；时间戳在 flowmusic 是死控件）。 */
  channel?: MusicChannel;
  /** 文本是否含歌词／段落标签。缺省自动侦测（判别式同 DATA_FLOWMUSIC_2026-09.md:113-115 §3 step 2）。 */
  hasLyrics?: boolean;
  /** 上游模型 id。规则库对 model 家族无 prompt 控制差异（CORE_01／DATA_* 无此依据），收下不用。 */
  modelId?: string;
  /** 目标时长（秒）。≥120 时结构补层改用整曲措辞（DATA_FLOWMUSIC §4 实测成品 162–182s）。 */
  durationSeconds?: number;
  /**
   * 段落时长（秒），按序——P0-11 可判定校验的输入。现场无任何结构化段落栏位（grep 确认：
   * `MusicDirectorOptions` 只有整曲 durationSeconds，段落结构在 prompt 文本里以时间戳/散文出现），
   * 故这是**新增**的显式通道；未提供时退回从 prompt 文本侦测「N 段小节/秒」列表，再缺则跳过判定。
   */
  sectionSeconds?: number[];
  /** 委托方声明的段落数（与 sectionSeconds 个数比对）。未提供时从 prompt 文本侦测「N sections／N 段」。 */
  declaredSectionCount?: number;
}

export interface MusicDirectorResult {
  /** 导演化后的 prompt（纯函数决定性产物）。 */
  prompt: string;
  /** 用户原 prompt 的六层侦测结果（如实回报，不因补齐而变 true）。 */
  layers: Record<MusicLayerId, boolean>;
  /** 实际改写过的规则 id；没改就是空阵列。 */
  applied: string[];
  /** 侦测到但无法确定性修补的缺口（不得虚报）。 */
  warnings: string[];
  /** 因长度上限被整层丢弃的层 id（补层与按层压缩丢掉的核心子句层都算）。 */
  truncated: MusicLayerId[];
  /** 超限时按层压缩、整句丢弃的子句数（含层子句与非层细节子句）。缺省＝未发生压缩。 */
  compressedClauses?: number;
  /** 超限按层压缩时整句丢弃的核心子句层 id（只含用户原文本命中的层，供回执如实说明）。 */
  compressedLayers?: MusicLayerId[];
  /** 压缩后仍被迫在单一子句中途截断（极端情形：一句就长过上限）。true 时尾端可能不完整。 */
  hardTruncated?: boolean;
  /**
   * 结构化校验账（P0-11）：把「可判定的音乐学约束」落成机读结果，而非只留人话 warnings。
   * 每条判据都有明确判据与 expected/actual；输入不足的判据 ok:true 并在 detail 写明跳过原因
   * （不凭空判失败，也不假装通过）。**只判定，不改 prompt 内容**。
   */
  checks: PromptCheck[];
}

/** 校验账的一条（P0-11）：kind 为判据 id，ok 为结论，detail 写清失败在哪一段哪一个数。 */
export interface PromptCheck {
  /** 判据 id（`bpm-section-alignment`／`section-count`）。 */
  kind: string;
  /** 该判据是否通过；输入不足而跳过时为 true（detail 写明跳过原因，不算「通过」）。 */
  ok: boolean;
  /** 人可读细节：失败时逐条指出哪一段哪个数。 */
  detail: string;
  /** 判据的期望值（如应落在小节线上的段数、声明的段数）。 */
  expected?: number;
  /** 判据的实测值。 */
  actual?: number;
}

/**
 * 通路长度硬上限（runes = Unicode code points，Go 的 rune 语义）。
 * 来源：DATA_FLOWMUSIC_2026-09.md:94 §2 row ⑦、:117-121 §3 step 3-4（无歌词标签压单行 220；
 * 带 `歌词`／`lyrics`／段落标签走保版面分支 3000）；:204 §5 checklist 4（压在 ~220 内）。
 */
export const CHANNEL_LIMITS = {
  flowmusicFlat: 220,
  flowmusicLayout: 3000,
  /**
   * YuE2 style 栏上限 600 runes。依据（2026-09-28 本机 8GB 卡实测）：style 进 NAR prefill 的
   * prefix，1353 字 style＋500 token ABC 在 NAR 阶段 OOM；同单截到 600 字 → prefix 675、
   * 峰值 7.10 GiB、52.4 秒成片。自谱成功单 prefix 皆 ≤846。冻结合约无字数条款，这是显存预算。
   */
  yue2Style: 600,
} as const;

/** 整曲门槛（秒）：≥ 此值时结构补层讲「整曲」。来源：DATA_FLOWMUSIC_2026-09.md:148-159 §4（成品 162–182s）。 */
const LONG_TRACK_SECONDS = 120;

/**
 * 由低到高的丢弃权重：GENRE 承重排第一，其余依 CORE_01 §13 组装序递减。
 * 来源：CORE_01_STYLE.md:42 §1 Layer 1「load-bearing, goes first」、:965-973 §13 ORDER OF OPERATIONS、
 * :1010-1016 §13 LENGTH DISCIPLINE「Front-loading matters more than word count」。
 */
export const LAYER_WEIGHT: Record<MusicLayerId, number> = {
  genre: 6,
  mood: 5,
  instrumentation: 4,
  vocal: 3,
  structure: 2,
  production: 1,
};

/** 六层侦测词条（库内英文／罗马化词条；中文用词无库内依据，见档首说明）。 */
const GENRE_WORDS =
  "glam metal|heavy metal|metal|death metal|black metal|grunge|post-?punk|hardcore|punk|rockabilly|surf rock|math rock|alt-?rock|rock|nb-?rock|cool jazz|bebop|swing|jazz|delta blues|blues|bluegrass|americana|country|folk|soul|motown|funk|disco|r&b|rnb|boom bap|hip-?hop|trap|drill|phonk|rap|acid house|deep house|house|techno|trance|uk garage|garage|dubstep|drum and bass|dnb|dub|dancehall|reggae|ska|trip-?hop|downtempo|ambient|drone|shoegaze|dream pop|synthwave|vaporwave|retrowave|city pop|synth-?pop|k-?pop|j-?pop|electro|electronic|edm|idm|lo-?fi|bedroom pop|indie|alternative|emo|pop|baroque|classical|orchestral|cinematic|score|soundtrack|chamber|opera|choral|gospel|salsa|bossa nova|samba|tango|flamenco|cumbia|afrobeat|celtic|klezmer|gamelan|ballad|waltz|post-?rock|progressive|psychedelic|slowcore|neo-?soul|guofeng";

/** MOOD 词表＝CORE_01 §4 PALETTE 的 26 个主词＋括号内同义词。来源：CORE_01_STYLE.md:256-300 §4（PALETTE :261）。 */
const MOOD_WORDS =
  "uplifting|positive|lifting|melancholic|melancholy|sad|contemplative|haunting|eerie|lingering|dark|gloomy|ominous|joyful|happy|celebratory|nostalgic|wistful|romantic|tender|intense|powerful|dramatic|dreamy|ethereal|floating|peaceful|calm|unhurried|anxious|tense|unsettled|euphoric|blissful|ecstatic|mysterious|enigmatic|aggressive|confrontational|playful|teasing|bittersweet|triumphant|victorious|somber|grave|intimate|defiant|rebellious|vulnerable|exposed|sultry|sensual|brooding|introspective|weary|reverent|devotional";

/** INSTRUMENTATION 词表＝CORE_01 §5 的主张（乐器名）＋DATA_VOCAB §6 目录内的乐器项。 */
const INSTRUMENT_WORDS =
  "nylon-string|acoustic guitar|electric guitar|guitars?|grand piano|upright piano|pianos?|rhodes|wurlitzer|harpsichord|accordion|keyboards?|keys|synths?|synthesizers?|moog|pads?|organs?|violins?|violas?|cellos?|double bass|upright bass|strings|harps?|flutes?|dizi|piccolo|clarinets?|oboes?|bassoons?|saxophones?|sax|flugelhorn|trumpets?|trombones?|french horn|horns?|brass|tuba|drum kit|drums|kicks?|snares?|hi-?hats?|toms?|cymbals?|percussion|congas|congas?|bongos|timbales|tabla|taiko|timpani|glockenspiel|marimba|vibraphone|xylophone|808|sub bass|bassline|bass|banjos?|mandolins?|ukulele|sitars?|kotos?|shakuhachi|guzheng|erhu|pipa|sarod|oud|didgeridoo|steel drums?|pedal steel|lap steel|choir|vocoder";

/** VOCAL 词表＝CORE_01 §6 的四要素（性别／音域／角色／唱法）＋DATA_FLOWMUSIC 的器乐声明。 */
const VOCAL_WORDS =
  "vocals?|vocalist|singers?|voices?|male|female|tenor|alto|soprano|baritones?|falsetto|choir|choral|harmonies|harmony|backing vocals|ad-?libs|duet|humming|whispered|spoken word|rapped|instrumental|no vocals|a cappella|acapella";

/** STRUCTURE 侦测：方括号段落标签（DATA_FLOWMUSIC 判别式）＋结构词＋时间戳。 */
export const STRUCTURE_WORDS =
  "\\[(?:verse|chorus|bridge|intro|outro|pre-?chorus|hook|refrain|breakdown|drop|主歌|副歌|导歌|桥段|前奏|尾奏|间奏)\\]|\\b(?:verses?|choruses|bridges?|intros?|outros?|pre-?chorus|hooks?|refrain|coda|middle eight|call and response|aaba|twelve-?bar|strophic|through-?composed|buildups?|build-?up|breakdowns?|drops?)\\b|\\b\\d{1,2}:\\d{2}\\b";

/** PRODUCTION 侦测＝CORE_01 §9 的环境／混音语汇＋速度与调性的散文写法。 */
const PRODUCTION_WORDS =
  "\\b(?:produced|production|mixes?|mixing|master(?:ed|ing)?|reverbs?|delays?|echo(?:es)?|compression|compressed|sidechain|stereo|mono|width|tape|vinyl|analog(?:ue)?|valve|saturation|saturated|warm|polished|raw|gritty|spacious|punchy|minimal|dry|wet|close-?mic|room|hall|cathedral|studio|stage|live|concert|bpm|tempo|key of|front-?to-?back|hi-?fi|console|decay|headroom)\\b|\\b[a-g](?:\\s*#|\\s*b)?\\s*(?:major|minor)\\b";

/**
 * 六层侦测用正则。层存在时保留用户原话，缺漏时才补中性指令。
 * 来源：CORE_01_STYLE.md:29-100 §1（六层定义）、:965-973 §13（组装序）。
 */
export const MUSIC_LAYER_PATTERNS: Record<MusicLayerId, RegExp> = {
  genre: new RegExp(`(?:${GENRE_WORDS})`, "i"),
  mood: new RegExp(`\\b(?:${MOOD_WORDS})\\b`, "i"),
  instrumentation: new RegExp(`\\b(?:${INSTRUMENT_WORDS})\\b`, "i"),
  vocal: new RegExp(`\\b(?:${VOCAL_WORDS})\\b`, "i"),
  structure: new RegExp(`(?:${STRUCTURE_WORDS})`, "i"),
  production: new RegExp(`(?:${PRODUCTION_WORDS})`, "i"),
};

/** MOOD 全域版（计数／修剪用）。 */
export const MOOD_WORD_GLOBAL = new RegExp(`\\b(?:${MOOD_WORDS})\\b`, "gi");

/** 乐器全域版（计数用，CORE_03 §2 CHECK 3）。 */
export const INSTRUMENT_GLOBAL = new RegExp(`\\b(?:${INSTRUMENT_WORDS})\\b`, "gi");

/**
 * Anti-slop：空泛／缺陷词 → 具体可采样语汇。regex 只做标记，替换由 mapping 决定。
 * 语境相依的词（distortion／shimmer／compressed）刻意不收：
 * CORE_03_DIAGNOSE.md:389-395 §4 注 1-3 说它们在摇滚／pad 语境是合法描述，只在「用来排除」时才是 trigger，
 * 无上下文无法确定性判定，故不替换。
 */
export const SLOP_WORDS: ReadonlyArray<[RegExp, string]> = [
  // CORE_03_DIAGNOSE.md:359-404 §4 TRIGGER WORDS → WRITE INSTEAD 逐条
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
  // CORE_03_DIAGNOSE.md:190-203 §3 row 1：品质模式标签不存在 → 用描述表达
  // （[QUALITY: MAX] 等由 rewritePseudoTags 直接删除）
  // DATA_VOCAB.md:48-56 §1 THE SUBSTITUTION HABIT 的替换习惯逐条
  [/\bgood production\b/gi, "warm, close-mic, lightly compressed"],
  [/\bnice guitar\b/gi, "jangly clean tone with spring reverb"],
  [/\bcool drums\b/gi, "tight, punchy, slightly behind the beat"],
  [/\bbig sound\b/gi, "wide stereo with long hall decay"],
  [/\bprofessional\b/gi, "balanced, controlled, commercially polished"],
  // CORE_01_STYLE.md:303-313 §4：「epic」是 border case，trailer／cinematic 之外用 intense 表达
  [/\bepic\b/gi, "intense"],
];

/**
 * CORE_01 §4 的「看似情绪、其实没有音乐资讯」的空词。库内未给具体替换目标
 * （只说「spend prompt weight and return nothing」），故不替换、只记 warnings。
 * `cool` 刻意不收：CORE_01_STYLE.md:187 §3 的 substitution table 用「1959 New York cool jazz」
 * 当流派名，同库内双义，无上下文无法确定性判定。
 */
export const EMPTY_WORDS: readonly string[] = ["nice", "great", "beautiful", "amazing", "wonderful", "good", "vibey"];

/**
 * 伪标签：`[Key: Value]` 形式的假参数。key 必须以字母开头（排除 `[0:00]` 时间戳与
 * `[End - 2:15]` 这类旧式时间码），value 到 `]` 为止。
 * 来源：CORE_01_STYLE.md:100-110 §1「Bracketed parameter syntax was never parsed by any covered platform」、
 * CORE_03_DIAGNOSE.md:105-109 §2 CHECK 6「the highest-volume defect in circulating prompts」。
 */
export const PSEUDO_TAG_PATTERN = /\[([A-Za-z][A-Za-z0-9_ -]*?)\s*:\s*([^\]]+)\]/g;

/** 内容为 MAX 的品质模式假参数 key（整条删除）。来源：CORE_03_DIAGNOSE.md:190-203 §3 row 1。 */
export const MAX_MODE_KEYS: readonly string[] = ["is_max_mode", "quality", "realism", "real_instruments"];

/** ENERGY 假标签 → CORE_01 §4 的散文写法（ENERGY, AS PROSE）。来源：CORE_01_STYLE.md:290-297 §4。 */
export const ENERGY_PROSE: Record<string, string> = {
  low: "low energy, barely moving",
  medium: "steady mid-tempo drive",
  high: "full-force, everything at once",
  "low→high": "builds from near-silence to a wall",
  "low->high": "builds from near-silence to a wall",
  "low-high": "builds from near-silence to a wall",
};

/** 无冒号的死参数（CORE_03 §3 row 1／row 3 的 FIND 清单形式）。来源：CORE_03_DIAGNOSE.md:190-213 §3。 */
export const DEAD_PLAIN_TAGS: ReadonlyArray<[RegExp, string]> = [
  [/\[\s*wide stereo field\s*\]/gi, "wide stereo"],
  [/\[\s*sidechain\s*\]/gi, "pumping sidechain"],
  [/\(\s*max\s*\)(?:\s*\(\s*max\s*\))*/gi, ""],
];

/**
 * 明文噪声：markdown 变体里混进来的 JSON 参数、HTML 标签、代码围篱。上游不解析，
 * 占长度预算还可能污染生成。刻意不删 markdown 标题／粗体与 URL（语义争议大、误伤风险高，
 * 那类留给 warnings 而非确定性删除）。
 */
export const MARKUP_NOISE: ReadonlyArray<[RegExp, string]> = [
  [/```[A-Za-z0-9_+-]*/g, " "],
  [/<[^>\n]{1,80}>/g, " "],
  [/\{[^{}\n]{0,200}\}/g, " "],
];

/**
 * flowmusic 死控件：时间戳。来源：DATA_FLOWMUSIC_2026-09.md:88 §2 row ③「DOES NOT WORK —
 * time codes vanish before the song tool」、:95 row ⑧（`:`,`,`,`.` 被换成空格）、
 * CORE_03_DIAGNOSE.md:257-265 §3 row 9（含旧式 `Intro (0–15s)`／`[End - 2:15]`）。
 */
export const TIMESTAMP_BRACKETED = /\[\s*(?:end\s*[-–—]\s*)?\d{1,2}:\d{2}(?:[.:]\d{1,2})?(?:\s*[-–—]\s*\d{1,2}:\d{2}(?:[.:]\d{1,2})?)?\s*\]/gi;
export const TIMESTAMP_OLD_PARENTHETICAL = /\(\s*\d{1,2}(?:\s*[-–—]\s*\d{1,2})?\s*s\s*\)/gi;
export const TIMESTAMP_BARE = /\b\d{1,2}:\d{2}(?:[.:]\d{1,2})?(?:\s*[-–—]\s*\d{1,2}:\d{2}(?:[.:]\d{1,2})?)?/g;
/** 非全域侦测版（`/g` 的 `.test` 会带 lastIndex 状态，侦测一律用这些）。 */
export const TIMESTAMP_BRACKETED_DETECT = /\[\s*(?:end\s*[-–—]\s*)?\d{1,2}:\d{2}(?:[.:]\d{1,2})?(?:\s*[-–—]\s*\d{1,2}:\d{2}(?:[.:]\d{1,2})?)?\s*\]/i;
export const TIMESTAMP_OLD_PARENTHETICAL_DETECT = /\(\s*\d{1,2}(?:\s*[-–—]\s*\d{1,2})?\s*s\s*\)/i;
/** 整行恰为裸时间码（歌词剥除只删这种「独立成行」的，正文里的 0:12／3:45 不动）。 */
export const TIMESTAMP_BARE_LINE = /^\s*\d{1,2}:\d{2}(?:[.:]\d{1,2})?(?:\s*[-–—]\s*\d{1,2}:\d{2}(?:[.:]\d{1,2})?)?\s*$/;
/** 控制字元（保留 \t \n \r）：NUL 等混入 prompt 会污染上游，送前确定性清除。 */
export const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * 歌词标签判别式（决定 flowmusic 走 220 单行分支还是 3000 保版面分支）。
 * 来源：DATA_FLOWMUSIC_2026-09.md:113-117 §3 step 2-3（`歌词`／`lyrics` 或
 * `[verse] [chorus] [bridge] [intro] [outro] [pre-chorus] [主歌] [副歌] [导歌] [桥段] [前奏] [尾奏]`）。
 */
export const LYRICS_MARKER_PATTERN = /(歌词|lyrics)/i;
/**
 * 段落标签判别：`[Verse]` 与带序号的 `[Verse 1]`／带描述的 `[Chorus: big]` 都算
 * （对齐上游 FlowMusic 的歌词判准；旧版只认裸 `[Verse]` 会让带序号标签误走 220 平面分支被切）。
 */
export const SECTION_TAG_PATTERN =
  /\[(?:verse|chorus|bridge|intro|outro|pre-?chorus|主歌|副歌|导歌|桥段|前奏|尾奏|间奏)\b[^\]]*\]/i;

/** 伪标签里 key 是段落结构名（`[Verse 1: …]`／`[Chorus: …]`）＝结构语法，不是伪参数，原样保留。 */
export const SECTION_TAG_KEY_PATTERN =
  /^(?:verse|chorus|bridge|intro|outro|pre-?chorus|hook|refrain|breakdown|drop|主歌|副歌|导歌|桥段|前奏|尾奏|间奏)\b/i;

/**
 * 缺层补中性指令——不替用户决定流派／乐器／唱的人。
 * 措辞依 CORE_01_STYLE.md:965-973 §13 的六个决策问题（每层问什么就补什么指令）。
 */
const LAYER_FILLS: Record<MusicLayerId, string> = {
  genre: "Genre: name the tradition with its era or scene, first in the line.",
  mood: "Mood: one or two compatible feeling words.",
  instrumentation: "Instrumentation: two or three hero instruments, each with a playing-style word.",
  vocal: "Vocal: state who sings and how, positively — or say instrumental only, no vocals.",
  structure: "Structure: how it unfolds, section by section.",
  production: "Production: era, mix character and the room, with tempo and key as prose.",
};

export function replaceAll(prompt: string, table: ReadonlyArray<[RegExp, string]>): string {
  let out = prompt;
  for (const [pattern, replacement] of table) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** runes = Unicode code points（Go rune 语义；DATA_FLOWMUSIC 的上限以 rune 计）。 */
export function countRunes(text: string): number {
  return Array.from(text).length;
}

/** 每层缺漏时要补的句子；长曲的结构层讲「整曲」。 */
export function layerFill(id: MusicLayerId, durationSeconds?: number): string {
  const isLongTrack = durationSeconds !== undefined && durationSeconds >= LONG_TRACK_SECONDS;
  if (id === "structure" && isLongTrack) {
    return "Structure: how it unfolds across the full runtime, section by section.";
  }
  return LAYER_FILLS[id];
}

/** 侦测用户原 prompt 的六层在场情形（回报用，不因补齐而变真）。 */
export function detectLayers(prompt: string): Record<MusicLayerId, boolean> {
  const layers = {} as Record<MusicLayerId, boolean>;
  for (const id of MUSIC_LAYER_IDS) {
    layers[id] = MUSIC_LAYER_PATTERNS[id].test(prompt);
  }
  return layers;
}

/** 「最终 prompt 实际还在场什么」的如实判读结果。 */
export interface RetainedPromptInfo {
  /** 依最终字串命中的层（不是依层名推断）。 */
  layers: MusicLayerId[];
  /** 最终字串里真的还有 BPM／速度措辞？ */
  tempo: boolean;
  /** 最终字串里真的还有调性？ */
  key: boolean;
  /** 最终字串里真的还有无人声宣告？ */
  instrumentalDeclaration: boolean;
}

/**
 * 补层中性指令的全部字面文本（LAYER_FILLS 六条 ＋ 长曲结构变体；layerFill 只在这两组里取值）。
 * 判定「用户是否真的宣告了无人声」时必须先把这些**规则层自己写进去的**文案剥离——
 * 否则 vocal 补层文案自带 `…or say instrumental only, no vocals.`，会让「用户给了歌词、
 * 要人声」的委托被误判成「保住了无人声宣告」（2026-10-06 审计 3.1 压缩回执残留假阳）。
 */
const ALL_FILL_TEXTS: readonly string[] = [
  ...Object.values(LAYER_FILLS),
  "Structure: how it unfolds across the full runtime, section by section.",
];

/** 从待判定文本中移除所有补层文案（补层不是用户内容，不得参与「用户宣告了什么」的判定）。 */
export function stripLayerFills(text: string): string {
  let out = text;
  for (const fill of ALL_FILL_TEXTS) {
    if (out.includes(fill)) out = out.split(fill).join(" ");
  }
  return out;
}

