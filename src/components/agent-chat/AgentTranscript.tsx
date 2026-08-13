"use client";

import { memo } from "react";
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

function AgentTranscriptComponent({ items, imageActions }: AgentTranscriptProps) {
  return (
    <ol className="flex flex-col gap-2.5">
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
