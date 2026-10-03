/**
 * embed-helpers —— CanvasEmbed 純函數 / UI types / 常量（自 CanvasEmbed.tsx L72-212 機械搬遷，符號名不變）。
 * 生成/超分認證走 Bearer + x-user-id（與 playground 同款 getStoredToken）。
 */
import { CanvasNodeType, type CanvasConnection, type CanvasNode, type CanvasPosition } from "@/lib/canvas/types";
import type { CanvasImageEditMode } from "../CanvasImageEditorDialog";
import { getStoredToken, getStoredUser } from "@/lib/new-api-client";
import { GENERATION_TRACE_ID_HEADER, newGenerationTraceId } from "@/lib/generation-request-headers";

/** 同一批節點進場的間隔（ms）。 */
export const ENTER_STAGGER_MS = 110;
/** B1 視口裁剪的螢幕外緩衝（px）。 */
export const CULL_MARGIN_PX = 280;
/** 拖圖/多檔導入的階梯錯位（px）。 */
export const IMPORT_STAGGER = 40;

export function toDvh(height: string): string {
  return height.replace(/vh/g, "dvh");
}

export function formatRelative(updatedAt: string): string {
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return "";
  const diff = Date.now() - ts;
  if (diff < 0) return "刚刚";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** 節點的可下載/可編輯圖片 URL（僅 http(s)/data:）；image 與 reference 節點。 */
export function imageUrlOf(node: CanvasNode | undefined): string | null {
  const content = node?.metadata?.content;
  if (!content) return null;
  if (node?.type !== CanvasNodeType.Image && node?.type !== CanvasNodeType.Reference) return null;
  return content.startsWith("http") || content.startsWith("data:") ? content : null;
}

export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 80) || "image";
}

export async function fetchImageBlob(url: string): Promise<Blob> {
  if (url.startsWith("data:")) {
    return (await fetch(url)).blob();
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`获取失败（${res.status}）`);
    return await res.blob();
  } catch {
    const res = await fetch(`/api/canvas/image-proxy?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error(`图片获取失败（${res.status}）`);
    return res.blob();
  }
}

export function triggerDownload(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
}

/**
 * 生成/超分認證頭（Bearer + x-user-id）。R5：生成型呼叫可傳 `withTraceId=true`
 * 多帶一個 `X-Request-Id`，讓這條請求在其下游（route → 控制面）有一致的 trace id；
 * 非生成的畫布/資產查詢呼叫維持不帶（預設 false，逐位不變）。
 */
export function buildAuthHeaders(withTraceId = false): Record<string, string> | null {
  const token = getStoredToken();
  const user = getStoredUser();
  if (!token || !user?.id) return null;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "x-user-id": String(user.id) };
  if (withTraceId) headers[GENERATION_TRACE_ID_HEADER] = newGenerationTraceId();
  return headers;
}

/** 本地圖片檔 → 壓縮 dataURL（browser-image-compression，1600px/1.5MB 上限）。 */
export async function fileToDataUrl(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  const { default: imageCompression } = await import("browser-image-compression");
  const compressed = await imageCompression(file, { maxWidthOrHeight: 1600, maxSizeMB: 1.5, useWebWorker: true });
  const dataUrl = await imageCompression.getDataUrlFromFile(compressed);
  const size = await new Promise<{ width: number; height: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
  return { dataUrl, ...size };
}

/** 環路檢查：from→to 加入後是否成環（to 沿出邊可達 from）。 */
export function wouldCreateCycle(connections: CanvasConnection[], fromId: string, toId: string): boolean {
  const out = new Map<string, string[]>();
  for (const c of connections) out.set(c.fromNodeId, [...(out.get(c.fromNodeId) ?? []), c.toNodeId]);
  const queue = [toId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (cur === fromId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of out.get(cur) ?? []) queue.push(next);
  }
  return false;
}

export interface MenuState {
  position: { x: number; y: number };
  world: { x: number; y: number };
  targetNodeId: string | null;
  targetConnectionId?: string | null;
}

export interface EditorState {
  nodeId: string;
  mode: CanvasImageEditMode;
}

export interface PortDragState {
  sourceId: string;
  side: "left" | "right";
  cursor: CanvasPosition | null;
}

export interface CreateMenuState {
  position: { x: number; y: number };
  world: CanvasPosition;
  /** 連線拖放到空白時：建完自動與該節點連線。 */
  connectFrom?: { nodeId: string; side: "left" | "right" };
}
