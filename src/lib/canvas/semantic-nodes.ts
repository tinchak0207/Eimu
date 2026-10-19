// 画布语义节点（prompt / reference）的纯逻辑：
//
//   - resolveGenerationInputs：沿「入边」收集连到生成节点的 prompt 节点文本、
//     reference 节点图片（含角色），以及 3D 场景卡（scene_3d）的白模/静态图参考
//     （P1-1 参考绑定），供手动 UI 与 agent run_generation 共用，保证两条路径的
//     接线语义完全一致。
//   - composeGenerationPrompt：prompt 节点文本作为前缀，与面板正文合成最终 prompt。
//   - mergeGenerationReferences：手动 @引用 与连线自动带入的参考图按 nodeId 去重合并。
//
// 角色枚举 owner 是 image-types.ReferenceImageRole；这里只做纯函式，不建第二套。
import { CanvasNodeType } from "./types";
import type { CanvasConnection, CanvasNode } from "./types";
import { toReferenceImageRole } from "../image-types";
import type { ReferenceImageRole } from "../image-types";
import { sceneCardGenerationReferences } from "./scene-3d-reference";

/** 画布参考图的传输形状（CanvasEmbed → /api/canvas/generate）。 */
export interface CanvasGenerationReference {
  /** 来源节点 id（去重用；API 直传的参考可省略）。 */
  nodeId?: string;
  url: string;
  role: ReferenceImageRole;
  name: string;
}

/** 图片 URL 判定：http(s) 与 data:image（与 /api/canvas/generate 的收口一致）。 */
function isUsableImageUrl(url: string | undefined | null): url is string {
  if (!url) return false;
  return url.startsWith("http") || url.startsWith("data:image/");
}

/** 节点的可作为参考图的 URL（image / reference 节点）。 */
export function referenceImageUrlOf(node: CanvasNode | undefined): string | null {
  const content = node?.metadata?.content;
  if (!content) return null;
  if (node?.type !== CanvasNodeType.Image && node?.type !== CanvasNodeType.Reference) return null;
  return isUsableImageUrl(content) ? content : null;
}

export interface GenerationSemanticInputs {
  /** 连入的 prompt 节点文本（连线顺序，已过滤空文本）。 */
  promptParts: string[];
  /** 连入的 reference 节点（url + 角色 + 标题）。 */
  references: CanvasGenerationReference[];
}

/**
 * 收集 targetNodeId 的入边语义输入：
 *   - prompt 节点 → 文本进 promptParts（作为前缀）
 *   - reference 节点 → 图 + 角色进 references
 *   - scene_3d 节点 → sceneCard 白模/静态图进 references（P1-1 参考绑定；走
 *     `sceneCardGenerationReferences` 的既有参考卡轮子，previz→composition）
 * 普通 image / text 节点不自动带入（维持 @引用 的显式选取语义）。
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
    } else if (from.type === CanvasNodeType.Scene3d) {
      // 3D 场景卡：白模/静态图 → 生成参考（首张带 nodeId 作回分镜指针，其余靠 url 去重）。
      references.push(...sceneCardGenerationReferences(from));
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
 * 合成最终生成 prompt：prompt 节点文本在前（前缀），面板正文在后。
 * 无前缀时原文返回（不动旧路径的请求位元组）。
 */
export function composeGenerationPrompt(promptParts: string[], basePrompt: string): string {
  const prefix = promptParts.map((p) => p.trim()).filter(Boolean).join("\n");
  if (!prefix) return basePrompt;
  const base = basePrompt.trim();
  return base ? `${prefix}\n${base}` : prefix;
}

/**
 * 合并参考图清单：primary 在前（手动 @引用 的显式意图优先），
 * 按 nodeId（有则）或 url 去重，连线自动带入的排其后。
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
