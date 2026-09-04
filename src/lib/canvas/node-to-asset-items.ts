// 純函式：把「畫布節點 / 提示詞卡」轉為資產包 item 清單。
//
// 供 CanvasLibraryPanel 的「存入资产包」動作使用（確定性包 id "canvas-assets"）：
// - 有 prompt → {kind:"prompt", title: 節點標題或"画布提示词", content, modelId?, size?, source:{type:"canvas", id}}
// - 有 LoRA（loraModelVersionIds 第一個）→ {kind:"lora", title:"LoRA", loraVersionId}
// - 有關聯圖 → {kind:"image", title:"参考图", imageUrl}
// 純函式無副作用（不 fetch / 不讀 store），方便單測。

import type { AssetPackItem } from "@/lib/asset-pack-store";

/** 轉換輸入：涵蓋畫布節點與提示詞卡的共通欄位。 */
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