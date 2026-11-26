// 赏阅 · 通用下载：任何入口打开的成品都能下载，不依赖调用方是否接了 onDownload。
//
// 顺序：① 直接 fetch 源站（agent 媒体源站对站点来源放行 CORS，最快、不占站点带宽）
//       ② 站内同源代理 /api/media-download（源站不放行 CORS 时，需登录）
//       ③ 都不行就让浏览器按附件打开 <a download>，用户至少拿得到文件。
// 成功＝触发了浏览器保存（回 true）；只有地址为空才回 false。

import { stationAuthHeaders } from "@/lib/agent/agent-image-share";
import type { ViewAsset } from "@/lib/viewer/types";

const EXT_BY_MIME: Record<string, string> = {
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

function extOf(url: string, mime: string | undefined, blobType: string): string {
  const fromUrl = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url)?.[1]?.toLowerCase();
  if (fromUrl && !["php", "html", "json", "aspx"].includes(fromUrl)) return fromUrl;
  return EXT_BY_MIME[(mime || blobType || "").split(";")[0].trim().toLowerCase()] ?? "bin";
}

function fileNameFor(asset: ViewAsset, ext: string): string {
  const base = (asset.title || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${base || `eimu-${asset.kind}-${Date.now()}`}.${ext}`;
}

function save(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href, download: name, rel: "noopener" });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

export async function downloadAsset(asset: ViewAsset): Promise<boolean> {
  const url = (asset.url || "").trim();
  if (!url) return false;
  const attempts: Array<() => Promise<Response>> = [
    // no-store：<audio> 先前的无 CORS 请求会把没带 ACAO 头的响应写进缓存，复用它会让 fetch 被 CORS 拦下。
    () => fetch(url, { mode: "cors", credentials: "omit", cache: "no-store" }),
    () => fetch(`/api/media-download?url=${encodeURIComponent(url)}`, { headers: stationAuthHeaders() }),
  ];
  for (const go of attempts) {
    try {
      const res = await go();
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob.size === 0) continue;
      save(blob, fileNameFor(asset, extOf(url, asset.mime, blob.type)));
      return true;
    } catch {
      /* 换下一条路 */
    }
  }
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: fileNameFor(asset, extOf(url, asset.mime, "")),
    target: "_blank",
    rel: "noopener",
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}
