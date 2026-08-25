"use client";

import { type CSSProperties, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { ChevronUp, MessageCircle, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import { cn } from "@/lib/utils";
import { useChatPanel } from "./use-chat-panel";

// CanvasEmbed 維持 dynamic 懶載入：它是畫布工作站的天然 chunk 邊界，
// 只有 inCanvasWorkstation 為真（overlay 真的渲染）時才拉 chunk。
const CanvasEmbed = dynamic(() => import("@/components/canvas/CanvasEmbed").then((m) => m.CanvasEmbed), { ssr: false });

export interface CanvasChatWorkstationProps {
  /** ImagePlayground 的派生值：displayMode === "agent" && !showProfessionalMode。 */
  inCanvasWorkstation: boolean;
  isLoading: boolean;
  /** useCanvasChat 的回傳值（SSE 事件餵回畫布的 host）。 */
  canvasHost: UseCanvasChatReturn;
  /**
   * 畫布初始態內容（2026-08-25 助理模板庫）：canvas 空且無對話時，
   * overlay 內容換成它（模板庫）而不是空畫布。有值時 CanvasEmbed 不渲染。
   */
  overlayContent?: ReactNode;
  /**
   * 面板內容（D-12 撤銷條 + PromptInput）。收合按鈕（chatHeaderExtra）由面板
   * 兩態決定，經 render prop 回傳給內容接線——面板狀態是本組件的私有域。
   */
  children: (chatHeaderExtra: ReactNode) => ReactNode;
}

/**
 * 畫布工作站的殼：inline <style>（含跨檔作用於 AgentChatPanel 的
 * .agent-composer-anchor——style 塊必須跟 overlay 同一生命週期）+ 全場畫布
 * overlay + 聊天面板殼/拖寬手柄。面板兩態與寬度記憶在 use-chat-panel。
 * 本組件常駐掛載（非工作站態只是換 class），聊天卡 DOM 不搬家——
 * SSE 會話與輸入狀態零丟失。
 */
export function CanvasChatWorkstation({
  inCanvasWorkstation,
  isLoading,
  canvasHost,
  overlayContent,
  children,
}: CanvasChatWorkstationProps) {
  const { chatPanelState, setChatPanelState, chatPanelWidth, setChatPanelWidth, chatPanelDragRef } = useChatPanel();

  return (
    <>
      {/* 畫布工作站樣式：面板 fixed 浮於畫布上、兩態寬度過渡、行動端改底部抽屜。
          Liquid glass 紀律：面板是唯一一層玻璃卡——內層 PromptInput 的 lg-card
          在工作站態拍扁（透明、無影、無圓角），不許卡中卡堆疊。 */}
      <style>{`
            @keyframes canvas-ws-fade {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            @keyframes canvas-ws-panel-in {
              from { opacity: 0; transform: translateX(-18px) scale(0.985); }
              to { opacity: 1; transform: none; }
            }
            .canvas-ws-overlay { animation: canvas-ws-fade 0.32s ease-out; transition: left 0.32s cubic-bezier(0.2, 0.8, 0.2, 1); }
            .canvas-chat-panel {
              position: fixed;
              z-index: 60;
              top: calc(0.75rem + env(safe-area-inset-top, 0px));
              bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
              left: 0.75rem;
              display: flex;
              flex-direction: column;
              min-height: 0;
              max-height: calc(100dvh - 1.5rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
              max-width: calc(100vw - 1.5rem);
              /* 2026-08-22 統一裁定：面板只是定位殼，零自帶 chrome——
                 內層 lg-card 以主頁原皮（白底/圓角/陰影）浮在畫布上，
                 觸發前後是同一張卡（寬度除外）。 */
              overflow: visible;
              transition: width 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
              animation: canvas-ws-panel-in 0.36s cubic-bezier(0.2, 0.8, 0.2, 1);
            }
            .canvas-chat-rail {
              width: 3.25rem !important;
              /* 面板殼已零 chrome，細欄自己帶最小可見度（否則按鈕浮在點陣上看不清）。 */
              background: rgba(255, 255, 255, 0.86);
              backdrop-filter: blur(20px) saturate(160%);
              -webkit-backdrop-filter: blur(20px) saturate(160%);
              border: 1px solid rgba(255, 255, 255, 0.55);
              border-radius: 18px;
              box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
              overflow: hidden;
            }
            .canvas-chat-scroll {
              flex: 1;
              min-height: 0;
              overflow-y: auto;
              padding: 0;
              overscroll-behavior: contain;
            }
            .canvas-chat-rail .canvas-chat-scroll { display: none; }
            /* 面板態聊天區填滿面板：scroll 容器變縱向 flex、不再自己滾，
               滾動收進 transcript 內部（agent 面的固定高在 46dvh 抽屜裡會溢出被裁）。 */
            .canvas-chat-scroll.canvas-chat-scroll-fill {
              display: flex;
              flex-direction: column;
              overflow: hidden;
              overflow-y: hidden;
            }
            .canvas-chat-scroll-fill > * { min-height: 0; }
            .canvas-chat-scroll-fill > section.lg-card {
              flex: 1 1 0%;
              /* 防御：卡片内部（agent 面）超高时也不许把 section 撑高，
                 滚动一律收进 transcript；否则 composer 会被推出面板外。 */
              min-height: 0;
              overflow: hidden;
            }
            .canvas-chat-scroll-fill > :not(section.lg-card) { flex-shrink: 0; }
            .agent-composer-anchor { flex-shrink: 0; }
            .canvas-chat-resize {
              position: absolute;
              top: 0;
              bottom: 0;
              right: -2px;
              width: 10px;
              cursor: col-resize;
              z-index: 5;
              touch-action: none;
            }
            .canvas-chat-resize:hover { background: linear-gradient(to right, transparent, rgba(0, 122, 255, 0.25)); }
            @media (prefers-reduced-motion: reduce) {
              .canvas-ws-overlay, .canvas-chat-panel { animation: none; }
              .canvas-chat-panel { transition: none; }
              .canvas-ws-overlay { transition: none; }
            }
            @media (max-width: 767px) {
              /* 行動端面板變底部抽屜，畫布恢復全屏。 */
              .canvas-ws-overlay { left: 0 !important; }
              .canvas-chat-panel {
                left: 0.5rem;
                right: 0.5rem;
                top: calc(5rem + env(safe-area-inset-top, 0px));
                bottom: calc(0.5rem + env(safe-area-inset-bottom, 0px));
                height: auto;
                width: auto !important;
                transition: top 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
              }
              .canvas-chat-panel::before {
                content: "";
                position: absolute;
                top: 6px;
                left: 50%;
                transform: translateX(-50%);
                width: 36px;
                height: 4px;
                border-radius: 999px;
                background: rgba(0, 0, 0, 0.16);
              }
              .canvas-chat-rail { top: auto; height: 3.25rem; width: auto !important; }
              .canvas-chat-rail::before { display: none; }
              .canvas-chat-resize { display: none; }
            }
      `}</style>
      {/* 畫布工作站：畫布吃滿全場（遼闊是預設，不再塞右欄縫裡），聊天卡原地
          換裝成左側固定面板——DOM 不搬家，SSE 會話與輸入狀態零丟失。
          面板不能蓋住畫布左緣的節點：整個 overlay 向右 dock，left = 0.75rem
          + 面板寬 + 12px 間隙（--ce-dock-left 跟隨面板寬度過渡，動畫同步）。
          2026-08-25 canvas 常駐化：agent 模式右側永遠是這個 overlay，
          初始態（canvas 空）以 overlayContent（模板庫）代替空畫布。 */}
      {inCanvasWorkstation && (
        <div
          className="canvas-ws-overlay fixed right-0 top-0 z-50 h-[100dvh] bg-[#F2F2F7]"
          style={
            {
              "--ce-dock-left": `${chatPanelState === "expanded" ? chatPanelWidth + 12 : 64}px`,
              left: "calc(0.75rem + var(--ce-dock-left, 0px))",
            } as CSSProperties
          }
        >
          {overlayContent ?? <CanvasEmbed canvas={canvasHost} expanded />}
        </div>
      )}
      {/* min-w-0 is load-bearing: an auto-sized grid column takes its
          minimum from the item's min-content, so a single nowrap
          control inside the card would widen the column past the
          viewport and push the whole page sideways on phones. */}
      <div
        className={cn(
          inCanvasWorkstation ? "canvas-chat-panel" : "min-w-0",
          inCanvasWorkstation && chatPanelState === "rail" && "canvas-chat-rail",
        )}
        style={inCanvasWorkstation && chatPanelState === "expanded" ? { width: chatPanelWidth } : undefined}
      >
        {/* 面板頂欄（2026-08-22 統一裁定）：只在 rail 細欄態存在——
            細欄需要一顆展開按鈕。expanded 態不渲染頂欄：收合按鈕
            併入聊天 header（chatHeaderExtra），觸發前後同一個 UI。 */}
        {inCanvasWorkstation && chatPanelState === "rail" && (
          <div className="flex h-full flex-col justify-start gap-2 py-2.5 max-md:h-auto max-md:flex-row">
            <button
              type="button"
              onClick={() => setChatPanelState("expanded")}
              title="展开对话面板"
              aria-label="展开对话面板"
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[#007AFF] transition-colors hover:bg-[rgba(0,122,255,0.1)]"
            >
              <PanelLeftOpen className="h-4 w-4 max-md:hidden" aria-hidden="true" />
              <ChevronUp className="hidden h-4 w-4 max-md:block" aria-hidden="true" />
            </button>
            <MessageCircle
              className={cn("h-4 w-4 shrink-0 text-[rgba(0,0,0,0.35)]", isLoading && "animate-pulse text-[#007AFF]")}
              aria-hidden="true"
            />
            <span className="hidden text-[12px] font-medium text-[rgba(0,0,0,0.45)] max-md:inline">AI 助理</span>
          </div>
        )}
        <div className={inCanvasWorkstation ? cn("canvas-chat-scroll min-w-0 flex-1 space-y-3", chatPanelState === "expanded" && "canvas-chat-scroll-fill") : "min-w-0 space-y-3"}>
          {children(
            inCanvasWorkstation && chatPanelState === "expanded" ? (
              <button
                type="button"
                onClick={() => setChatPanelState("rail")}
                title="收起对话面板"
                aria-label="收起对话面板"
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[rgba(0,0,0,0.45)] transition-colors hover:bg-[rgba(0,0,0,0.06)] hover:text-[rgba(0,0,0,0.75)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
              >
                <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : undefined,
          )}
        </div>
        {/* 面板右緣拖寬手柄（320–560px） */}
        <div
          className={inCanvasWorkstation && chatPanelState === "expanded" ? "canvas-chat-resize" : "hidden"}
          onPointerDown={(e) => {
            chatPanelDragRef.current = { pointerId: e.pointerId, startX: e.clientX, startW: chatPanelWidth };
            e.currentTarget.setPointerCapture(e.pointerId);
            e.preventDefault();
          }}
          onPointerMove={(e) => {
            const d = chatPanelDragRef.current;
            if (!d || d.pointerId !== e.pointerId) return;
            setChatPanelWidth(Math.min(560, Math.max(320, d.startW + (e.clientX - d.startX))));
          }}
          onPointerUp={(e) => {
            if (chatPanelDragRef.current?.pointerId === e.pointerId) chatPanelDragRef.current = null;
          }}
          onPointerCancel={(e) => {
            if (chatPanelDragRef.current?.pointerId === e.pointerId) chatPanelDragRef.current = null;
          }}
          aria-hidden="true"
        />
      </div>
    </>
  );
}
