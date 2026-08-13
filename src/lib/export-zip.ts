// 基于 jszip 的打包下载，仅在浏览器中调用（依赖 document 与 URL.createObjectURL）。

const ALLOWED_EXTENSIONS = [".png", ".jpg", ".webp"];

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
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))
    ? name
    : `${name}.png`;
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
