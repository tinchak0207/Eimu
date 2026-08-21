// 畫布語義節點（prompt / reference）的純邏輯：
//
//   - resolveGenerationInputs：沿「入邊」收集連到生成節點的 prompt 節點文本
//     與 reference 節點圖片（含角色），供手動 UI 與 agent run_generation 共用，
//     保證兩條路徑的接線語義完全一致。
//   - composeGenerationPrompt：prompt 節點文本作為前綴，與面板正文合成最終 prompt。
//   - mergeGenerationReferences：手動 @引用 與連線自動帶入的參考圖按 nodeId 去重合併。
//
// 角色枚舉 owner 是 image-types.ReferenceImageRole；這裡只做純函式，不建第二套。
import { CanvasNodeType } from "./types";
import type { CanvasConnection, CanvasNode } from "./types";
import { toReferenceImageRole } from "../image-types";
import type { ReferenceImageRole } from "../image-types";

/** 畫布參考圖的傳輸形狀（CanvasEmbed → /api/canvas/generate）。 */
export interface CanvasGenerationReference {
  /** 來源節點 id（去重用；API 直傳的參考可省略）。 */
  nodeId?: string;
  url: string;
  role: ReferenceImageRole;
  name: string;
}

/** 圖片 URL 判定：http(s) 與 data:image（與 /api/canvas/generate 的收口一致）。 */
function isUsableImageUrl(url: string | undefined | null): url is string {
  if (!url) return false;
  return url.startsWith("http") || url.startsWith("data:image/");
}

/** 節點的可作為參考圖的 URL（image / reference 節點）。 */
export function referenceImageUrlOf(node: CanvasNode | undefined): string | null {
  const content = node?.metadata?.content;
  if (!content) return null;
  if (node?.type !== CanvasNodeType.Image && node?.type !== CanvasNodeType.Reference) return null;
  return isUsableImageUrl(content) ? content : null;
}

export interface GenerationSemanticInputs {
  /** 連入的 prompt 節點文本（連線順序，已過濾空文本）。 */
  promptParts: string[];
  /** 連入的 reference 節點（url + 角色 + 標題）。 */
  references: CanvasGenerationReference[];
}

/**
 * 收集 targetNodeId 的入邊語義輸入：
 *   - prompt 節點 → 文本進 promptParts（作為前綴）
 *   - reference 節點 → 圖 + 角色進 references
 * 普通 image / text 節點不自動帶入（維持 @引用 的顯式選取語義）。
 */
export function resolveGenerationInputs(
  nodes: CanvasNode[],
  connections: CanvasConnection[],
  targetNodeId: string,
): GenerationSemanticInputs {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const promptParts: string[] = [];
  const references: CanvasGenerationReference[] = [];
  for (const c of connections) {
    if (c.toNodeId !== targetNodeId) continue;
    const from = byId.get(c.fromNodeId);
    if (!from) continue;
    if (from.type === CanvasNodeType.Prompt) {
      const text = (from.metadata?.content ?? "").trim();
      if (text) promptParts.push(text);
    } else if (from.type === CanvasNodeType.Reference) {
      const url = referenceImageUrlOf(from);
      if (url) {
        references.push({
          nodeId: from.id,
          url,
          role: toReferenceImageRole(from.metadata?.referenceRole),
          name: from.title || "参考图",
        });
      }
    }
  }
  return { promptParts, references };
}

/**
 * 合成最終生成 prompt：prompt 節點文本在前（前綴），面板正文在後。
 * 無前綴時原文返回（不動舊路徑的請求位元組）。
 */
export function composeGenerationPrompt(promptParts: string[], basePrompt: string): string {
  const prefix = promptParts.map((p) => p.trim()).filter(Boolean).join("\n");
  if (!prefix) return basePrompt;
  const base = basePrompt.trim();
  return base ? `${prefix}\n${base}` : prefix;
}

/**
 * 合併參考圖清單：primary 在前（手動 @引用 的顯式意圖優先），
 * 按 nodeId（有則）或 url 去重，連線自動帶入的排其後。
 */
export function mergeGenerationReferences(
  primary: CanvasGenerationReference[],
  secondary: CanvasGenerationReference[],
): CanvasGenerationReference[] {
  const seenNode = new Set<string>();
  const seenUrl = new Set<string>();
  const out: CanvasGenerationReference[] = [];
  for (const ref of [...primary, ...secondary]) {
    if (ref.nodeId) {
      if (seenNode.has(ref.nodeId)) continue;
      seenNode.add(ref.nodeId);
    }
    if (seenUrl.has(ref.url)) continue;
    seenUrl.add(ref.url);
    out.push(ref);
  }
  return out;
}
