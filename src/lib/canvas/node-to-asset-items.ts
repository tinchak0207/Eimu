// 纯函式：把「画布节点 / 提示词卡」转为资产包 item 清单。
//
// 供 CanvasLibraryPanel 的「存入资产包」动作使用（确定性包 id "canvas-assets"）：
// - 有 prompt → {kind:"prompt", title: 节点标题或"画布提示词", content, modelId?, size?, source:{type:"canvas", id}}
// - 有 LoRA（loraModelVersionIds 第一个）→ {kind:"lora", title:"LoRA", loraVersionId}
// - 有关联图 → {kind:"image", title:"参考图", imageUrl}
// 纯函式无副作用（不 fetch / 不读 store），方便单测。

import type { AssetPackItem } from "@/lib/asset-pack-store";

/** 转换输入：涵盖画布节点与提示词卡的共通栏位。 */
export interface NodeToAssetPackInput {
  id: string;
  title?: string;
  prompt?: string;
  modelId?: string;
  size?: string;
  loraModelVersionIds?: string[];
  imageUrl?: string;
}

export function nodeToAssetPackItems(node: NodeToAssetPackInput): AssetPackItem[] {
  const items: AssetPackItem[] = [];

  const prompt = node.prompt?.trim();
  if (prompt) {
    items.push({
      kind: "prompt",
      title: node.title?.trim() || "画布提示词",
      content: prompt,
      ...(node.modelId?.trim() ? { modelId: node.modelId.trim() } : {}),
      ...(node.size?.trim() ? { size: node.size.trim() } : {}),
      source: { type: "canvas", id: node.id },
    });
  }

  const loraVersionId = node.loraModelVersionIds?.find((id) => id.trim());
  if (loraVersionId) {
    items.push({ kind: "lora", title: "LoRA", loraVersionId: loraVersionId.trim() });
  }

  const imageUrl = node.imageUrl?.trim();
  if (imageUrl) {
    items.push({ kind: "image", title: "参考图", imageUrl });
  }

  return items;
}