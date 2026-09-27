// 作品公開分享（/p/<shareId>）＋「做同款」增長迴路的純函式層。
//
// 為什麼獨立成檔、且只用 relative import ＋ type-only import：
//   ①這一層同時被 client 元件（分享對話框、做同款按鈕）與 server（/api/share、
//     /p 頁）引用——**絕不可在本檔頂層碰 node:crypto**，否則 client bundle 直接炸。
//     `randomBytes` 只住在 share-id.ts（server-only）。
//   ②這些規矩必須能在 `node --test` 下直接做行為斷言，不能只靠讀碼——
//     「做同款」注入哪些欄位、分享連結帶哪些歸因參數、隱藏提示詞有沒有真的被剝掉。
//
// 存儲在 share-store.ts，id 產生在 share-id.ts。

import type { HistoryEntry, HistoryResult } from "./history-types";

// ── 歸因：分享連結必須自己帶來源，first-touch cookie 才有東西可記 ──────────
// 為什麼 ref 就是 shareId：被分享出去的那一頁本身就是歸因對象（哪件作品帶來的人），
// 不必再開一個 uuid——多一個 id 就多一份對不上的機會。

export const SHARE_UTM_SOURCE = "share";
export const SHARE_UTM_MEDIUM = "p";

export function shareUtmParams(shareId: string): Record<string, string> {
  return {
    utm_source: SHARE_UTM_SOURCE,
    utm_medium: SHARE_UTM_MEDIUM,
    ref: shareId,
  };
}

/** 站內路徑（canonical 用，不帶歸因參數；canonical 帶 utm 等於自造重複頁）。 */
export function buildSharePath(shareId: string): string {
  return `/p/${shareId}`;
}

/** 對外分享連結：路徑 + 歸因參數。siteUrl 由呼叫端給（request 或 env，見 site-url.ts）。 */
export function buildShareUrl(siteUrl: string, shareId: string): string {
  const base = siteUrl.replace(/\/+$/, "");
  const query = new URLSearchParams(shareUtmParams(shareId)).toString();
  return `${base}${buildSharePath(shareId)}?${query}`;
}

/**
 * 點「做同款」後落地的站內連結。
 *
 * 復用圖庫卡既有的交接通道（D-18：`?agent=1&q=` → ImagePlayground 注入助理輸入框），
 * 只多帶歸因參數——人被這件作品帶進來，這一跳不能把來源洗掉。
 * 未登入者在輸入框按送出時由 commit a8362440 的 onSendBlockedByAuth → stashBlockedSend
 * 接手（與宣傳片同一格），登入後自動補送，這裡不另造補送鏈。
 */
export function buildRemixHandoffUrl(shareId: string, seed: string): string {
  const query = new URLSearchParams({
    agent: "1",
    q: seed,
    ...shareUtmParams(shareId),
  });
  return `/?${query.toString()}`;
}

// ── 做同款的注入配方 ────────────────────────────────────────────────────────

export const REMIX_SEED_PREFIX = "照这个想法再做一版：";
/**
 * 提示詞不可用時（分享者選擇隱藏／這條記錄本來就沒留提示詞）的引導語。
 * 只帶模型與比例，**半個字都不從被隱藏的提示詞裡拿**——隱藏是真的隱藏。
 */
export const REMIX_RECIPE_ONLY_PREFIX = "照同样的参数再做一版。";

export interface RemixSeedInput {
  prompt?: string | null;
  modelId?: string | null;
  aspectRatio?: string | null;
  imageSize?: string | null;
}

/** 「原参数（模型/尺寸/比例）」括號；三者皆缺時整個括號不出現（不編造空欄位）。 */
export function buildRecipeText(input: RemixSeedInput): string {
  const parts = [
    input.modelId?.trim() ? `模型 ${input.modelId.trim()}` : "",
    input.imageSize?.trim() ? `尺寸 ${input.imageSize.trim()}` : "",
    input.aspectRatio?.trim() ? `比例 ${input.aspectRatio.trim()}` : "",
  ].filter(Boolean);
  return parts.length ? `（原参数：${parts.join("，")}）` : "";
}

export function buildRemixSeed(input: RemixSeedInput): string {
  const prompt = (input.prompt ?? "").trim();
  const recipe = buildRecipeText(input);
  if (!prompt) return `${REMIX_RECIPE_ONLY_PREFIX}${recipe}`;
  return `${REMIX_SEED_PREFIX}${prompt}${recipe}`;
}

// ── 分享記錄模型（型別；IO 在 share-store.ts）────────────────────────────────

export interface ShareSnapshot {
  /** 完整提示詞：存著（撤銷隱藏時要還原），對外視圖由 publicShareView 決定露不露。 */
  prompt: string;
  modelId: string;
  aspectRatio: string;
  imageSize: string;
  /** 沿用既有 artifact/blob owner：這裡只放 URL，不搬位元組、不另建存儲。 */
  imageUrl: string;
}

export interface ShareRecord {
  schemaVersion: number;
  shareId: string;
  ownerUserId: number;
  /** 來源歷史記錄 id。撤銷與冪等（同一件重複點分享）都靠它對位。 */
  entryId: string;
  resultIndex: number;
  createdAt: number;
  /** true ＝ 對外不露提示詞。 */
  hidePrompt: boolean;
  snapshot: ShareSnapshot;
}

/** 使用者自己的分享清單項（不含快照，卡片只需要知道「這件有沒有分享、id 是什麼」）。 */
export interface ShareIndexItem {
  shareId: string;
  entryId: string;
  resultIndex: number;
  createdAt: number;
  hidePrompt: boolean;
}

/** 對外（/p 頁與 OG）視圖：hidden 時 prompt 直接是 null，頁面無從洩漏。 */
export interface PublicShareView {
  shareId: string;
  createdAt: number;
  hidePrompt: boolean;
  prompt: string | null;
  modelId: string;
  aspectRatio: string;
  imageSize: string;
  imageUrl: string;
}

export function publicShareView(record: ShareRecord): PublicShareView {
  const prompt = record.snapshot.prompt.trim();
  return {
    shareId: record.shareId,
    createdAt: record.createdAt,
    hidePrompt: record.hidePrompt,
    // 空提示詞與「隱藏」對外同義：都沒有可給的東西，不必分兩種 null 語義。
    prompt: record.hidePrompt || !prompt ? null : prompt,
    modelId: record.snapshot.modelId,
    aspectRatio: record.snapshot.aspectRatio,
    imageSize: record.snapshot.imageSize,
    imageUrl: record.snapshot.imageUrl,
  };
}

export function shareIndexItem(record: ShareRecord): ShareIndexItem {
  return {
    shareId: record.shareId,
    entryId: record.entryId,
    resultIndex: record.resultIndex,
    createdAt: record.createdAt,
    hidePrompt: record.hidePrompt,
  };
}

// ── 從歷史記錄挑「可分享的那一項」────────────────────────────────────────────

export type ShareableResult =
  | { ok: true; index: number; result: HistoryResult; /** true ＝ 只有 base64，呼叫端得先轉存成公開 URL。 */ needsPersist: boolean }
  | { ok: false; reason: string };

/**
 * 歷史記錄裡第 resultIndex 項能不能分享。
 * 純函式：路由拿它決定 400 文案，測試拿它做行為斷言，兩邊同一份判準。
 */
export function shareableResult(entry: HistoryEntry, resultIndex: number): ShareableResult {
  const result = entry.results[resultIndex];
  if (!result) return { ok: false, reason: "记录里没有这一项。" };
  if (result.imageUrl) return { ok: true, index: resultIndex, result, needsPersist: false };
  if (result.image) return { ok: true, index: resultIndex, result, needsPersist: true };
  if (result.videoUrl) return { ok: false, reason: "视频暂不支持分享。" };
  return { ok: false, reason: "这一项没有可分享的图片。" };
}

/** 第一個可分享的結果下標；沒有則 -1（卡片預設分享哪一張）。 */
export function firstShareableIndex(entry: HistoryEntry): number {
  for (let index = 0; index < entry.results.length; index += 1) {
    if (shareableResult(entry, index).ok) return index;
  }
  return -1;
}

/**
 * 快照（分享那一刻的固定事實）。
 * imageUrl 由呼叫端給：base64 的結果要先經既有 artifact/blob owner 轉存成公開 URL，
 * 這裡不自己搬位元組。
 */
export function buildShareSnapshot(
  entry: HistoryEntry,
  resultIndex: number,
  imageUrl: string,
): ShareSnapshot | null {
  const picked = shareableResult(entry, resultIndex);
  if (!picked.ok || !imageUrl.trim()) return null;
  const result = picked.result;
  return {
    prompt: entry.prompt.trim(),
    modelId: (entry.modelId ?? result.modelId ?? "").trim(),
    aspectRatio: String(entry.workflow?.aspectRatio ?? "").trim(),
    imageSize: (entry.workflow?.imageSize ?? "").trim(),
    imageUrl: imageUrl.trim(),
  };
}
