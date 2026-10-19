// 作品公开分享（/p/<shareId>）＋「做同款」增长回路的纯函式层。
//
// 为什么独立成档、且只用 relative import ＋ type-only import：
//   ①这一层同时被 client 元件（分享对话框、做同款按钮）与 server（/api/share、
//     /p 页）引用——**绝不可在本档顶层碰 node:crypto**，否则 client bundle 直接炸。
//     `randomBytes` 只住在 share-id.ts（server-only）。
//   ②这些规矩必须能在 `node --test` 下直接做行为断言，不能只靠读码——
//     「做同款」注入哪些栏位、分享连结带哪些归因参数、隐藏提示词有没有真的被剥掉。
//
// 存储在 share-store.ts，id 产生在 share-id.ts。

import type { HistoryEntry, HistoryResult } from "./history-types";

// ── 归因：分享连结必须自己带来源，first-touch cookie 才有东西可记 ──────────
// 为什么 ref 就是 shareId：被分享出去的那一页本身就是归因对象（哪件作品带来的人），
// 不必再开一个 uuid——多一个 id 就多一份对不上的机会。

export const SHARE_UTM_SOURCE = "share";
export const SHARE_UTM_MEDIUM = "p";

export function shareUtmParams(shareId: string): Record<string, string> {
  return {
    utm_source: SHARE_UTM_SOURCE,
    utm_medium: SHARE_UTM_MEDIUM,
    ref: shareId,
  };
}

/** 站内路径（canonical 用，不带归因参数；canonical 带 utm 等于自造重复页）。 */
export function buildSharePath(shareId: string): string {
  return `/p/${shareId}`;
}

/** 对外分享连结：路径 + 归因参数。siteUrl 由呼叫端给（request 或 env，见 site-url.ts）。 */
export function buildShareUrl(siteUrl: string, shareId: string, inviteCode?: string | null): string {
  const base = siteUrl.replace(/\/+$/, "");
  // 作者的邀请码放第一位：看图的人注册并出第一张图＝作者邀请成功（分享即邀请）。
  const query = new URLSearchParams({ ...(inviteCode ? { invite: inviteCode } : {}), ...shareUtmParams(shareId) }).toString();
  return `${base}${buildSharePath(shareId)}?${query}`;
}

/**
 * 点「做同款」后落地的站内连结。
 *
 * 复用图库卡既有的交接通道（D-18：`?agent=1&q=` → ImagePlayground 注入助理输入框），
 * 只多带归因参数——人被这件作品带进来，这一跳不能把来源洗掉。
 * 未登入者在输入框按送出时由 commit a8362440 的 onSendBlockedByAuth → stashBlockedSend
 * 接手（与宣传片同一格），登入后自动补送，这里不另造补送链。
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
 * 提示词不可用时（分享者选择隐藏／这条记录本来就没留提示词）的引导语。
 * 只带模型与比例，**半个字都不从被隐藏的提示词里拿**——隐藏是真的隐藏。
 */
export const REMIX_RECIPE_ONLY_PREFIX = "照同样的参数再做一版。";

export interface RemixSeedInput {
  prompt?: string | null;
  modelId?: string | null;
  aspectRatio?: string | null;
  imageSize?: string | null;
}

/** 「原参数（模型/尺寸/比例）」括号；三者皆缺时整个括号不出现（不编造空栏位）。 */
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

// ── 分享记录模型（型别；IO 在 share-store.ts）────────────────────────────────

export interface ShareSnapshot {
  /** 完整提示词：存著（撤销隐藏时要还原），对外视图由 publicShareView 决定露不露。 */
  prompt: string;
  modelId: string;
  aspectRatio: string;
  imageSize: string;
  /** 沿用既有 artifact/blob owner：这里只放 URL，不搬位元组、不另建存储。 */
  imageUrl: string;
}

export interface ShareRecord {
  schemaVersion: number;
  shareId: string;
  ownerUserId: number;
  /** 来源历史记录 id。撤销与幂等（同一件重复点分享）都靠它对位。 */
  entryId: string;
  resultIndex: number;
  createdAt: number;
  /** true ＝ 对外不露提示词。 */
  hidePrompt: boolean;
  snapshot: ShareSnapshot;
}

/** 使用者自己的分享清单项（不含快照，卡片只需要知道「这件有没有分享、id 是什么」）。 */
export interface ShareIndexItem {
  shareId: string;
  entryId: string;
  resultIndex: number;
  createdAt: number;
  hidePrompt: boolean;
}

/** 对外（/p 页与 OG）视图：hidden 时 prompt 直接是 null，页面无从泄漏。 */
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
    // 空提示词与「隐藏」对外同义：都没有可给的东西，不必分两种 null 语义。
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

// ── 从历史记录挑「可分享的那一项」────────────────────────────────────────────

export type ShareableResult =
  | { ok: true; index: number; result: HistoryResult; /** true ＝ 只有 base64，呼叫端得先转存成公开 URL。 */ needsPersist: boolean }
  | { ok: false; reason: string };

/**
 * 历史记录里第 resultIndex 项能不能分享。
 * 纯函式：路由拿它决定 400 文案，测试拿它做行为断言，两边同一份判准。
 */
export function shareableResult(entry: HistoryEntry, resultIndex: number): ShareableResult {
  const result = entry.results[resultIndex];
  if (!result) return { ok: false, reason: "记录里没有这一项。" };
  if (result.imageUrl) return { ok: true, index: resultIndex, result, needsPersist: false };
  if (result.image) return { ok: true, index: resultIndex, result, needsPersist: true };
  if (result.videoUrl) return { ok: false, reason: "视频暂不支持分享。" };
  return { ok: false, reason: "这一项没有可分享的图片。" };
}

/** 第一个可分享的结果下标；没有则 -1（卡片预设分享哪一张）。 */
export function firstShareableIndex(entry: HistoryEntry): number {
  for (let index = 0; index < entry.results.length; index += 1) {
    if (shareableResult(entry, index).ok) return index;
  }
  return -1;
}

/**
 * 快照（分享那一刻的固定事实）。
 * imageUrl 由呼叫端给：base64 的结果要先经既有 artifact/blob owner 转存成公开 URL，
 * 这里不自己搬位元组。
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
