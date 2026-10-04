"use client";

import { memo, useEffect, useRef } from "react";
import type { AgentChatState, AgentToolAuthScope } from "@/lib/agent-chat-types";
import { AgentMessageBubble } from "./AgentMessageBubble";
import { AgentToolCard } from "./AgentToolCard";
import { AgentImageCard, type AgentImageCardProps } from "./AgentImageCard";
import { AgentVideoCard, type AgentVideoCardProps } from "./AgentVideoCard";
import { AgentAudioCard, type AgentAudioCardProps } from "./AgentAudioCard";
import { AgentDirectorCard } from "./AgentDirectorCard";
import { AgentNoticeRow } from "./AgentNoticeRow";
import { AgentSubagentReportCard } from "./AgentSubagentReportCard";
import { AgentPlanCard } from "./AgentPlanCard";
import { NEAR_BOTTOM_PX } from "./scroll-threshold";

export interface AgentTranscriptProps {
  items: AgentChatState["items"];
  /** 出图卡动作回调的预留通道：接线前缺省传入，按钮会保持 disabled。 */
  imageActions?: Pick<
    AgentImageCardProps,
    "onSaveToLibrary" | "onEdit" | "onDownload" | "onRerun" | "onRerunVariant"
  >;
  /** 出片卡动作回调的预留通道：接线前缺省传入，按钮会保持 disabled。 */
  videoActions?: Pick<
    AgentVideoCardProps,
    "onSaveToLibrary" | "onDownload" | "onRerun" | "onVariant"
  >;
  /** 出音频卡动作回调的预留通道：接线前缺省传入，按钮会保持 disabled。 */
  audioActions?: Pick<
    AgentAudioCardProps,
    "onSaveToLibrary" | "onDownload" | "onRerun" | "onVariant"
  >;
  /** 网关暂态状态行（turn.status 事件）：新状态替换旧行，真实内容/turn.done 即清。 */
  turnStatus?: string;
  /** 当前会话 id：透传给用户气泡的附件卡铸读取票。 */
  sessionId?: string | null;
  /** 本机文件授权回传（缺陷 C）：工具卡三选一点击后带 scope＋root 走授权。 */
  onAuthorizeLocalFiles?: (scope: AgentToolAuthScope, root?: string) => void | Promise<void>;
}

/** 从某元素往上找最近的滚动容器（overflow-y 可滚且内容超出）。 */
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

function AgentTranscriptComponent({ items, imageActions, videoActions, audioActions, sessionId, turnStatus, onAuthorizeLocalFiles }: AgentTranscriptProps) {
  const listRef = useRef<HTMLOListElement>(null);
  // 滚动容器缓存：找到后不再每次 getComputedStyle 向上找。
  const scrollerRef = useRef<HTMLElement | null>(null);

  // 自动滚到底：串流长文、图片载入、工具卡/参数展开都会撑高列表，若使用者本来
  // 贴底就维持贴底让最新内容可见（补上宿主只盯 items.length/lastEventId 的盲区）；
  // 使用者往上翻历史时不抢方向盘。
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const ro = new ResizeObserver(() => {
      if (!scrollerRef.current) scrollerRef.current = findScrollParent(list);
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const nearBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_BOTTOM_PX;
      if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
    });
    ro.observe(list);
    return () => ro.disconnect();
  }, []);

  return (
    // 2026-10-03 手机排版刀 2：窄屏轮间距 10px→20px（讯息与卡片贴成一片、
    // 轮与轮分不清）；桌面 ≥640px 维持 gap-2.5，一字不动。
    <ol ref={listRef} className="flex flex-col gap-5 sm:gap-2.5">
      {items.map((item) => {
        switch (item.kind) {
          case "user":
          case "assistant":
            return (
              <li key={item.id}>
                <AgentMessageBubble item={item} sessionId={sessionId} />
              </li>
            );
          case "tool":
            return (
              <li key={item.id}>
                <AgentToolCard item={item} onAuthorize={onAuthorizeLocalFiles} />
              </li>
            );
          case "image":
            return (
              <li key={item.id}>
                <AgentImageCard item={item} {...imageActions} />
              </li>
            );
          case "video":
            return (
              <li key={item.id}>
                <AgentVideoCard item={item} {...videoActions} />
              </li>
            );
          case "audio":
            return (
              <li key={item.id}>
                <AgentAudioCard item={item} {...audioActions} />
              </li>
            );
          case "director":
            return (
              <li key={item.id}>
                <AgentDirectorCard item={item} />
              </li>
            );
          case "notice":
            return (
              <li key={item.id}>
                <AgentNoticeRow item={item} />
              </li>
            );
          case "plan":
            // 本轮计画（turn.plan）的独立区块：与工具卡同宽、独立成条，
            // 绝不并进任何 assistant 气泡（计画不是交付物，答案才是）。
            return (
              <li key={item.id}>
                <AgentPlanCard item={item} />
              </li>
            );
          case "subagent":
            // 子代理条目不进消息流：AgentChatPanel 顶部的 AgentSubagentBar 负责。
            return null;
          case "subagent_result":
            // 回合收尾后的产出卡（F3）：summary/全文留在转录里，可整行展开（F4）。
            return (
              <li key={item.id}>
                <AgentSubagentReportCard item={item} />
              </li>
            );
        }
      })}
      {turnStatus ? (
        <li>
          <div className="agent-turn-status text-ios-caption1 text-muted-foreground" role="status" aria-live="polite">
            <span className="agent-turn-status-dot" aria-hidden />
            <span>{turnStatus}</span>
          </div>
        </li>
      ) : null}
    </ol>
  );
}

export const AgentTranscript = memo(AgentTranscriptComponent);
