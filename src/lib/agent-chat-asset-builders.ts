// agent-chat-asset-builders：聊天出图 → 资产包 item 的纯函数。
// 与 AgentChatSurface 分离以避开 CSS import 链，让 node:test 可直接 import 测试。

import type { AgentImageItem } from "./agent-chat-types";
import type { AssetPackItem } from "./asset-pack-store";

/** 聊天素材的确定性资产包 id：onSaveToLibrary 与「我的资产」共用，upsert 同一包。 */
export const CHAT_ASSETS_PACK_ID = "chat-assets";

/**
 * 聊天出图 → 资产包 item 的纯函数。
 * 带真实配方（item.recipe.prompt 非空）存 kind:"recipe" 的配方资产；
 * 否则维持原 reference 逻辑（纯图引用）。
 */
export function buildChatSaveItem(item: AgentImageItem, sessionId: string | null, now: string): AssetPackItem {
  if (item.recipe?.prompt) {
    return {
      kind: "recipe",
      title: `第 ${item.seq} 张`,
      content: item.recipe.prompt,
      ...(item.recipe.model ? { modelId: item.recipe.model } : {}),
      ...(item.recipe.size ? { size: item.recipe.size } : {}),
      ...(item.recipe.lora ? { loraModelVersionIds: [item.recipe.lora] } : {}),
      imageUrl: item.url,
      source: { type: "chat", id: item.id, ...(sessionId ? { sessionId } : {}) },
      createdAt: now,
    };
  }
  return {
    kind: "reference",
    title: `第 ${item.seq} 张`,
    imageUrl: item.url,
    source: { type: "chat", id: item.id, ...(sessionId ? { sessionId } : {}) },
    createdAt: now,
  };
}