/**
 * 配音音色庫（刀 3：音色庫 + 角色音色綁定 + TTS 音色參數）。
 *
 * 輪子來源：gzxx-2025/aid-server（MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司）
 * 源檔：sql/aid-init.sql 的 `aid_ai_voice_library` 初始資料（行 426-428 起，63 筆 INSERT）
 * 取得日：2026-09-15
 * 逐字保留：`voice_code` / `voice_name` / `character_types` / `voice_styles` /
 *   `tone_tags` / `emotion_tags`（四維標籤 JSON 原字面，本站以 string[] 承接，內容一字未改）。
 * 欄位語義借鑑 AID schema（`aid_ai_voice_library` 32 欄、`aid_role_voice_binding` 31 欄、
 *   `aid_audio_asset` 28 欄），但本站**不建表 / 不加 migration**：音色 metadata 掛既有
 *   資產包 `AssetPackItem kind:"voice"`（Blob 持久化，見 asset-pack-store.ts 同構先例
 *   scene_3d/bpy_script），角色綁定語義由 `CharacterCard.voiceCode` 承接。
 * 排除項（明確不做）：口型同步（lip-sync 待暴君裁定）、在線剪輯/時間軸。
 *
 * ⚠️ 試聽誠實聲明（勿美化）：
 *   AID 的 `sample_url` / `avatar_url` 指向 AID 自建 OSS（`/aid/voice/sample/...`），
 *   **本站不可直連、亦無鏡像**。本檔保留 `sampleUrl` 原值只為溯源（資產包內欄位名
 *   `sourceSampleUrl`）。真正的試聽＝用本站 gateway 的 TTS adapter 以該 `voiceCode`
 *   真出聲；任何「可播 AID 樣本」的宣稱都是假的。
 *
 *   **更關鍵的實測事實（2026-09-15，直讀 VPS `/opt/edge-tts/tts-proxy.js` + 實彈探針）**：
 *   本站網關的 `synthSiliconFlow` 有 `if (!voice.includes(':')) voice = `${model}:alex``——
 *   AID 這 63 個火山 bigtts code **不含冒號**，在我們的網關上**全部被改寫成同一個
 *   `…:alex` 音**（實測回應固定在 SF 主路 32kHz 可佐證）。因此：
 *     - 63 筆 AID 種子 = **策展元資料**（標籤/文案/排序有價值），**不是**本站 63 個可聽音色；
 *     - 真正可試聽的是另立的實測白名單 `GATEWAY_VERIFIED_VOICES`（8 條，帶 `playable`）。
 *   未實彈前不得宣稱任何 code 在本站可出聲；`tts-upstream.ts` 的 artifact metadata
 *   `voice_effective` 欄位把此事實落成可查證資料（collapsed = 200 成功但不是該音色）。
 */

import { MAX_ITEMS_PER_PACK } from "./asset-pack-store";
import type { AssetPack, AssetPackItem } from "./asset-pack-store";
import type { CharacterCard } from "./character-cards";

/** 資產包內的音色條目 id（本站固定包，同構 blender-3d-assets 的確定性包 id 慣例）。 */
export const VOICE_LIBRARY_PACK_ID = "voice-library";
export const VOICE_LIBRARY_PACK_TITLE = "配音音色庫";

/** 溯源常量（測試與 notices 對齊用）。 */
export const VOICE_LIBRARY_SOURCE = {
  repo: "gzxx-2025/aid-server",
  file: "sql/aid-init.sql (aid_ai_voice_library, 行 426-428 起)",
  license: "MIT",
  copyright: "光子讯息(杭州)科技有限公司",
  fetchedAt: "2026-09-15",
  totalEntries: 63,
  /** AID 上游模型归属（aid_ai_model.id=42，火山 bigtts）。 */
  aidModelId: 42,
} as const;

export type VoiceGender = "female" | "male" | "neutral";

/** 音色條目（正規化後的站內形狀；欄位語義對齊 AID 同名欄）。 */
export interface VoiceEntry {
  /** AID `voice_code`：廠商側真實音色編碼，庫內唯一。 */
  voiceCode: string;
  voiceName: string;
  /** AID 原始樣本路徑（**不可直連**，僅溯源）。 */
  sampleUrl: string;
  sampleText: string;
  language: string;
  gender: VoiceGender;
  ageRange: string;
  characterTypes: string[];
  voiceStyles: string[];
  toneTags: string[];
  emotionTags: string[];
  supportsEmotion: boolean;
  supportsSpeed: boolean;
  supportsPitch: boolean;
  /** 0.5 ~ 2.0（AID default_speed）。 */
  defaultSpeed: number;
  /** -12 ~ 12（AID default_pitch）。 */
  defaultPitch: number;
  sampleRate: number;
  audioFormat: string;
  /** AID sort_order：數值越大越靠前。 */
  sortOrder: number;
  /**
   * 本站 gateway 實測可出**不同**音色（刀 3 探針，2026-09-15）。
   * **只由本檔的實測常量設定**，normalizeVoiceEntry 永不從 payload 收此欄——
   * playable 是「我們量過的事實」，不是呼叫端可宣稱的屬性。
   */
  playable?: boolean;
  /** playable 的證據一句話（哪條上游、什麼判據）；未實測則無此欄。 */
  playableEvidence?: string;
}

const MAX_VOICE_CODE_LENGTH = 128;
const MAX_VOICE_NAME_LENGTH = 100;
const MAX_SAMPLE_URL_LENGTH = 500;
const MAX_SAMPLE_TEXT_LENGTH = 500;
const MAX_TAG_LENGTH = 32;
const MAX_TAGS_PER_DIMENSION = 8;
const GENDERS: readonly VoiceGender[] = ["female", "male", "neutral"];
const AUDIO_FORMATS = ["mp3", "wav", "pcm", "ogg", "m4a"];

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= max ? clean : null;
}

function tagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH);
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= MAX_TAGS_PER_DIMENSION) break;
  }
  return out;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

/**
 * 純函式：把不可信 payload 正規化為 VoiceEntry（白名單清洗）。
 * 硬條件：voiceCode + voiceName 皆為非空字串，否則回 null。
 * 標籤各維去重/截斷（8 個 × 32 字）；數值越界回預設（speed 1.0 / pitch 0），
 * 不夾取——越界值屬壞資料，靜默夾取會把「上游不支援」偽裝成「支援」。
 * **playable / playableEvidence 永不由此函式產生**（它們是本站實測事實，
 * 呼叫端不得宣稱；只有本檔的 GATEWAY_VERIFIED_VOICES 帶此欄）。
 */
export function normalizeVoiceEntry(payload: unknown): VoiceEntry | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<VoiceEntry>;
  const voiceCode = boundedString(p.voiceCode, MAX_VOICE_CODE_LENGTH);
  const voiceName = boundedString(p.voiceName, MAX_VOICE_NAME_LENGTH);
  if (!voiceCode || !voiceName) return null;
  const format = typeof p.audioFormat === "string" ? p.audioFormat.trim().toLowerCase() : "";
  return {
    voiceCode,
    voiceName,
    sampleUrl: boundedString(p.sampleUrl, MAX_SAMPLE_URL_LENGTH) ?? "",
    sampleText: boundedString(p.sampleText, MAX_SAMPLE_TEXT_LENGTH) ?? "",
    language: boundedString(p.language, 16) ?? "",
    gender: GENDERS.includes(p.gender as VoiceGender) ? (p.gender as VoiceGender) : "neutral",
    ageRange: boundedString(p.ageRange, 16) ?? "",
    characterTypes: tagList(p.characterTypes),
    voiceStyles: tagList(p.voiceStyles),
    toneTags: tagList(p.toneTags),
    emotionTags: tagList(p.emotionTags),
    supportsEmotion: p.supportsEmotion === true,
    supportsSpeed: p.supportsSpeed === true,
    supportsPitch: p.supportsPitch === true,
    defaultSpeed: boundedNumber(p.defaultSpeed, 1.0, 0.5, 2.0),
    defaultPitch: boundedNumber(p.defaultPitch, 0.0, -12, 12),
    sampleRate: Math.round(boundedNumber(p.sampleRate, 0, 1, 192_000)),
    audioFormat: AUDIO_FORMATS.includes(format) ? format : "mp3",
    sortOrder: Math.round(boundedNumber(p.sortOrder, 0, 0, 1_000_000)),
  };
}

/**
 * 種子資料（63 筆，逐字取自 AID `aid_ai_voice_library`）。
 * 只入 metadata：不含任何本站可播放 URL（AID 樣本不可達，見檔頭聲明）。
 */
export const VOICE_LIBRARY_SEED: readonly VoiceEntry[] = [
  { voiceCode: "zh_female_vv_uranus_bigtts", voiceName: "Vivi 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/5e4fb1b33f494a9d8dfdd86dd07abbd8.mp3", sampleText: "你好呀，很高兴认识你~",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女"], voiceStyles: ["对话", "角色配音", "多语种"], toneTags: ["甜美", "温柔"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 500 },
  { voiceCode: "zh_female_xiaohe_uranus_bigtts", voiceName: "小何 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/4a6e7f33a55e4ec1808bd45474200113.mp3", sampleText: "我一直都在这里等你呢。",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女"], voiceStyles: ["对话", "角色配音"], toneTags: ["甜美", "温柔"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 499 },
  { voiceCode: "zh_male_m191_uranus_bigtts", voiceName: "云舟 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/6f2e19af65634bed83125b90bb9425e8.mp3", sampleText: "放心，有我在，不会有事的。",
    language: "zh-CN", gender: "male", ageRange: "young",
    characterTypes: ["少年", "青年"], voiceStyles: ["对话", "角色配音"], toneTags: ["沉稳", "磁性"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 498 },
  { voiceCode: "zh_male_taocheng_uranus_bigtts", voiceName: "小天 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/8a02c38a64244725a363b1067cb45604.mp3", sampleText: "嘿，今天咱们去哪儿玩？",
    language: "zh-CN", gender: "male", ageRange: "young",
    characterTypes: ["少年", "青年"], voiceStyles: ["对话"], toneTags: ["开朗"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 497 },
  { voiceCode: "zh_male_liufei_uranus_bigtts", voiceName: "刘飞 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/3db9e2eb24d5438a80cf8a3d2c948b54.mp3", sampleText: "这事儿我来处理，你别担心。",
    language: "zh-CN", gender: "male", ageRange: "adult",
    characterTypes: ["大叔"], voiceStyles: ["对话", "角色配音"], toneTags: ["沉稳"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 496 },
  { voiceCode: "zh_female_qingxinnvsheng_uranus_bigtts", voiceName: "清新女声 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/a9892445b9914ffea7c4c3330c195ae5.mp3", sampleText: "春天来了，花儿都开了。",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女"], voiceStyles: ["对话", "旁白"], toneTags: ["清澈", "甜美"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 494 },
  { voiceCode: "zh_female_tianmeitaozi_uranus_bigtts", voiceName: "甜美桃子 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/5324a8e760334d43b6db544ae15e7703.mp3", sampleText: "哇，这个好有趣呀！",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女"], voiceStyles: ["对话"], toneTags: ["甜美", "活泼"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 492 },
  { voiceCode: "zh_female_shuangkuaisisi_uranus_bigtts", voiceName: "爽快思思 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/562afc7ad7294fec84281d242bb6c099.mp3", sampleText: "快来试试吧，绝对不会后悔！",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女"], voiceStyles: ["对话", "广告"], toneTags: ["直率", "活泼"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 491 },
  { voiceCode: "zh_female_meilinvyou_uranus_bigtts", voiceName: "魅力女友 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/2edf0833e5d94ecf9604addb305a9cd6.mp3", sampleText: "今天累不累？我给你泡了茶。",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女", "御姐"], voiceStyles: ["对话", "角色配音"], toneTags: ["温柔", "磁性"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 488 },
  { voiceCode: "zh_female_wenroumama_uranus_bigtts", voiceName: "温柔妈妈 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/ec771ff3e8544e5491dbf9d3307b970c.mp3", sampleText: "慢点吃，别急，还有呢。",
    language: "zh-CN", gender: "female", ageRange: "middle",
    characterTypes: ["妈妈"], voiceStyles: ["对话", "旁白"], toneTags: ["温柔", "温暖"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 487 },
  { voiceCode: "zh_female_tvbnv_uranus_bigtts", voiceName: "TVB女声 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/1ab34b6a027a404e8cd6362747d3cabb.mp3", sampleText: "做人嘛，最紧要开心啦。",
    language: "zh-CN", gender: "female", ageRange: "adult",
    characterTypes: ["御姐"], voiceStyles: ["对话", "角色配音"], toneTags: ["磁性", "温柔"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 485 },
  { voiceCode: "zh_male_yizhipiannan_uranus_bigtts", voiceName: "译制片男 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/6ee25d6058d84ef487a5d999e51606f5.mp3", sampleText: "在一个遥远的地方，流传着一段传说。",
    language: "zh-CN", gender: "male", ageRange: "middle",
    characterTypes: ["大叔"], voiceStyles: ["旁白", "角色配音"], toneTags: ["沉稳", "磁性"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 484 },
  { voiceCode: "zh_female_qiaopinv_uranus_bigtts", voiceName: "俏皮女声 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/cc09dba05b8d48d3af3c8fc07d7d297b.mp3", sampleText: "哈哈，你猜我准备了什么惊喜？",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女"], voiceStyles: ["对话", "视频配音"], toneTags: ["活泼", "甜美"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 483 },
  { voiceCode: "zh_male_ruyaqingnian_uranus_bigtts", voiceName: "儒雅青年 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/f7d3040a84884984a144a3dd2a6ce4c8.mp3", sampleText: "且听风吟，岁月静好。",
    language: "zh-CN", gender: "male", ageRange: "young",
    characterTypes: ["青年"], voiceStyles: ["对话", "旁白"], toneTags: ["儒雅", "温柔"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 481 },
  { voiceCode: "zh_female_popo_uranus_bigtts", voiceName: "婆婆 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/54eb74a8c0d74fbb938e85ae475c10f5.mp3", sampleText: "孩子，天冷了，多穿点衣服。",
    language: "zh-CN", gender: "female", ageRange: "elderly",
    characterTypes: ["奶奶", "老者"], voiceStyles: ["角色配音", "视频配音"], toneTags: ["温暖"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 478 },
  { voiceCode: "zh_male_fanjuanqingnian_uranus_bigtts", voiceName: "反卷青年 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/3c16ec808a234053a14dbe3500e41ae3.mp3", sampleText: "卷什么卷，躺平不好吗？",
    language: "zh-CN", gender: "male", ageRange: "young",
    characterTypes: ["青年"], voiceStyles: ["对话"], toneTags: ["直率"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 475 },
  { voiceCode: "zh_female_wenroushunv_uranus_bigtts", voiceName: "温柔淑女 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/f849b2897a8946669d3c437806f63343.mp3", sampleText: "翻开这一页，故事才刚刚开始。",
    language: "zh-CN", gender: "female", ageRange: "adult",
    characterTypes: ["御姐"], voiceStyles: ["对话", "有声书"], toneTags: ["温柔"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 474 },
  { voiceCode: "zh_male_huolixiaoge_uranus_bigtts", voiceName: "活力小哥 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/6b988080f1c9455587d0c7573a62b3b4.mp3", sampleText: "走！现在就出发吧！",
    language: "zh-CN", gender: "male", ageRange: "young",
    characterTypes: ["弟弟", "少年"], voiceStyles: ["对话", "有声书"], toneTags: ["开朗", "活泼"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 473 },
  { voiceCode: "zh_female_mengyatou_uranus_bigtts", voiceName: "萌丫头 Cutey 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/34e76690fd734eeaa62ba4213d62a69f.mp3", sampleText: "诶嘿，又被你发现啦~",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女"], voiceStyles: ["对话"], toneTags: ["甜美", "奶气"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 472 },
  { voiceCode: "zh_female_tiexinnvsheng_uranus_bigtts", voiceName: "贴心女声 Candy 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/90274f9cbcf542b5babdbd15a85b28a9.mp3", sampleText: "没事的，有我在呢。",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女"], voiceStyles: ["对话"], toneTags: ["温柔", "温暖"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 471 },
  { voiceCode: "zh_female_jitangmei_uranus_bigtts", voiceName: "鸡汤妹妹 Hope 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/7af7b39289a64477b3d71184ad9e3e25.mp3", sampleText: "相信自己，你比想象中更强大。",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女"], voiceStyles: ["有声书", "对话"], toneTags: ["温柔", "温暖"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 470 },
  { voiceCode: "zh_male_cixingjieshuonan_uranus_bigtts", voiceName: "磁性解说男声 Morgan 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/57ffde9d94754e3a88a2bc0a8315eabf.mp3", sampleText: "一切精彩，尽在本期节目。",
    language: "zh-CN", gender: "male", ageRange: "adult",
    characterTypes: ["大叔"], voiceStyles: ["旁白", "广告"], toneTags: ["磁性", "沉稳"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 469 },
  { voiceCode: "zh_male_liangsangmengzai_uranus_bigtts", voiceName: "亮嗓萌仔 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/41a0eb8ce088481cbeea2679f3bc7b9d.mp3", sampleText: "啦啦啦，今天要玩什么呀？",
    language: "zh-CN", gender: "male", ageRange: "child",
    characterTypes: ["正太", "儿童"], voiceStyles: ["角色配音"], toneTags: ["奶气", "活泼"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 468 },
  { voiceCode: "zh_male_gaolengchenwen_uranus_bigtts", voiceName: "高冷沉稳 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/ac9742042bc043f190163929c1e3a4de.mp3", sampleText: "真相只有一个，请耐心听我说完。",
    language: "zh-CN", gender: "male", ageRange: "adult",
    characterTypes: ["大叔"], voiceStyles: ["旁白", "有声书"], toneTags: ["高冷", "沉稳"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 466 },
  { voiceCode: "zh_male_shenyeboke_uranus_bigtts", voiceName: "深夜播客 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/3c4379accd3b4147a773c523db38ecf5.mp3", sampleText: "夜深了，来听我讲个故事吧。",
    language: "zh-CN", gender: "male", ageRange: "adult",
    characterTypes: ["大叔"], voiceStyles: ["播客", "旁白"], toneTags: ["磁性", "沉稳"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 465 },
  { voiceCode: "zh_male_kailangxuezhang_uranus_bigtts", voiceName: "开朗学长 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/5cbe1d06057045169338b4c7306a0e91.mp3", sampleText: "学弟学妹，加油，你可以的！",
    language: "zh-CN", gender: "male", ageRange: "young",
    characterTypes: ["少年", "学生"], voiceStyles: ["对话", "角色配音"], toneTags: ["开朗"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 459 },
  { voiceCode: "zh_male_youyoujunzi_uranus_bigtts", voiceName: "悠悠君子 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/06c2490ba7c246299e252e8052c1e8ac.mp3", sampleText: "君子之交淡如水，且行且珍惜。",
    language: "zh-CN", gender: "male", ageRange: "young",
    characterTypes: ["青年", "公子"], voiceStyles: ["有声书", "角色配音"], toneTags: ["儒雅", "温柔"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 458 },
  { voiceCode: "zh_female_wenjingmaomao_uranus_bigtts", voiceName: "文静毛毛 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/e9f45d460d3a490699c2082a2d908818.mp3", sampleText: "嘘……小声一点哦。",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女"], voiceStyles: ["视频配音", "对话"], toneTags: ["温柔"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 457 },
  { voiceCode: "zh_female_zhixingnv_uranus_bigtts", voiceName: "知性女声 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/ca18a9c899254715a2c139739cdd08a3.mp3", sampleText: "这段历史，要从很久以前讲起。",
    language: "zh-CN", gender: "female", ageRange: "adult",
    characterTypes: ["御姐"], voiceStyles: ["旁白", "对话"], toneTags: ["沉稳", "温柔"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 456 },
  { voiceCode: "zh_male_qingshuangnanda_uranus_bigtts", voiceName: "清爽男大 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/ea289e69882b40b19ec03684a041868c.mp3", sampleText: "下课后篮球场见，不见不散！",
    language: "zh-CN", gender: "male", ageRange: "young",
    characterTypes: ["少年", "学生"], voiceStyles: ["对话"], toneTags: ["清澈", "开朗"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 455 },
  { voiceCode: "zh_male_wenrouxiaoge_uranus_bigtts", voiceName: "温柔小哥 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/1467caf9dc6148f0990bd33813b87fb2.mp3", sampleText: "别怕，把手给我，我牵着你。",
    language: "zh-CN", gender: "male", ageRange: "young",
    characterTypes: ["男友", "弟弟"], voiceStyles: ["对话", "角色配音"], toneTags: ["温柔"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 449 },
  { voiceCode: "zh_female_roumeinvyou_uranus_bigtts", voiceName: "柔美女友 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/cf5a033cc30a4d8e9de995ba36f96276.mp3", sampleText: "欢迎回来，今天辛苦啦。",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女", "御姐"], voiceStyles: ["对话", "角色配音"], toneTags: ["温柔"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 448 },
  { voiceCode: "zh_male_dongfanghaoran_uranus_bigtts", voiceName: "东方浩然 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/b9e1eb2931f04bedb94137a3f98450d3.mp3", sampleText: "浩然正气，长存于天地之间。",
    language: "zh-CN", gender: "male", ageRange: "adult",
    characterTypes: ["大叔"], voiceStyles: ["有声书", "旁白"], toneTags: ["磁性", "沉稳"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 447 },
  { voiceCode: "zh_female_wenrouxiaoya_uranus_bigtts", voiceName: "温柔小雅 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/62442fe36bea4acb97ed83fe22f5f285.mp3", sampleText: "慢慢来，一切都会好起来的。",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女"], voiceStyles: ["视频配音", "对话"], toneTags: ["温柔", "甜美"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 446 },
  { voiceCode: "zh_male_tiancaitongsheng_uranus_bigtts", voiceName: "天才童声 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/9ce6284a3d174a738259da86c2b0a500.mp3", sampleText: "我知道答案！让我来回答！",
    language: "zh-CN", gender: "male", ageRange: "child",
    characterTypes: ["儿童", "正太"], voiceStyles: ["视频配音", "角色配音"], toneTags: ["奶气", "活泼"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 445 },
  { voiceCode: "zh_male_guanggaojieshuo_uranus_bigtts", voiceName: "广告解说 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/73a94fd609b641f6b17535c12a2794ca.mp3", sampleText: "限时优惠，错过再等一年！",
    language: "zh-CN", gender: "male", ageRange: "adult",
    characterTypes: ["大叔"], voiceStyles: ["广告", "旁白"], toneTags: ["磁性", "沉稳"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 444 },
  { voiceCode: "zh_female_sajiaoxuemei_uranus_bigtts", voiceName: "撒娇学妹 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/0231e7cbe4514ebf8d56273d9e0f88af.mp3", sampleText: "学长，你就帮帮我嘛~",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女", "学生"], voiceStyles: ["角色配音", "对话"], toneTags: ["甜美", "活泼"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 429 },
  { voiceCode: "zh_male_silang_uranus_bigtts", voiceName: "四郎 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/8770faeba42f487fa0423aa14c5a6ab1.mp3", sampleText: "朕意已决，不必再议。",
    language: "zh-CN", gender: "male", ageRange: "adult",
    characterTypes: ["IP人物"], voiceStyles: ["角色配音", "视频配音"], toneTags: ["磁性", "沉稳"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 427 },
  { voiceCode: "zh_male_xionger_uranus_bigtts", voiceName: "熊二 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/371f69569e214dac9263d0ce067f4418.mp3", sampleText: "熊大熊大，你等等俺呀！",
    language: "zh-CN", gender: "male", ageRange: "adult",
    characterTypes: ["IP人物"], voiceStyles: ["角色配音", "视频配音"], toneTags: ["开朗", "奶气"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 425 },
  { voiceCode: "zh_male_lanyinmianbao_uranus_bigtts", voiceName: "懒音绵宝 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/a08b1e2f55b44e8bbcac07a038fdfc0c.mp3", sampleText: "唔……再让我睡五分钟嘛……",
    language: "zh-CN", gender: "male", ageRange: "young",
    characterTypes: ["弟弟", "少年"], voiceStyles: ["角色配音"], toneTags: ["慵懒", "奶气"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 423 },
  { voiceCode: "zh_female_gufengshaoyu_uranus_bigtts", voiceName: "古风少御 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/7800fe0465e44709938b6e74205b3b65.mp3", sampleText: "红尘万丈，不过大梦一场。",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["御姐"], voiceStyles: ["角色配音", "有声书"], toneTags: ["清冷", "温柔"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 422 },
  { voiceCode: "zh_female_wuzetian_uranus_bigtts", voiceName: "武则天 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/d6b9aec619eb446cbdc22f39f8b60844.mp3", sampleText: "朕即天下，谁敢不从？",
    language: "zh-CN", gender: "female", ageRange: "middle",
    characterTypes: ["御姐", "IP人物"], voiceStyles: ["角色配音", "有声书"], toneTags: ["霸气", "高冷"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 412 },
  { voiceCode: "zh_female_gujie_uranus_bigtts", voiceName: "顾姐 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/ff4a09372cae4db08de5118f3798af00.mp3", sampleText: "这事就按我说的办。",
    language: "zh-CN", gender: "female", ageRange: "adult",
    characterTypes: ["御姐", "IP人物"], voiceStyles: ["角色配音", "视频配音"], toneTags: ["磁性", "沉稳"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 411 },
  { voiceCode: "zh_female_peiqi_uranus_bigtts", voiceName: "佩奇猪 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/6db86b36876b43248e4633b4f94f3df0.mp3", sampleText: "乔治，我们一起跳泥坑吧！",
    language: "zh-CN", gender: "female", ageRange: "child",
    characterTypes: ["IP人物", "儿童"], voiceStyles: ["视频配音", "角色配音"], toneTags: ["奶气", "活泼"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 400 },
  { voiceCode: "zh_male_sunwukong_uranus_bigtts", voiceName: "猴哥 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/2923ba26c2b74c6a868c8959ed62fff5.mp3", sampleText: "俺老孙来也！吃俺一棒！",
    language: "zh-CN", gender: "male", ageRange: "adult",
    characterTypes: ["IP人物"], voiceStyles: ["视频配音", "角色配音"], toneTags: ["开朗", "磁性"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 399 },
  { voiceCode: "zh_male_dayi_uranus_bigtts", voiceName: "大壹 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/af46a0b13fa341cc9d2b5959cacfb41c.mp3", sampleText: "大家好，我是大壹，欢迎收看！",
    language: "zh-CN", gender: "male", ageRange: "young",
    characterTypes: ["青年"], voiceStyles: ["视频配音", "对话"], toneTags: ["开朗", "清澈"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 398 },
  { voiceCode: "zh_female_mizai_uranus_bigtts", voiceName: "黑猫侦探社咪仔 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/a94aab93f8a34d7688c410e6fb9488aa.mp3", sampleText: "喵~真相就藏在这些线索里！",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女", "IP人物"], voiceStyles: ["视频配音", "角色配音"], toneTags: ["奶气", "活泼"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 397 },
  { voiceCode: "zh_female_jitangnv_uranus_bigtts", voiceName: "鸡汤女 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/0dcaa8e4883e4e54b8b631ff3a63858a.mp3", sampleText: "你不是失败，你只是在成长。",
    language: "zh-CN", gender: "female", ageRange: "adult",
    characterTypes: ["御姐"], voiceStyles: ["视频配音", "有声书"], toneTags: ["温暖", "温柔"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 396 },
  { voiceCode: "zh_female_liuchangnv_uranus_bigtts", voiceName: "流畅女声 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/5827b7393e28490e875c4daa81071a06.mp3", sampleText: "从数据来看，这个结论很清晰。",
    language: "zh-CN", gender: "female", ageRange: "adult",
    characterTypes: ["御姐"], voiceStyles: ["视频配音", "旁白"], toneTags: ["清澈"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 395 },
  { voiceCode: "zh_male_ruyayichen_uranus_bigtts", voiceName: "儒雅逸辰 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/e1146906eda54599a5a4b8e4c34f51da.mp3", sampleText: "世间万物，皆有定数。",
    language: "zh-CN", gender: "male", ageRange: "young",
    characterTypes: ["公子", "青年"], voiceStyles: ["视频配音", "有声书"], toneTags: ["儒雅", "温柔"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 394 },
  { voiceCode: "zh_female_yingyujiaoxue_uranus_bigtts", voiceName: "Tina老师 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/b1603ad049d64b32b47338306f589865.mp3", sampleText: "同学们好，今天我们来学习新知识。",
    language: "zh-CN", gender: "female", ageRange: "adult",
    characterTypes: ["御姐"], voiceStyles: ["教育", "对话"], toneTags: ["温柔", "清澈"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 380 },
  { voiceCode: "zh_female_xiaoxue_uranus_bigtts", voiceName: "儿童绘本 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/707028c66389476fad43928cc12c376d.mp3", sampleText: "很久很久以前，有一座美丽的城堡。",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女"], voiceStyles: ["有声书", "教育"], toneTags: ["温柔", "甜美", "清澈"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 360 },
  { voiceCode: "zh_male_xuanyijieshuo_uranus_bigtts", voiceName: "悬疑解说 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/02b08f290ff74a07ac7ac5c04329b7f5.mp3", sampleText: "当夜幕降临，秘密才会浮出水面。",
    language: "zh-CN", gender: "male", ageRange: "adult",
    characterTypes: ["大叔"], voiceStyles: ["有声书", "旁白"], toneTags: ["沉稳", "磁性", "冷艳"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 358 },
  { voiceCode: "zh_female_shaoergushi_uranus_bigtts", voiceName: "少儿故事 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/2fd4603bd7fb452ab92f9a3c33f30e74.mp3", sampleText: "小兔子乖乖，把门儿开开~",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女"], voiceStyles: ["有声书", "教育"], toneTags: ["甜美", "温柔", "奶气"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 357 },
  { voiceCode: "saturn_zh_female_tiaopigongzhu_tob", voiceName: "调皮公主", sampleUrl: "/aid/voice/sample/2026/05/17/7c3fc521d0b04562bdb20d33cd8b1f38.mp3", sampleText: "哼！我才不要听你的呢！",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女"], voiceStyles: ["角色配音"], toneTags: ["活泼", "甜美"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 320 },
  { voiceCode: "saturn_zh_female_keainvsheng_tob", voiceName: "可爱女生", sampleUrl: "/aid/voice/sample/2026/05/17/7a825be4ba3f4460a28484c67e3e6e5d.mp3", sampleText: "嘿嘿，今天放学去哪儿玩？",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["少女", "学生"], voiceStyles: ["角色配音", "对话"], toneTags: ["甜美", "活泼"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 319 },
  { voiceCode: "saturn_zh_male_shuanglangshaonian_tob", voiceName: "爽朗少年", sampleUrl: "/aid/voice/sample/2026/05/17/ae6aa5c9491e41eb85fffe7854efef6a.mp3", sampleText: "爽快！这事就这么定了！",
    language: "zh-CN", gender: "male", ageRange: "teen",
    characterTypes: ["少年"], voiceStyles: ["角色配音", "对话"], toneTags: ["开朗", "直率"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 318 },
  { voiceCode: "saturn_zh_male_tiancaitongzhuo_tob", voiceName: "天才同桌", sampleUrl: "/aid/voice/sample/2026/05/17/8712be534d774d67b2280d48ebecc9cf.mp3", sampleText: "这道题的解法，其实很简单。",
    language: "zh-CN", gender: "male", ageRange: "teen",
    characterTypes: ["少年", "学霸", "学生"], voiceStyles: ["角色配音", "对话"], toneTags: ["儒雅", "清澈"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 317 },
  { voiceCode: "saturn_zh_female_cancan_tob", voiceName: "知性灿灿", sampleUrl: "/aid/voice/sample/2026/05/17/a8b4e99bdeb84b8db6c0b8cd077bb35f.mp3", sampleText: "世事洞明皆学问，人情练达即文章。",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["御姐"], voiceStyles: ["角色配音", "对话"], toneTags: ["温柔", "磁性"], emotionTags: ["ASMR"],
    supportsEmotion: true, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 316 },
  { voiceCode: "saturn_zh_female_qingyingduoduo_cs_tob", voiceName: "轻盈朵朵 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/2694a65dd7cc47c38bbfdbb581f97443.mp3", sampleText: "您请放心，我这就为您查询。",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["客服"], voiceStyles: ["客服", "对话"], toneTags: ["清澈", "甜美"], emotionTags: [],
    supportsEmotion: false, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 280 },
  { voiceCode: "saturn_zh_female_wenwanshanshan_cs_tob", voiceName: "温婉珊珊 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/2bad83e9ad654c8d9f19800ae4c359e0.mp3", sampleText: "感谢您的耐心等待，已经处理好了。",
    language: "zh-CN", gender: "female", ageRange: "adult",
    characterTypes: ["客服"], voiceStyles: ["客服", "对话"], toneTags: ["温柔", "温暖"], emotionTags: [],
    supportsEmotion: false, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 279 },
  { voiceCode: "saturn_zh_female_reqingaina_cs_tob", voiceName: "热情艾娜 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/07c76ea5e7e1410aa13d851c248ea3f1.mp3", sampleText: "您好呀！很高兴为您服务！",
    language: "zh-CN", gender: "female", ageRange: "young",
    characterTypes: ["客服"], voiceStyles: ["客服", "对话"], toneTags: ["开朗", "温暖"], emotionTags: [],
    supportsEmotion: false, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 278 },
  { voiceCode: "saturn_zh_male_qingxinmumu_cs_tob", voiceName: "清新沐沐 2.0", sampleUrl: "/aid/voice/sample/2026/05/17/2a88580f318246c7b3e8f59d69666ce7.mp3", sampleText: "您的问题我已经记录，马上跟进。",
    language: "zh-CN", gender: "male", ageRange: "young",
    characterTypes: ["客服"], voiceStyles: ["客服", "对话"], toneTags: ["清澈", "温柔"], emotionTags: [],
    supportsEmotion: false, supportsSpeed: true, supportsPitch: true, defaultSpeed: 1.0, defaultPitch: 0.0,
    sampleRate: 24000, audioFormat: "mp3", sortOrder: 277 },
];

// ─────────────────────────────────────────── 本站 gateway 實測可播音色（刀 3 探針）

/**
 * 本站 TTS gateway（VPS /opt/edge-tts/tts-proxy.js）**實測可出不同音色**的編碼。
 *
 * 為什麼必須另立一組、不能拿 AID 種子充數（2026-09-15 直讀 VPS 源碼 + 實彈探針）：
 *   `synthSiliconFlow` 有一行 `if (!voice.includes(':')) voice = `${model}:alex``。
 *   AID 的 63 個火山 bigtts code（如 `zh_female_vv_uranus_bigtts`）**不含冒號**，
 *   走到這裡一律被改寫成 `FunAudioLLM/CosyVoice2-0.5B:alex` —— 63 筆音色在我們的
 *   網關上**全部塌縮成同一個聲音**。實測佐證：這些 code 的回應固定為 32kHz
 *   （SiliconFlow 主路），與 `model:alex` 同路。
 *   同理 `zh-CN-XiaoxiaoNeural` 這類 edge 音色名也不含冒號 → 同樣被改寫；
 *   edge 路徑只在 SF 失敗時才走，故在生產亦不可達。
 *
 * 因此「可試聽」只剩 SF 的 `<model>:<preset>` 形式。以下 8 個 preset 實彈驗證：
 *   POST 127.0.0.1:8893/openai/v1/audio/speech → 200 + 32kHz MP3（SF 主路，
 *   非 edge 24kHz 降級），且不同 preset 回應位元組分佈互異。
 *   `echo`~`olivia` 等名稱實測落到 24kHz（＝SF 拒絕後 edge 降級 + 默認音），**不可用**。
 *
 * 誠實邊界：SF 輸出非確定（同 preset 兩次位元組不同），故判據以「回應取樣率落在
 * SF 主路」＋「preset 名直達上游」為準，不以位元組相等宣稱。性別/年齡未經聲學量測，
 * 一律標 neutral/未知，不臆造標籤。
 */
export const GATEWAY_TTS_MODEL = "FunAudioLLM/CosyVoice2-0.5B";
export const GATEWAY_VERIFIED_VOICE_PRESETS = [
  "alex",
  "anna",
  "bella",
  "benjamin",
  "charles",
  "claire",
  "david",
  "diana",
] as const;

const PLAYABLE_EVIDENCE =
  "本站 gateway 實測（2026-09-15）：POST 127.0.0.1:8893/openai/v1/audio/speech 回 200 + 32kHz MP3（SiliconFlow 主路，非 edge 24kHz 降級），preset 名直達上游。";

/** 由實測常量生成的可播音色條目（playable 只在此處設定，永不從 payload 收）。 */
export const GATEWAY_VERIFIED_VOICES: readonly VoiceEntry[] = GATEWAY_VERIFIED_VOICE_PRESETS.map(
  (preset, index) => ({
    voiceCode: `${GATEWAY_TTS_MODEL}:${preset}`,
    voiceName: preset,
    sampleUrl: "",
    sampleText: "试听验证：这是一段用于确认音色可出声的测试文本。",
    language: "zh-CN",
    gender: "neutral" as const,
    ageRange: "",
    characterTypes: [],
    voiceStyles: [],
    toneTags: [],
    emotionTags: [],
    supportsEmotion: false,
    supportsSpeed: true,
    supportsPitch: false,
    defaultSpeed: 1.0,
    defaultPitch: 0.0,
    sampleRate: 32_000,
    audioFormat: "mp3",
    // sortOrder 置於 AID 種子之上（AID 種子最高 500）：資產包有 50 條上限，
    // 可試聽集必須先入包（AID 種子僅策展元資料，可截斷；能力事實不可截斷）。
    sortOrder: 600 - index,
    playable: true,
    playableEvidence: PLAYABLE_EVIDENCE,
  }),
);

/** 全庫＝AID 策展種子 ∪ 本站實測可播集（查詢/打包只認這一份）。 */
export const ALL_VOICE_ENTRIES: readonly VoiceEntry[] = [...VOICE_LIBRARY_SEED, ...GATEWAY_VERIFIED_VOICES];

// ─────────────────────────────────────────── 查詢與資產包映射

/** 依 voiceCode 查庫（唯一鍵；查無回 null，呼叫端不得假裝命中）。 */
export function voiceEntryByCode(voiceCode: unknown): VoiceEntry | null {
  const code = boundedString(voiceCode, MAX_VOICE_CODE_LENGTH);
  if (!code) return null;
  return ALL_VOICE_ENTRIES.find((entry) => entry.voiceCode === code) ?? null;
}

/** 全庫（sort_order 由大到小，與 AID 展示序一致；線序穩定）。 */
export function listVoiceEntries(): VoiceEntry[] {
  return [...ALL_VOICE_ENTRIES].sort((a, b) => b.sortOrder - a.sortOrder);
}

/**
 * 本站可試聽音色（實測白名單）：UI 的試聽入口只該列這些。
 * 庫內其餘條目（AID 63 筆）**不是**本站可播音色——它們是策展元資料，
 * 在本站網關會被改寫成 alex（見 GATEWAY_VERIFIED_VOICES 檔頭證據）。
 */
export function listPlayableVoiceEntries(): VoiceEntry[] {
  return listVoiceEntries().filter((entry) => entry.playable === true);
}

/** 音色條目 → 資產包 item（kind "voice"；metadata 全量，含不可直連的來源樣本路徑）。 */
export function voiceEntryToAssetPackItem(entry: VoiceEntry): AssetPackItem {
  return {
    kind: "voice",
    title: entry.voiceName,
    voiceCode: entry.voiceCode,
    voiceName: entry.voiceName,
    voiceTags: {
      characterTypes: [...entry.characterTypes],
      voiceStyles: [...entry.voiceStyles],
      toneTags: [...entry.toneTags],
      emotionTags: [...entry.emotionTags],
    },
    sampleText: entry.sampleText,
    sourceSampleUrl: entry.sampleUrl,
    note: [
      entry.language,
      entry.gender,
      entry.ageRange,
      entry.characterTypes.join("/"),
      entry.voiceStyles.join("/"),
      entry.toneTags.join("/"),
      `speed ${entry.defaultSpeed}`,
      `pitch ${entry.defaultPitch}`,
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 200),
    source: { type: "manual", id: VOICE_LIBRARY_SOURCE.repo },
  };
}

/** 資產包 → 音色條目（只認 kind "voice" 且 voiceCode 合法者；壞條目靜默丟，不補默認值）。 */
export function voiceEntriesFromPack(pack: { items?: readonly AssetPackItem[] } | null | undefined): VoiceEntry[] {
  const items = Array.isArray(pack?.items) ? pack!.items! : [];
  const out: VoiceEntry[] = [];
  for (const item of items) {
    if (item?.kind !== "voice") continue;
    const entry = voiceEntryByCode(item.voiceCode);
    if (entry) {
      if (!out.some((existing) => existing.voiceCode === entry.voiceCode)) out.push(entry);
      continue;
    }
    // 庫外自建音色（日後 admin 新增）：以 item 自身的白名單欄位承接。
    const custom = normalizeVoiceEntry({
      voiceCode: item.voiceCode,
      voiceName: item.voiceName ?? item.title,
      sampleUrl: item.sourceSampleUrl,
      sampleText: item.sampleText,
      characterTypes: item.voiceTags?.characterTypes,
      voiceStyles: item.voiceTags?.voiceStyles,
      toneTags: item.voiceTags?.toneTags,
      emotionTags: item.voiceTags?.emotionTags,
    });
    if (custom && !out.some((existing) => existing.voiceCode === custom.voiceCode)) out.push(custom);
  }
  return out;
}

/**
 * 全庫打包成固定資產包 payload（呼叫端自行 saveAssetPack；本檔不做 I/O）。
 *
 * ⚠️ 資產包 item 上限（asset-pack-store.MAX_ITEMS_PER_PACK = 50）**小於**全庫
 * （63 筆 AID 種子 + 8 筆實測可播）：這裡誠實截斷，digest/note 明寫實際入包數。
 * 排序讓**實測可播集先入包**（sortOrder 600+），策展種子可截斷——可播性是不可替代
 * 的能力事實，元資料不是。全庫可信來源永遠是 ALL_VOICE_ENTRIES（本檔）。
 *
 * playable **不寫進 item**（AssetPackItem 無此欄，見 normalizeItem 拒絕未知欄的收口）：
 * 讀回時由 `voiceEntriesFromPack` 用 voiceEntryByCode 還原庫內事實，外部 payload
 * 因此無法偽造「可播」宣稱。
 */
export function voiceLibraryPackPayload(now = new Date().toISOString()): AssetPack {
  const ordered = listVoiceEntries();
  const mirrored = ordered.slice(0, MAX_ITEMS_PER_PACK);
  const truncated = ordered.length - mirrored.length;
  const playableInPack = mirrored.filter((entry) => entry.playable === true).length;
  const playableTotal = GATEWAY_VERIFIED_VOICES.length;
  return {
    id: VOICE_LIBRARY_PACK_ID,
    title: VOICE_LIBRARY_PACK_TITLE,
    digest: `配音音色庫：入包 ${mirrored.length} 條（全庫 ${ordered.length} 條；資產包上限 ${MAX_ITEMS_PER_PACK}，未入包 ${truncated}）。其中本站 gateway 實測可試聽 ${playableInPack}/${playableTotal} 條。其餘為 AID 策展元資料，在本站網關會被改寫成 alex，不具獨立音色。`.slice(0, 500),
    items: mirrored.map(voiceEntryToAssetPackItem),
    tags: ["voice", "tts"],
    ...(truncated > 0
      ? { note: `資產包上限 ${MAX_ITEMS_PER_PACK} 條，未入包 ${truncated} 條（截斷的是 AID 策展元資料，實測可試聽集已全部入包）；完整庫以 voice-library.ts 的 ALL_VOICE_ENTRIES 為準。`.slice(0, 200) }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
}

// ─────────────────────────────────────────── 角色綁定與 TTS 參數落定

/** 綁定來源：library=庫內命中 / explicit=庫外顯式指定 / card=角色卡帶入 / fallback=完全沒給。 */
export type TtsVoiceSource = "library" | "explicit" | "card" | "fallback";

export interface TtsVoiceResolution {
  voiceCode: string;
  /** 命中庫內條目時為該條目；否則 null（不得假裝有 metadata）。 */
  entry: VoiceEntry | null;
  source: TtsVoiceSource;
}

/**
 * 角色卡 → 音色編碼：只認 kind==="character" 且帶非空 voiceCode 的卡，
 * 按卡 id 升序取第一張（確定性，與 applyCharacterCards 的 id 序一致）。
 * 場景/風格卡不帶音色（避免「風格卡決定配音」的隱式耦合）。
 */
export function voiceCodeFromCards(cards: readonly CharacterCard[] | null | undefined): string | null {
  if (!Array.isArray(cards)) return null;
  const ordered = [...cards]
    .filter((card) => card && card.kind === "character" && typeof card.voiceCode === "string" && card.voiceCode.trim() !== "")
    .sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
  const first = ordered[0]?.voiceCode;
  return typeof first === "string" && first.trim() ? first.trim().slice(0, MAX_VOICE_CODE_LENGTH) : null;
}

/**
 * 落定 TTS 音色：顯式 voiceCode 優先，其次角色卡綁定，最後 fallback "default"。
 * 純函式、零 I/O；`entry` 只在庫內命中時非 null——上游是否真支援該編碼由 adapter
 * 的 artifact metadata（voice_library_known）與實彈結果決定，此處不做能力宣稱。
 */
export function resolveTtsVoice(input?: {
  voiceCode?: unknown;
  cards?: readonly CharacterCard[] | null;
}): TtsVoiceResolution {
  const explicit = boundedString(input?.voiceCode, MAX_VOICE_CODE_LENGTH);
  if (explicit) {
    const entry = voiceEntryByCode(explicit);
    return { voiceCode: explicit, entry, source: entry ? "library" : "explicit" };
  }
  const fromCard = voiceCodeFromCards(input?.cards);
  if (fromCard) {
    const entry = voiceEntryByCode(fromCard);
    return { voiceCode: fromCard, entry, source: entry ? "library" : "card" };
  }
  return { voiceCode: "default", entry: null, source: "fallback" };
}

/**
 * TTS 請求參數落定（adapter 用；庫內條目提供預設語速/音調，顯式覆寫優先）。
 * 不支援的維度不回傳該欄位（support 旗標 false = 不回傳，而非傳 0 假裝支援）。
 */
export function ttsVoiceRequestParams(input: {
  resolution: TtsVoiceResolution;
  speed?: unknown;
  pitch?: unknown;
  emotion?: unknown;
}): { voice: string; speed?: number; pitch?: number; emotion?: string } {
  const { resolution } = input;
  const entry = resolution.entry;
  const params: { voice: string; speed?: number; pitch?: number; emotion?: string } = { voice: resolution.voiceCode };
  const explicitSpeed = boundedNumber(input.speed, Number.NaN, 0.5, 2.0);
  const speed = Number.isFinite(explicitSpeed)
    ? explicitSpeed
    : entry && entry.supportsSpeed && entry.defaultSpeed !== 1.0
      ? entry.defaultSpeed
      : undefined;
  if (typeof speed === "number") params.speed = speed;
  const explicitPitch = boundedNumber(input.pitch, Number.NaN, -12, 12);
  const pitch = Number.isFinite(explicitPitch)
    ? explicitPitch
    : entry && entry.supportsPitch && entry.defaultPitch !== 0.0
      ? entry.defaultPitch
      : undefined;
  if (typeof pitch === "number") params.pitch = pitch;
  // 情感**不取庫內默認**：emotion 會實質改變音色輸出，未要求就自動套第一個
  // emotionTag 是隱式副作用。庫內 emotionTags 只作為 UI/呼叫端的候選清單。
  const emotion = boundedString(input.emotion, 32);
  if (emotion) params.emotion = emotion;
  return params;
}
