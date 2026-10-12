/**
 * 滚动歌词播放器（store ba-deng-liu-zhao）深链。
 * 聊天音频卡主按钮跳这里，不靠浏览器默认 <audio> 当主体验。
 *
 * URL 形态：
 *   https://store.../ba-deng-liu-zhao/index.html?v=YYYYMMDD&url=<audio>&title=<name>
 *   也可带 id= / track= / i=（歌单下标）
 *
 * 播放器会：① 按 url/id/name/i 命中 tracks.json → 用已有 LRC
 *           ② 未命中则注入临时曲目仍可播，并提示稍后 lyric-align
 */

export const LYRIC_PLAYER_BASE_URL =
  "https://store.tinchak0207.xyz/image-data/files/uploads/ba-deng-liu-zhao/index.html";

/** 强缓存 bust：与上次上传播放器时的 ?v= 约定一致，可按日滚动。 */
export const LYRIC_PLAYER_CACHE_BUST = "20261010-deeplink";

export type LyricPlayerOpenInput = {
  /** 成品音频 URL（必填，播放器靠它匹配或注入）。 */
  url: string;
  /** 展示标题；未对齐时也会显示。 */
  title?: string;
  /** 歌单内 id 或曲名（可选）。 */
  trackId?: string;
  /** 歌单下标（可选）。 */
  index?: number;
  /** 是否尝试自动播放（默认 true；新标签页可能被浏览器拦截）。 */
  autoplay?: boolean;
};

export function buildLyricPlayerUrl(input: LyricPlayerOpenInput): string {
  const q = new URLSearchParams();
  q.set("v", LYRIC_PLAYER_CACHE_BUST);
  if (input.url) q.set("url", input.url);
  if (input.title) q.set("title", input.title);
  if (input.trackId) q.set("id", input.trackId);
  if (typeof input.index === "number" && Number.isFinite(input.index)) {
    q.set("i", String(Math.max(0, Math.floor(input.index))));
  }
  if (input.autoplay === false) q.set("autoplay", "0");
  return `${LYRIC_PLAYER_BASE_URL}?${q.toString()}`;
}

/** 从音频 URL 猜一个可读标题（media-xxx.m4a → 去掉扩展）。 */
export function guessAudioTitleFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    const base = path.split("/").pop() || "";
    const name = base.replace(/\.(m4a|mp3|wav|aac|ogg|flac)$/i, "");
    if (!name || /^media-\d+/i.test(name) || /^music-gen-/i.test(name)) return undefined;
    return decodeURIComponent(name);
  } catch {
    return undefined;
  }
}

export function openLyricPlayer(input: LyricPlayerOpenInput): string {
  const href = buildLyricPlayerUrl(input);
  if (typeof window !== "undefined") {
    window.open(href, "_blank", "noopener,noreferrer");
  }
  return href;
}
