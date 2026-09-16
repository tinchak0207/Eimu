// 角色/場景卡（P2 跨鏡頭一致性）：純邏輯層。
//
// 定位：卡 = 項目級「鎖定」配置。一經鎖定（掛到畫布項目的 cardIds），
// 該畫布所有生成（手動面板、agent run_generation、編輯器派生）自動攜帶：
//   - locked prompt 片段 → 以穩定順序（卡 id 序）注入 prompt 前綴
//   - 參考圖 → 合併進 reference_images（各帶 ReferenceRole，卡優先）
//   - 負面詞 → 合併進 negative_prompt
//
// 角色枚舉 owner 是 image-types.ReferenceImageRole（復用，不建第二套）；
// LoRA 關聯引用既有 lora versionId 標識（不建新 LoRA 體系）。
// 本檔只做純函式；存儲在 character-card-store.ts、HTTP 在 /api/character-cards。

import { toReferenceImageRole } from "./image-types";
import type { ReferenceImageRole } from "./image-types";

/** 卡種類：角色卡（外觀鎖定）/ 場景卡（環境鎖定）/ 風格卡（畫風鎖定）。 */
export type CharacterCardKind = "character" | "scene" | "style";

export const CHARACTER_CARD_KIND_VALUES: readonly CharacterCardKind[] = ["character", "scene", "style"];

/** 卡種類的簡體中文標籤（UI 與 toast 共用，不散落三元表達式）。 */
export const CHARACTER_CARD_KIND_LABEL: Record<CharacterCardKind, string> = {
  character: "角色",
  scene: "场景",
  style: "风格",
};

/** 未知值收斂為 character（舊數據/agent 亂填不炸）。 */
export function toCharacterCardKind(value: unknown): CharacterCardKind {
  return typeof value === "string" && (CHARACTER_CARD_KIND_VALUES as readonly string[]).includes(value)
    ? (value as CharacterCardKind)
    : "character";
}

/** 卡的參考圖：url + 角色（ReferenceImageRole）+ 顯示名。 */
export interface CharacterCardReferenceImage {
  url: string;
  role: ReferenceImageRole;
  name: string;
}

export interface CharacterCard {
  id: string;
  name: string;
  kind: CharacterCardKind;
  /** 鎖定的 prompt 片段（外觀/場景描述）；空字串 = 純參考圖卡。 */
  prompt: string;
  /** 參考圖列表（各帶角色）。 */
  references: CharacterCardReferenceImage[];
  /** 負面詞（可選）。 */
  negativePrompt?: string;
  /** LoRA 關聯（可選）：引用既有 lora versionId，不建新體系。 */
  loraIds?: string[];
  /**
   * 綁定的配音音色編碼（可選，刀 3）：引用 voice-library.ts 的 voiceCode，不建新體系。
   * 只有角色卡（kind "character"）的音色會被 TTS 取用（見 voiceCodeFromCards）。
   */
  voiceCode?: string;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────── 清洗與上限

const MAX_CARD_ID_LENGTH = 100;
const MAX_CARD_NAME_LENGTH = 100;
const MAX_CARD_PROMPT_LENGTH = 2000;
const MAX_CARD_NEGATIVE_LENGTH = 1000;
const MAX_CARD_REFERENCES = 8;
const MAX_CARD_LORA_IDS = 8;
const MAX_REFERENCE_NAME_LENGTH = 60;
/** 音色編碼上限（對齊 voice-library.ts 的 MAX_VOICE_CODE_LENGTH / AID voice_code 欄寬）。 */
const MAX_CARD_VOICE_CODE_LENGTH = 128;

/** 圖片 URL 判定：與 semantic-nodes 的收口一致（http(s) 與 data:image）。 */
function isUsableCardImageUrl(url: string | undefined | null): url is string {
  if (!url) return false;
  return url.startsWith("http") || url.startsWith("data:image/");
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= max ? clean : null;
}

/** 清洗單張卡：欄位缺損返回 null（API 與 store 共用同一收口）。 */
export function normalizeCharacterCard(payload: unknown): CharacterCard | null {
  if (!payload || typeof payload !== "object") return null;
  const c = payload as Partial<CharacterCard>;
  const id = boundedString(c.id, MAX_CARD_ID_LENGTH);
  const name = boundedString(c.name, MAX_CARD_NAME_LENGTH);
  if (!id || !name) return null;
  const now = new Date().toISOString();
  const references = (Array.isArray(c.references) ? c.references : [])
    .flatMap((ref): CharacterCardReferenceImage[] => {
      if (!ref || typeof ref !== "object") return [];
      const r = ref as { url?: unknown; role?: unknown; name?: unknown };
      if (typeof r.url !== "string" || !isUsableCardImageUrl(r.url)) return [];
      return [
        {
          url: r.url,
          role: toReferenceImageRole(r.role),
          name: boundedString(r.name, MAX_REFERENCE_NAME_LENGTH) ?? name,
        },
      ];
    })
    .slice(0, MAX_CARD_REFERENCES);
  const negativePrompt = boundedString(c.negativePrompt, MAX_CARD_NEGATIVE_LENGTH);
  const loraIds = (Array.isArray(c.loraIds) ? c.loraIds : [])
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .slice(0, MAX_CARD_LORA_IDS);
  // 音色綁定（刀 3）：白名單單一字串欄，空字串收斂為未綁定（不寫 undefined 以外的值）。
  const voiceCode = boundedString(c.voiceCode, MAX_CARD_VOICE_CODE_LENGTH);
  return {
    id,
    name,
    kind: toCharacterCardKind(c.kind),
    prompt: typeof c.prompt === "string" ? c.prompt.trim().slice(0, MAX_CARD_PROMPT_LENGTH) : "",
    references,
    ...(negativePrompt ? { negativePrompt } : {}),
    ...(loraIds.length ? { loraIds } : {}),
    ...(voiceCode ? { voiceCode } : {}),
    createdAt: typeof c.createdAt === "string" ? c.createdAt : now,
    updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : now,
  };
}

// ─────────────────────────────────────────── 鎖定注入語義

export interface AppliedCharacterCards {
  /** 注入後的 prompt（卡片段前綴 + 原 prompt）。 */
  prompt: string;
  /** 卡的參考圖（url 去重、角色保留；卡 id 序）。 */
  references: CharacterCardReferenceImage[];
  /** 合併後的負面詞；無則 null。 */
  negativePrompt: string | null;
}

/**
 * 鎖定注入核心（純函式、冪等）：
 *   - 穩定順序：卡按 id 升序（卡 id 序），與傳入順序無關
 *   - 冪等：同一卡出現兩次只注入一次；片段已存在於 basePrompt 時不再重複
 *   - 參考圖按 url 去重、角色原樣保留
 *   - 負面詞合併去重（", " 連接）
 */
export function applyCharacterCards(basePrompt: string, cards: CharacterCard[]): AppliedCharacterCards {
  const ordered = [...cards].sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
  const seenIds = new Set<string>();
  const fragments: string[] = [];
  const references: CharacterCardReferenceImage[] = [];
  const seenUrls = new Set<string>();
  const negatives: string[] = [];
  for (const card of ordered) {
    if (seenIds.has(card.id)) continue;
    seenIds.add(card.id);
    const fragment = card.prompt.trim();
    if (fragment && !fragments.includes(fragment)) fragments.push(fragment);
    for (const ref of card.references) {
      if (!isUsableCardImageUrl(ref.url) || seenUrls.has(ref.url)) continue;
      seenUrls.add(ref.url);
      references.push({
        url: ref.url,
        role: toReferenceImageRole(ref.role),
        name: ref.name || card.name,
      });
    }
    const negative = (card.negativePrompt ?? "").trim();
    if (negative && !negatives.includes(negative)) negatives.push(negative);
  }
  // 冪等：正文已含的片段不重複注入（apply 兩次 = 一次）。
  const base = basePrompt.trim();
  const injectable = fragments.filter((fragment) => !base.includes(fragment));
  const prefix = injectable.join("\n");
  const prompt = prefix ? (base ? prefix + "\n" + base : prefix) : basePrompt;
  return {
    prompt,
    references,
    negativePrompt: negatives.length > 0 ? negatives.join(", ") : null,
  };
}

// ─────────────────────────────────────────── 生成請求掛接

/** /api/canvas/generate 請求體中與卡相關的欄位形狀。 */
export interface CardAwareGeneratePayload {
  prompt: string;
  reference_images?: { url: string; role: ReferenceImageRole; name: string }[];
  negative_prompt?: string | null;
  [key: string]: unknown;
}

/**
 * 把鎖定卡注入生成請求 payload（不改動其餘欄位）：
 *   - prompt：卡片段前綴（冪等）
 *   - reference_images：卡參考圖排最前（locked 優先——上游 5 張上限從尾部截斷，
 *     鎖定卡不可被靜默丟棄），原有參考按 url 去重後排其後
 *   - negative_prompt：合併（原有在前、卡在後，去重）
 * 無卡可注入時原樣返回同一物件（零行為漂移）。
 */
export function applyCharacterCardsToPayload<T extends CardAwareGeneratePayload>(payload: T, cards: CharacterCard[]): T {
  if (cards.length === 0) return payload;
  const applied = applyCharacterCards(payload.prompt, cards);
  if (!applied.references.length && applied.prompt === payload.prompt && !applied.negativePrompt) return payload;

  const existingRefs = Array.isArray(payload.reference_images) ? payload.reference_images : [];
  // 同 URL 以卡為準（locked 覆蓋）：手動引用撞卡圖時保留卡的角色與名稱。
  const cardUrls = new Set(applied.references.map((ref) => ref.url));
  const mergedRefs = [...applied.references, ...existingRefs.filter((ref) => !cardUrls.has(ref.url))];

  const negatives: string[] = [];
  const baseNegative = (payload.negative_prompt ?? "").trim();
  if (baseNegative) negatives.push(baseNegative);
  for (const item of (applied.negativePrompt ?? "").split(", ")) {
    const clean = item.trim();
    if (clean && !negatives.includes(clean)) negatives.push(clean);
  }

  return {
    ...payload,
    prompt: applied.prompt,
    ...(mergedRefs.length > 0 ? { reference_images: mergedRefs } : {}),
    ...(negatives.length > 0 ? { negative_prompt: negatives.join(", ") } : {}),
  };
}
