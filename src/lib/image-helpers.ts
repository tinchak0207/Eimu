import { saveBlobLocally } from "./local-save";

/** 能从 URL 尾端认出的媒体副档名；export-zip.ts 的接收端白名单由此推导（单一真源）。 */
export const MEDIA_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "mp4",
  "webm",
  "mov",
  "mp3",
  "m4a",
  "wav",
  "aac",
  "ogg",
  "opus",
  "flac",
] as const;

/**
 * 从媒体 URL 尾端推出副档名（忽略 ?query 与 #hash，大小写归一）。
 * data:/blob: 这类没有路径语义的来源一律返回 null，呼叫端据此回落。
 */
export function mediaExtensionFromUrl(src: string): string | null {
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return null;
  const path = src.split(/[?#]/)[0];
  const match = /\.([a-z0-9]+)$/i.exec(path);
  if (!match) return null;
  const ext = match[1].toLowerCase();
  return (MEDIA_EXTENSIONS as readonly string[]).includes(ext) ? ext : null;
}

/** download 用的副档名：推得出真实副档名就用它，否则维持既有默认的 png。 */
export function downloadExtension(src: string): string {
  return mediaExtensionFromUrl(src) ?? "png";
}

/**
 * http(s) 取图的硬上限（毫秒）。单张图下载不该无限等：上游半开连线（headers 永不
 * 到达）时裸 fetch 会永久 pending，单张下载永不落错误、批量导出那一路的 skipped
 * 判定也永不发生。30 秒远超一张图在任意合理带宽下的下载时间，又短到让病态连线
 * 落成明确失败。逾时经 AbortController abort，转成具人话的 Error 抛出。
 */
export const IMAGE_FETCH_TIMEOUT_MS = 30_000;

export const imageHelpers = {
  base64ToBlob: (base64Data: string, type = "image/png"): Blob => {
    const byteString = atob(base64Data);
    const arrayBuffer = new ArrayBuffer(byteString.length);
    const uint8Array = new Uint8Array(arrayBuffer);

    for (let i = 0; i < byteString.length; i++) {
      uint8Array[i] = byteString.charCodeAt(i);
    }

    return new Blob([uint8Array], { type });
  },

  generateImageFileName: (provider: string): string => {
    const uniqueId = Math.random().toString(36).substring(2, 8);
    return `${provider}-${uniqueId}`.replace(/[^a-z0-9-]/gi, "");
  },

  // Blob 获取链（download 与 copy 共用，自 download 原内联逻辑逐行抽出，语义零变动）。
  // http(s) sources are first rendered by <img> in no-cors mode and cached
  // immutable for a year; a same-URL cors fetch can then be served that
  // cached copy without Access-Control-Allow-Origin (Chromium's simple cache
  // ignores Vary: Origin) and gets blocked. Bust the cache key and skip the
  // HTTP cache so the fetch always takes a fresh CORS-eligible response.
  //
  // ?dl=1 的机制真相（2026-10-04 缺陷 B 追查）：CDN(store.tinchak0207.xyz)
  // 的 /image-data/ 由 nginx 按 $http_origin 白名单回 Access-Control-Allow-Origin
  // （见 deploy/imagesite/nginx/default.conf），?dl=1 本身不被上游读取——它的作用
  // 是换掉 URL 缓存键；配合 cache:"no-store" 让本次 CORS fetch 不复用 <img>
  // no-cors 渲染留下的无 ACAO 缓存体。因此任何人取这批图都必须走这一条链。
  //
  // fetchImageResponse 暴露原始 Response，供需要状态码的调用端（历史批量导出的
  // skipped 判定）复用同一条链，不再自拼第二套 URL（禁造轮子）。
  //
  // 2026-10-04（同「永久 pending」族）：取图等待原本无界。加 AbortController + timeout，
  // 逾时统一抛人话 Error（单张下载据此显示错误；批量导出的 fetchAsBlob 会 catch 成
  // null → skipped，一次逾时不炸整包 zip）。?dl=1 与 cache:"no-store" 原样保留。
  fetchImageResponse: async (
    imageSource: string,
    timeoutMs: number = IMAGE_FETCH_TIMEOUT_MS,
  ): Promise<Response> => {
    const isHttpSource = imageSource.startsWith("http");
    const fetchUrl = isHttpSource
      ? `${imageSource}${imageSource.includes("?") ? "&" : "?"}dl=1`
      : imageSource;
    if (isHttpSource || imageSource.startsWith("data:") || imageSource.startsWith("blob:")) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(fetchUrl, { cache: "no-store", signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw new Error("图片下载超时，请重试。");
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    return new Response(imageHelpers.base64ToBlob(imageSource));
  },

  fetchImageBlob: async (imageSource: string): Promise<Blob> => {
    return await imageHelpers.fetchImageResponse(imageSource).then((response) => response.blob());
  },

  // ClipboardItem 的最大兼容 MIME 是 image/png：Safari 只收 PNG，Chrome 也仅
  // 支持少数几种。非 PNG blob 先经 canvas 重绘转 PNG 再进剪贴板。
  reencodeAsPng: (blob: Blob): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d");
          if (!context) {
            reject(new Error("Canvas 2D context unavailable"));
            return;
          }
          context.drawImage(image, 0, 0);
          canvas.toBlob((pngBlob) => {
            if (pngBlob) resolve(pngBlob);
            else reject(new Error("PNG re-encode failed"));
          }, "image/png");
        } finally {
          // drawImage 是同步的，画完即可释放，不留泄漏窗口。
          URL.revokeObjectURL(objectUrl);
        }
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Image decode failed during PNG re-encode"));
      };
      image.src = objectUrl;
    });
  },

  copyToClipboard: async (imageSource: string): Promise<void> => {
    if (
      typeof navigator === "undefined" ||
      !navigator.clipboard?.write ||
      typeof ClipboardItem === "undefined"
    ) {
      // 专用错误：调用方据此 fallback 到下载。
      throw new Error("当前浏览器不支持复制图片");
    }
    // 直接传 Promise 形式给 ClipboardItem（Chrome/Safari 都兼容）：剪贴板
    // 锁定在 write() 调用时立即建立，blob fetch / PNG 转码可以慢慢完成，
    // 避免 Safari 等待用户确认剪贴板授权时超时。
    const pngBlobPromise = (async () => {
      const blob = await imageHelpers.fetchImageBlob(imageSource);
      return blob.type === "image/png" ? blob : await imageHelpers.reencodeAsPng(blob);
    })();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlobPromise })]);
  },

  download: async (
    imageSource: string,
    provider: string
  ): Promise<void> => {
    const fileName = imageHelpers.generateImageFileName(provider);
    const blob = await imageHelpers.fetchImageBlob(imageSource);
    // 副档名跟着来源 URL 走：音频/视频不再被硬写成 .png；推不出一律 png。
    const downloadName = `${fileName}.${downloadExtension(imageSource)}`;

    // 渐进增强：有 File System Access API 就直接写进用户选定目录。
    // 使用者取消（"cancelled"）不重复下载；只有 "unsupported" 才走原本的 blob 下载。
    const localResult = await saveBlobLocally(blob, downloadName, { mimeType: blob.type });
    if (localResult !== "unsupported") return;

    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = downloadName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Revoke late: revoking immediately after click() cancels the download in
    // some browsers because the download is triggered asynchronously.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
  },

  formatModelId: (modelId: string): string => {
    return modelId.split("/").pop() || modelId;
  },
};
