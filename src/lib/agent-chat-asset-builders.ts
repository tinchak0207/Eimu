// agent-chat-asset-builders：聊天产出 → 资产包 item 的纯函数。
// 与 AgentChatSurface 分离以避开 CSS import 链，让 node:test 可直接 import 测试。

import type { AgentAudioItem, AgentImageItem, AgentVideoItem } from "./agent-chat-types";
import type { AssetPackItem, AssetPackItemKind } from "./asset-pack-store";
import { assetItemKindOf, assetUrlFieldOf, deliverableKindLabel } from "./deliverable-kind";

/** 聊天素材的确定性资产包 id：onSaveToLibrary 与「我的资产」共用，upsert 同一包。 */
export const CHAT_ASSETS_PACK_ID = "chat-assets";

/**
 * 「存图库」可承接的聊天条目：图／影片／音頻三種交付物。
 * 种类值域与 deliverable-kind 注册表的 DeliverableKind 逐字一致
 * （image/video/audio），所以 item.kind 可直接当 deliverable 查表。
 */
export type AgentChatLibraryItem = AgentImageItem | AgentVideoItem | AgentAudioItem;

/**
 * 聊天产出 → 资产包 item 的纯函数（图／影片／音頻三态）。
 * 图：带真实配方（item.recipe.prompt 非空）存 kind:"recipe" 的配方资产；
 * 否则维持原 reference 逻辑（纯图引用）——图片分支逐字不变（既有输出契约）。
 * 影片／音頻：没有配方概念，kind 与 URL 承载栏位一律查 deliverable-kind 注册表
 * （image→imageUrl，video/audio→mediaUrl），title 用真实时间兜底（不编造内容）。
 */
export function buildChatSaveItem(
  item: AgentChatLibraryItem,
  sessionId: string | null,
  now: string,
): AssetPackItem {
  if (item.kind === "image") {
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
  // 影片／音頻：种类与 URL 栏位由注册表推导（单一真源）。
  const deliverable = item.kind;
  const urlField = assetUrlFieldOf(deliverable);
  return {
    // 注册表的 assetItemKind 是 AssetPackItemKind 的子集（image/video/audio）；
    // 注册表以 string 宣告以保持零依赖，这里收回窄型别。
    kind: assetItemKindOf(deliverable) as AssetPackItemKind,
    // title 走真实时间兜底——影音没有 seq 配方语义，不编造内容。
    title: `${deliverableKindLabel(deliverable)} ${new Date(now).toLocaleString("zh-CN")}`,
    ...(urlField === "imageUrl" ? { imageUrl: item.url } : { mediaUrl: item.url }),
    source: { type: "chat", id: item.id, ...(sessionId ? { sessionId } : {}) },
    createdAt: now,
  };
}
