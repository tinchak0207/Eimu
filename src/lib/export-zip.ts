// 基于 jszip 的打包下载，仅在浏览器中调用（依赖 document 与 URL.createObjectURL）。

import { MEDIA_EXTENSIONS } from "./image-helpers";
import { saveBlobLocally } from "./local-save";

// 图片、影片与音频产物都走同一个打包器：带已知副档名的保留，缺副档名的按图片补 .png。
// 白名单从 image-helpers 的 MEDIA_EXTENSIONS 推导（单一真源）：两边不再各自维护，
// 避免像 .jpeg/.gif 那样一边加了另一边没加，导致 `.jpeg` 被补成 `.jpeg.png`。
const ALLOWED_EXTENSIONS = MEDIA_EXTENSIONS.map((ext) => `.${ext}`);

// 与媒体产物同路打包、但本身已自带合法副档名的非媒体结构档（历史导出 zip 里的清单）。
// 这类文件名不该被当成「缺副档名的图片」补成 `manifest.json.png`——它带的是 .json，
// 与图片/影片无关。清单刻意保持极小：目前只有 exportHistoryZip 会带这一类文件。
const PASSTHROUGH_EXTENSIONS = [".json"];

function sanitizeFileName(name: string): string {
  // 去掉路径分隔符与 Windows 非法字符、控制字符，避免 zip 内出现目录穿越
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/^\.+/, "");
  return cleaned === "" ? "图片" : cleaned;
}

function ensureExtension(name: string): string {
  const lower = name.toLowerCase();
  // 只对「缺副档名的产物」补 .png（当它是图片）；已带合法副档名的原样保留：
  // 媒体白名单（.png/.mp4/…）或非媒体结构档（.json，如 manifest）。
  const hasLegalExtension = ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))
    || PASSTHROUGH_EXTENSIONS.some((ext) => lower.endsWith(ext));
  return hasLegalExtension ? name : `${name}.png`;
}

function dedupeName(name: string, used: Set<string>): string {
  const dotIndex = name.lastIndexOf(".");
  const stem = name.slice(0, dotIndex);
  const ext = name.slice(dotIndex);
  let candidate = name;
  let counter = 2;
  // zip 解压到 Windows 时文件名不区分大小写，按小写判重
  while (used.has(candidate.toLowerCase())) {
    candidate = `${stem}-${counter}${ext}`;
    counter += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export async function exportShotsZip(
  items: Array<{ name: string; blob: Blob }>,
  zipName: string
): Promise<void> {
  if (items.length === 0) return;

  // jszip 约 100KB，仅在用户点击导出时才需要——按需加载，不进专业模式首屏 chunk
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const used = new Set<string>();
  for (const item of items) {
    const fileName = dedupeName(
      ensureExtension(sanitizeFileName(item.name)),
      used
    );
    zip.file(fileName, item.blob);
  }

  const zipBlob = await zip.generateAsync({ type: "blob" });

  // 渐进增强：有 File System Access API 就把打包好的 zip 直接写进用户选定目录。
  // 取消（"cancelled"）不重复下载；只有 "unsupported" 才回落 <a download>。
  const localResult = await saveBlobLocally(zipBlob, zipName, { mimeType: "application/zip" });
  if (localResult !== "unsupported") return;

  const url = URL.createObjectURL(zipBlob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = zipName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}
