/**
 * OpenUI AudioPlayer 预览数据（2026-10-18）：只读真实来源，取不到返回 null（不显示）。
 *  - 歌词：滚动歌词播放器同目录的 tracks.json（与 lyric-player-url.ts 同一份歌单），
 *    按音频 URL 精确匹配，取前几句 LRC 正文（去时间戳与段落标记）；没有 LRC 时用 lyrics_plain。
 *  - 波形：fetch 音频 + Web Audio decodeAudioData 求峰值；跨域不允许或解码失败即 null。
 * 媒体主机不给跨域时，改走站内同源代理 /api/media-download（登录用户、白名单主机，
 * 与媒体卡「下载」同一条通道）；仍失败就不显示。
 * 结果按 URL 缓存在内存，同一首歌多处渲染只请求一次。
 */
import { stationAuthHeaders } from "@/lib/agent-image-share";
import { LYRIC_PLAYER_BASE_URL } from "@/lib/lyric-player-url";

/** 先直连（主机允许跨域时最快），失败再经同源代理。 */
async function fetchReadable(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    const direct = await fetch(url, init);
    if (direct.ok) return direct;
  } catch {
    /* 跨域被拦：走代理 */
  }
  try {
    const proxied = await fetch(`/api/media-download?url=${encodeURIComponent(url)}`, { headers: stationAuthHeaders() });
    return proxied.ok ? proxied : null;
  } catch {
    return null;
  }
}

const TRACKS_URL = LYRIC_PLAYER_BASE_URL.replace(/index\.html$/, "tracks.json");
const LYRIC_LINES = 4;
const WAVE_BARS = 64;

type Track = { url?: string; lrc?: string; lyrics_plain?: string };

let tracksPromise: Promise<Track[] | null> | null = null;
const lyricCache = new Map<string, Promise<string[] | null>>();
const waveCache = new Map<string, Promise<number[] | null>>();

function loadTracks(): Promise<Track[] | null> {
  if (!tracksPromise) {
    tracksPromise = fetchReadable(TRACKS_URL, { cache: "no-cache" })
      .then((r) => (r ? r.json() : null))
      .then((d) => (Array.isArray(d) ? (d as Track[]) : null))
      .catch(() => null);
  }
  return tracksPromise;
}

/** LRC / 纯文本歌词 → 前 N 句正文（纯函数，供单测）。 */
export function lyricPreviewLines(track: Track | undefined, max = LYRIC_LINES): string[] {
  if (!track) return [];
  const source = track.lrc && track.lrc.trim() ? track.lrc : track.lyrics_plain ?? "";
  const out: string[] = [];
  for (const raw of source.split("\n")) {
    const line = raw
      .replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, "")
      .replace(/<\d{1,2}:\d{2}(?:\.\d{1,3})?>/g, "")
      .replace(/\[[^\]]*\]/g, "")
      .trim();
    if (!line || /^[（(].*[)）]$/.test(line)) continue;
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

export function loadLyricPreview(url: string): Promise<string[] | null> {
  if (typeof window === "undefined" || !url) return Promise.resolve(null);
  let hit = lyricCache.get(url);
  if (!hit) {
    hit = loadTracks().then((tracks) => {
      const lines = lyricPreviewLines(tracks?.find((t) => t.url === url));
      return lines.length ? lines : null;
    });
    lyricCache.set(url, hit);
  }
  return hit;
}

/** 声道 0 采样 → 归一化峰值（纯函数，供单测）。 */
export function peaksFromSamples(samples: ArrayLike<number>, bars = WAVE_BARS): number[] {
  const n = samples.length;
  if (!n || bars <= 0) return [];
  const step = Math.max(1, Math.floor(n / bars));
  const out: number[] = [];
  let max = 0;
  for (let b = 0; b < bars; b += 1) {
    let peak = 0;
    const start = b * step;
    const end = Math.min(n, start + step);
    for (let i = start; i < end; i += 16) peak = Math.max(peak, Math.abs(samples[i] ?? 0));
    out.push(peak);
    max = Math.max(max, peak);
  }
  return max > 0 ? out.map((p) => p / max) : [];
}

export function loadWaveform(url: string): Promise<number[] | null> {
  if (typeof window === "undefined" || !url) return Promise.resolve(null);
  let hit = waveCache.get(url);
  if (!hit) {
    hit = (async () => {
      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return null;
        const res = await fetchReadable(url);
        if (!res) return null;
        const buf = await res.arrayBuffer();
        const ctx = new Ctx();
        try {
          const audio = await ctx.decodeAudioData(buf);
          const peaks = peaksFromSamples(audio.getChannelData(0));
          return peaks.length ? peaks : null;
        } finally {
          void ctx.close();
        }
      } catch {
        return null;
      }
    })();
    waveCache.set(url, hit);
  }
  return hit;
}
