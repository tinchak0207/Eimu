"use client";

import { memo, useEffect, useRef } from "react";
import type { AgentChatState } from "@/lib/agent-chat-types";
import { AgentMessageBubble } from "./AgentMessageBubble";
import { AgentToolCard } from "./AgentToolCard";
import { AgentImageCard, type AgentImageCardProps } from "./AgentImageCard";
import { AgentNoticeRow } from "./AgentNoticeRow";

export interface AgentTranscriptProps {
  items: AgentChatState["items"];
  /** 出图卡动作回调的预留通道：接线前缺省传入，按钮会保持 disabled。 */
  imageActions?: Pick<
    AgentImageCardProps,
    "onSaveToLibrary" | "onEdit" | "onUpscale" | "onDownload"
  >;
}

/** 從某元素往上找最近的滾動容器（overflow-y 可滾且內容超出）。 */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    if (node.scrollHeight > node.clientHeight) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
        return node;
      }
    }
    node = node.parentElement;
  }
  return null;
}

function AgentTranscriptComponent({ items, imageActions }: AgentTranscriptProps) {
  const listRef = useRef<HTMLOListElement>(null);
  // 滾動容器緩存：找到後不再每次 getComputedStyle 向上找。
  const scrollerRef = useRef<HTMLElement | null>(null);

  // 自動滾到底：串流長文、圖片載入、工具卡/参数展开都會撐高列表，若使用者本來
  // 貼底就維持貼底讓最新內容可見（補上宿主只盯 items.length/lastEventId 的盲區）；
  // 使用者往上翻歷史時不搶方向盤。
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const ro = new ResizeObserver(() => {
      if (!scrollerRef.current) scrollerRef.current = findScrollParent(list);
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
      if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
    });
    ro.observe(list);
    return () => ro.disconnect();
  }, []);

  return (
    <ol ref={listRef} className="flex flex-col gap-2.5">
      {items.map((item) => {
        switch (item.kind) {
          case "user":
          case "assistant":
            return (
              <li key={item.id}>
                <AgentMessageBubble item={item} />
              </li>
            );
          case "tool":
            return (
              <li key={item.id}>
                <AgentToolCard item={item} />
              </li>
            );
          case "image":
            return (
              <li key={item.id}>
                <AgentImageCard item={item} {...imageActions} />
              </li>
            );
          case "notice":
            return (
              <li key={item.id}>
                <AgentNoticeRow item={item} />
              </li>
            );
        }
      })}
    </ol>
  );
}

export const AgentTranscript = memo(AgentTranscriptComponent);
