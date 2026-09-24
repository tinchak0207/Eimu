"use client";

// 历史记录的导出：ZIP（图片 + 清单）、JSON（完整档案）、CSV（表格）。
//
// 图片下载走浏览器 fetch，因此只能拿到同源或允许跨域的资源 ——
// Vercel Blob 的公开 URL 满足条件。取不到的那几张会被跳过并计入 skipped，
// 而不是让整个导出失败。

import { exportShotsZip } from "./export-zip";
import { formatAbsoluteTime, formatCoins, primaryModelId } from "./history-types";
import type { HistoryEntry } from "./history-types";

export interface HistoryExportResult {
  /** 成功写入的图片数。 */
  exported: number;
  /** 因为取不到图而跳过的条数。 */
  skipped: number;
}

/** 并发下载数。太高会被浏览器排队，也容易触发对象存储限流。 */
const DOWNLOAD_CONCURRENCY = 4;

function entrySrc(entry: HistoryEntry): string | null {
  const result = entry.results.find((item) => item.image || item.imageUrl);
  if (!result) return null;
  return result.image ? `data:image/png;base64,${result.image}` : result.imageUrl;
}

/** 用提示词开头做文件名，取不到就退回时间戳。 */
function entryFileName(entry: HistoryEntry): string {
  const prompt = entry.prompt.trim().replace(/\s+/g, " ").slice(0, 40);
  const stamp = new Date(entry.generatedAt)
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  return prompt ? `${stamp}-${prompt}` : stamp;
}

async function fetchAsBlob(src: string): Promise<Blob | null> {
  try {
    const response = await fetch(src);
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

/** 有上限的并发映射，避免一次发起几百个请求。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}

/** 打包下载选中的图片，并在压缩包里附一份 manifest.json 记录参数。 */
export async function exportHistoryZip(
  entries: HistoryEntry[],
  zipName = `生成历史-${new Date().toISOString().slice(0, 10)}.zip`,
): Promise<HistoryExportResult> {
  if (!entries.length) return { exported: 0, skipped: 0 };

  const downloaded = await mapWithConcurrency(entries, DOWNLOAD_CONCURRENCY, async (entry) => {
    const src = entrySrc(entry);
    if (!src) return null;
    const blob = await fetchAsBlob(src);
    return blob ? { name: entryFileName(entry), blob } : null;
  });

  const items = downloaded.filter((item): item is { name: string; blob: Blob } => item !== null);
  const skipped = entries.length - items.length;

  if (!items.length) return { exported: 0, skipped };

  // 清单让压缩包自带可追溯性：谁、什么时候、用什么参数生成的。
  const manifest = JSON.stringify(buildHistoryArchive(entries), null, 2);
  items.push({
    name: "manifest.json",
    blob: new Blob([manifest], { type: "application/json" }),
  });

  await exportShotsZip(items, zipName);
  return { exported: items.length - 1, skipped };
}

interface HistoryArchiveRecord {
  id: string;
  prompt: string;
  generatedAt: string;
  model: string;
  imageSize?: string;
  preset?: string;
  qualityProfile?: string;
  starred: boolean;
  coins?: string;
  imageUrls: string[];
  workflow?: HistoryEntry["workflow"];
}

/** 完整档案结构，ZIP 里的 manifest 和单独的 JSON 导出共用。 */
export function buildHistoryArchive(entries: HistoryEntry[]): {
  exportedAt: string;
  count: number;
  records: HistoryArchiveRecord[];
} {
  return {
    exportedAt: new Date().toISOString(),
    count: entries.length,
    records: entries.map((entry) => ({
      id: entry.id,
      prompt: entry.prompt,
      generatedAt: new Date(entry.generatedAt).toISOString(),
      model: primaryModelId(entry),
      ...(entry.workflow?.imageSize ? { imageSize: entry.workflow.imageSize } : {}),
      ...(entry.workflow?.workflowPresetLabel ? { preset: entry.workflow.workflowPresetLabel } : {}),
      ...(entry.workflow?.qualityProfile ? { qualityProfile: entry.workflow.qualityProfile } : {}),
      starred: Boolean(entry.starred),
      ...(entry.quota !== undefined ? { coins: formatCoins(entry.quota) } : {}),
      imageUrls: entry.results
        .map((result) => result.imageUrl)
        .filter((url): url is string => Boolean(url)),
      ...(entry.workflow ? { workflow: entry.workflow } : {}),
    })),
  };
}

/**
 * 觸發瀏覽器下載（BOM/CRLF 由呼叫端決定）。
 * 2026-09-24：導出化為公開輪子——資產審查面板的 CSV 導出複用它（純加法，函式本體零改動）。
 */
export function triggerDownload(content: string, fileName: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 导出完整参数档案，可用于日后复现或迁移。 */
export function exportHistoryJson(
  entries: HistoryEntry[],
  fileName = `生成历史-${new Date().toISOString().slice(0, 10)}.json`,
): void {
  if (!entries.length) return;
  triggerDownload(JSON.stringify(buildHistoryArchive(entries), null, 2), fileName, "application/json");
}

/**
 * CSV 字段转义：逗号、引号、换行都要包起来，引号内再翻倍。
 * 2026-09-24：導出化為公開輪子——資產審查面板只提供 header/rows 白名單，
 * 轉義一律走這裡（禁止各面自創第二套轉義）。
 */
export function csvCell(value: string | number | boolean | undefined): string {
  const text = value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 导出表格，方便在 Excel 里对账。 */
export function exportHistoryCsv(
  entries: HistoryEntry[],
  fileName = `生成历史-${new Date().toISOString().slice(0, 10)}.csv`,
): void {
  if (!entries.length) return;

  const header = ["生成时间", "提示词", "模型", "尺寸", "预设", "消耗（张）", "已收藏", "图片链接"];
  const rows = entries.map((entry) => [
    csvCell(formatAbsoluteTime(entry.generatedAt)),
    csvCell(entry.prompt),
    csvCell(primaryModelId(entry)),
    csvCell(entry.workflow?.imageSize),
    csvCell(entry.workflow?.workflowPresetLabel),
    csvCell(entry.quota !== undefined ? formatCoins(entry.quota) : ""),
    csvCell(entry.starred ? "是" : "否"),
    csvCell(entry.results.map((result) => result.imageUrl).filter(Boolean).join(" ")),
  ].join(","));

  // BOM 是必须的：没有它 Excel 会把 UTF-8 的中文读成乱码。
  triggerDownload(`﻿${[header.join(","), ...rows].join("\r\n")}`, fileName, "text/csv;charset=utf-8");
}
