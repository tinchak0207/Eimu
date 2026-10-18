"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { AgentAudioItem, AgentChatState, AgentImageItem, AgentVideoItem } from "@/lib/agent-chat-types";
import type { AgentImageCardProps } from "./AgentImageCard";
import type { AgentVideoCardProps } from "./AgentVideoCard";
import type { AgentAudioCardProps } from "./AgentAudioCard";

/**
 * 会话产物上下文（2026-10-18）：OpenUI 成品组件（ImageResult / VideoPlayer / AudioPlayer /
 * AlbumPlayer / ImageGallery / CompareView / DeliverableCard）只收 taskId，从这里查真实条目。
 *
 * 真源＝当前会话 transcript 里已到达的 image.done / video.done / audio.done 条目——
 * 子代理产物经网关 /internal/emit（subagentParentState）同样落进父会话的这三类事件，
 * 因此天然覆盖子代理交付路径。动作回调与面板上的媒体卡同一组（下载/再来/变体/存图库）。
 */
export type AgentMediaItem = AgentImageItem | AgentVideoItem | AgentAudioItem;

export type AgentArtifactsValue = {
  items: AgentMediaItem[];
  imageActions?: Pick<AgentImageCardProps, "onSaveToLibrary" | "onEdit" | "onDownload" | "onRerun" | "onRerunVariant">;
  videoActions?: Pick<AgentVideoCardProps, "onSaveToLibrary" | "onDownload" | "onRerun" | "onVariant">;
  audioActions?: Pick<AgentAudioCardProps, "onSaveToLibrary" | "onDownload" | "onRerun" | "onVariant">;
};

const AgentArtifactsContext = createContext<AgentArtifactsValue | undefined>(undefined);

export function AgentArtifactsProvider({
  items,
  imageActions,
  videoActions,
  audioActions,
  children,
}: {
  items: AgentChatState["items"];
  imageActions?: AgentArtifactsValue["imageActions"];
  videoActions?: AgentArtifactsValue["videoActions"];
  audioActions?: AgentArtifactsValue["audioActions"];
  children: ReactNode;
}) {
  const media = useMemo(
    () =>
      items.filter(
        (it): it is AgentMediaItem => it.kind === "image" || it.kind === "video" || it.kind === "audio",
      ),
    [items],
  );
  const value = useMemo(
    () => ({ items: media, imageActions, videoActions, audioActions }),
    [media, imageActions, videoActions, audioActions],
  );
  return <AgentArtifactsContext.Provider value={value}>{children}</AgentArtifactsContext.Provider>;
}

export function useAgentArtifacts(): AgentArtifactsValue | undefined {
  return useContext(AgentArtifactsContext);
}

/**
 * 按 ref 查会话产物：先精确匹配 task_id，再精确匹配产物 URL（无 task_id 的成片/子代理产物
 * 在会话任务表里只有 URL）。只在会话已有条目里查——任意字符串都不会变成可加载的地址。
 */
export function resolveArtifact(items: readonly AgentMediaItem[], ref: string): AgentMediaItem | undefined {
  const key = ref.trim();
  if (!key) return undefined;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].taskId && items[i].taskId === key) return items[i];
  }
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].url === key) return items[i];
  }
  return undefined;
}
