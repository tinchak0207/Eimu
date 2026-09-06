"use client";

import { type CSSProperties, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { MessageCircle } from "lucide-react";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import { cn } from "@/lib/utils";
import { useChatPanel } from "./use-chat-panel";

// CanvasEmbed 維持 dynamic 懶載入：它是畫布工作站的天然 chunk 邊界，
// 只有 inCanvasWorkstation 為真（overlay 真的渲染）時才拉 chunk。
const CanvasEmbed = dynamic(() => import("@/components/canvas/CanvasEmbed").then((m) => m.CanvasEmbed), { ssr: false });

export interface CanvasChatWorkstationProps {
  /** ImagePlayground 的派生值：displayMode === "agent"。 */
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
            .canvas-ws-backdrop {
              position: fixed;
              inset: 0;
              z-index: 40;
              background: #F2F2F7;
              animation: canvas-ws-fade 0.32s ease-out;
            }
            .canvas-ws-overlay {
              position: fixed;
              top: 0;
              bottom: 0;
              right: 0;
              z-index: 50;
              height: 100dvh;
              background: transparent;
              display: flex;
              align-items: center;
              justify-content: center;
              overflow: hidden;
              transition: left 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
            }
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
              /* 面板為實心卡片（純白 100% 不透底），徹底阻斷背景透光 */
              background: #ffffff !important;
              border: 1px solid rgba(0, 0, 0, 0.08);
              border-radius: 28px;
              box-shadow: 0 20px 48px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04);
              overflow: hidden;
              transition: width 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
              animation: canvas-ws-panel-in 0.36s cubic-bezier(0.2, 0.8, 0.2, 1);
              /* header 彈窗（歷史/資產/設定）水平置中用的頂部偏移。 */
              --agent-pop-top: calc(0.75rem + env(safe-area-inset-top, 0px) + 3.25rem);
            }
            .canvas-chat-rail {
              /* 收起態 = 聊天气泡 FAB（2026-08-25 暴君裁定；2026-08-27 尺寸鎖死修復：
                 面板基礎規則的 top/bottom/right 拉伸定位 + width/height:auto 會讓
                 FAB 在移動端撐滿整屏成一個大白橢圓，完全不可用——四邊與尺寸全部顯式固定）。 */
              top: calc(0.75rem + env(safe-area-inset-top, 0px));
              bottom: auto !important;
              right: auto !important;
              left: 0.75rem;
              width: 44px !important;
              height: 44px !important;
              min-width: 0 !important;
              max-width: none !important;
              background: #ffffff !important;
              border: 1px solid rgba(0, 0, 0, 0.08);
              border-radius: 999px;
              box-shadow: 0 8px 32px rgba(0, 0, 0, 0.10);
              overflow: hidden;
              animation: canvas-ws-fab-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both;
            }
            @keyframes canvas-ws-fab-in {
              from { opacity: 0; transform: scale(0.6); }
              to { opacity: 1; transform: scale(1); }
            }
            .canvas-chat-rail .canvas-chat-scroll { display: none; }
            .canvas-chat-scroll {
              flex: 1;
              min-height: 0;
              overflow-y: auto;
              padding: 0;
              overscroll-behavior: contain;
              background: #ffffff !important;
            }
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
              min-height: 0;
              overflow: hidden;
              background: #ffffff !important;
              box-shadow: none !important;
              border: none !important;
            }
            .canvas-chat-scroll-fill section {
              background: #ffffff !important;
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
              /* 2026-09-05 暴君裁定：手機端 agent 態 = 全螢幕聊天，
                 手機用戶沒有操作畫布的需求——畫布 overlay/模板庫直接不渲染。 */
              .canvas-ws-overlay { display: none; }
              .canvas-ws-backdrop { display: none; }
              .canvas-chat-panel {
                left: 0;
                right: 0;
                top: 0;
                bottom: 0;
                height: auto;
                width: auto !important;
                max-width: none;
                max-height: none;
                border-radius: 0;
                border: none;
                box-shadow: none;
                padding-top: env(safe-area-inset-top, 0px);
                padding-bottom: env(safe-area-inset-bottom, 0px);
                --agent-pop-top: calc(env(safe-area-inset-top, 0px) + 3.25rem);
              }
              /* FAB 態手機位置：靠左上角（導航欄下方）；還原圓形膠囊外觀
                 （全螢幕面板規則把圓角/邊框/陰影拍平了，rail 要蓋回來）。 */
              .canvas-chat-rail {
                top: calc(5rem + env(safe-area-inset-top, 0px));
                left: 0.5rem;
                border-radius: 999px;
                border: 1px solid rgba(0, 0, 0, 0.08);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.10);
                padding: 0;
              }
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
        <>
          <div className="canvas-ws-backdrop" aria-hidden="true" />
          <div
            className="canvas-ws-overlay"
            style={
              {
                "--ce-dock-left": `${chatPanelState === "expanded" ? chatPanelWidth + 12 : 64}px`,
                left: "calc(0.75rem + var(--ce-dock-left, 0px))",
              } as CSSProperties
            }
          >
            {overlayContent ?? <CanvasEmbed canvas={canvasHost} expanded />}
          </div>
        </>
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
        {/* FAB 態（2026-08-25 暴君裁定：收起形態 = 左上角聊天气泡，不是長條 rail）：
            一顆 44px 圓形聊天气泡按鈕，圖標即語義（MessageCircle=打開對話）。
            載入中藍色 pulse 提示「助理在跑」。expanded 態不渲染：收合按鈕
            併入聊天 header（chatHeaderExtra），觸發前後同一個 UI。 */}
        {inCanvasWorkstation && chatPanelState === "rail" && (
          <button
            type="button"
            onClick={() => setChatPanelState("expanded")}
            title="展开对话面板"
            aria-label="展开对话面板"
            className={cn(
              "flex h-11 w-11 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full",
              "bg-[rgba(0,122,255,0.10)] text-[#007AFF] transition-all duration-200",
              "hover:bg-[rgba(0,122,255,0.16)] active:scale-[0.94]",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]",
              "[-webkit-tap-highlight-color:transparent]",
              isLoading && "animate-pulse",
            )}
          >
            <MessageCircle className="h-5 w-5" aria-hidden="true" />
          </button>
        )}
        <div className={inCanvasWorkstation ? cn("canvas-chat-scroll min-w-0 flex-1 space-y-3", chatPanelState === "expanded" && "canvas-chat-scroll-fill") : "min-w-0 space-y-3"}>
          {/* 2026-09-05 暴君裁定：header 的「收起對話面板」鈕刪掉，退出只走右邊 X；
              chatHeaderExtra 不再產出（render prop 簽名保留，傳 undefined）。 */}
          {children(undefined)}
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
