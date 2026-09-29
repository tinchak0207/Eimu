"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { MessageCircle } from "lucide-react";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import { cn } from "@/lib/utils";
import { CHAT_PANEL_MAX_WIDTH, CHAT_PANEL_MIN_WIDTH, useChatPanel } from "./use-chat-panel";

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
  const { chatPanelState, setChatPanelState, chatPanelWidth, setChatPanelWidth, chatPanelDragRef, chatPanelRef } = useChatPanel();

  // 2026-09-24 暴君裁定「header 往右退縮，讓 AI 助理占上來，吃滿天花板」＋
  // 同刀「首秒零回縮」根治：expanded 態的退縮量不再由 JS 回寫像素——
  // Navbar 的 --ws-navbar-inset fallback 已直接消費 calc(var(--ws-panel-w)+12px)
  // （單一真相源，拖寬即時跟隨、SSR 首幀即退縮終態）。本 effect 只負責
  // 「不該退縮的態顯式寫 0px」：rail 態 / 手機（<768px 全屏抽屜）/ pro 面。
  // useLayoutEffect 在首幀 paint 前寫入，且此刻 transition 閘（data-ws-settled）
  // 未開＝瞬變零動畫；舊 useEffect+像素值寫法正是「navbar 從全寬 320ms
  // 動畫退縮」回縮病灶的元凶，作廢。
  useLayoutEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const apply = () => {
      const shrink = inCanvasWorkstation && chatPanelState === "expanded" && mq.matches;
      if (shrink) {
        document.documentElement.style.removeProperty("--ws-navbar-inset");
      } else {
        document.documentElement.style.setProperty("--ws-navbar-inset", "0px");
      }
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
      document.documentElement.style.setProperty("--ws-navbar-inset", "0px");
    };
  }, [inCanvasWorkstation, chatPanelState]);

  // ─── settled 閘（2026-09-24 首秒零回縮）───
  // 掛載並讓首幀（含 useLayoutEffect 的值寫入）完成繪製後（雙 rAF）才開啟
  // 過度動畫：首次載入零動畫直出終態；之後 rail↔expanded 切換、拖寬、
  // pro↔agent 翻面照樣有過度。CSS 側所有 width/left transition 與入場
  // @keyframes 都只掛在 .canvas-ws-settled / html[data-ws-settled] 下。
  const [wsSettled, setWsSettled] = useState(false);
  // settled 開啟當下面板是否已是 rail（localStorage 舊持久值載入）——那是
  // 首幀終態不是用戶動作，fab-in 入場動畫不得補播（現行 UI 已無收合出口，
  // rail 僅可能來自舊持久值，此幀純防回魂）。
  const chatPanelStateRef = useRef(chatPanelState);
  chatPanelStateRef.current = chatPanelState;
  const railAtSettleRef = useRef(false);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        railAtSettleRef.current = chatPanelStateRef.current === "rail";
        setWsSettled(true);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);
  // html[data-ws-settled]：Navbar 退縮 transition 的唯一閘（規則在本組件
  // style 塊）。pro 態與 unmount 移除——非首頁根本沒有這層，header 恆全寬。
  useEffect(() => {
    if (wsSettled && inCanvasWorkstation) {
      document.documentElement.dataset.wsSettled = "1";
    } else {
      delete document.documentElement.dataset.wsSettled;
    }
    return () => {
      delete document.documentElement.dataset.wsSettled;
    };
  }, [wsSettled, inCanvasWorkstation]);

  return (
    <>
      {/* 畫布工作站樣式：面板 fixed 浮於畫布上、兩態寬度過渡、行動端改底部抽屜。
          2026-09-20 拆覆蓋層（暴君批准的 agent-chat-preview 視覺）：面板殼不再
          壓純白實底——殼退為形狀宿主（圓角＋陰影），讓內層 PromptInput 的
          section.lg-card 自己的玻璃材質（0.72 白玻璃＋blur＋頂緣 specular 亮線）
          透出來，畫布在背後可折射。08-25「白殼唯一卡」裁定由 09-20 預覽裁定取代。 */}
      <style>{`
            /* ─── 面板寬度單一真相源（2026-09-24 首秒零回縮）───
               純 CSS 默認＝SSR 首幀即新用戶終態（無任何 JS 追寫）；JS 只在
               localStorage 有存值或拖寬進行中把 --ws-panel-w 覆寫成顯式 px
               （寫入端在 use-chat-panel 的 useLayoutEffect，<html> 內聯樣式
               壓過本 :root 規則）。消費端：.canvas-chat-panel 的 width、
               overlay 的 --ce-dock-left、Navbar 的 --ws-navbar-inset fallback。 */
            :root {
              --ws-panel-w: clamp(360px, 40vw, 720px);
            }
            @keyframes canvas-ws-fade {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            @keyframes canvas-ws-panel-in {
              /* 未接線（2026-09-24 首秒零回縮考古）：全站無任何規則引用本
                 keyframes，入場動畫實際只有 canvas-ws-fade 與 canvas-ws-fab-in，
                 兩者已全部收進 settled 閘。保留宣告僅作歷史記錄，不會播放。 */
              from { opacity: 0; transform: translateX(-18px) scale(0.985); }
              to { opacity: 1; transform: none; }
            }
            .canvas-ws-backdrop {
              position: fixed;
              /* 站點 header 留在上面。助理是進站預設面，這層從視口頂蓋下來時
                 充值／帳號入口就沒了。高度由 #global-navbar 寫進 --site-header-offset。 */
              top: var(--site-header-offset, 4.25rem);
              right: 0;
              bottom: 0;
              left: 0;
              z-index: 40;
              /* 環境光漸層與 body::after 同一配方（Trans 藍/粉光暈＋160deg 底色）。
                 此層的職責是遮蓋首頁文檔流內容；舊版 #F2F2F7 實底把首頁的彩色
                 環境光一併抹平（暴君裁定 09-20：進助理应看見同款漸層），
                 改鋪同款漸層後遮蓋不變、底色不再消失。 */
              background:
                radial-gradient(ellipse 130% 90% at 15% 5%,
                  rgba(85, 205, 252, 0.10) 0%,
                  transparent 60%
                ),
                radial-gradient(ellipse 110% 75% at 85% 95%,
                  rgba(247, 168, 184, 0.10) 0%,
                  transparent 60%
                ),
                radial-gradient(ellipse 90% 65% at 80% 10%,
                  rgba(85, 205, 252, 0.07) 0%,
                  transparent 55%
                ),
                linear-gradient(160deg,
                  #f5fbff 0%,
                  #fef5f7 50%,
                  #f5fbff 100%
                );
            }
            /* 入場漸顯只在 settled 後生效（2026-09-24 首秒零回縮）：首次載入
               backdrop 直出終態（其漸層與 body::after 逐字同配方，延遲觸發亦
               不可見）；pro→agent 翻面時本元素是新掛載的，class 在場即照常漸顯。 */
            .canvas-ws-backdrop.canvas-ws-settled {
              animation: canvas-ws-fade 0.32s ease-out;
            }
            .canvas-ws-overlay {
              position: fixed;
              top: var(--site-header-offset, 4.25rem);
              bottom: 0;
              right: var(--site-shell-right, 0px);
              z-index: 50;
              height: auto;
              background: transparent;
              display: flex;
              align-items: center;
              justify-content: center;
              overflow: hidden;
            }
            /* dock 偏移的過度只在 settled 後開啟：拖寬/rail 切換跟手，
               載入首幀（left 已是終值）零動畫。 */
            .canvas-ws-overlay.canvas-ws-settled {
              transition: left 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
            }
            /* Navbar 退縮過度（2026-09-24 首秒零回縮）：原先掛在 <nav> 的
               tailwind 類別上＝每次載入都播「全寬 320ms 退縮」回縮動畫（病灶①），
               移進本檔並只在 html[data-ws-settled]（工作站 settled 後寫）下生效。
               非首頁無本 style 塊＝header 在任何態都零過度，天然正確。 */
            html[data-ws-settled] #global-navbar nav {
              transition: margin-left 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
                width 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
            }
            .canvas-chat-panel {
              position: fixed;
              z-index: 60;
              /* 2026-09-24 暴君裁定：面板吃滿天花板——頂部只留 0.75rem 呼吸位，
                 不再從導覽列下緣起算； navbar 改由 --ws-navbar-inset 右退讓位
                 （見組件頂部 useEffect 與 Navbar.tsx）。bottom 與 max-height
                 上下對稱留 0.75rem，max-height 是 bottom 定界外的雙保險。 */
              top: 0.75rem;
              bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
              left: var(--site-shell-left, 0.75rem);
              /* 寬度讀單一真相源：:root 默認 clamp 或 JS（use-chat-panel）在
                 有存值/拖寬時覆寫的顯式 px。首幀即終態，無 inline style、
                 無 hydration 追寫。 */
              width: var(--ws-panel-w);
              display: flex;
              flex-direction: column;
              min-height: 0;
              max-height: calc(100dvh - 1.5rem - env(safe-area-inset-bottom, 0px));
              max-width: calc(100vw - 1.5rem);
              /* 殼退為形狀宿主：底色/邊框交給內層 section.lg-card 的玻璃材質
                 （0.72 白玻璃＋blur＋specular 亮線），畫布在背後可折射。 */
              background: transparent;
              border-radius: 30px;
              overflow: hidden;
              /* header 彈窗（歷史/資產/設定）水平置中用的頂部偏移。
                 2026-09-24 收斂：這些彈層是 fixed 於視口水平置中（left-1/2），
                 navbar 右退後膠囊仍橫跨視口中段（z-80 壓 z-50 彈層），所以頂部
                 仍須落在導覽列下緣＋0.75rem——但不再用 3.25rem 魔法數，改吃
                 Navbar 實測的 --site-header-offset，與面板吃頂後的新基準一致。 */
              --agent-pop-top: calc(env(safe-area-inset-top, 0px) + var(--site-header-offset, 4.25rem) + 0.75rem);
            }
            /* 面板寬度過度只在 settled 後開啟（首秒零回縮）：載入首幀寬度已是
               終值零動畫；rail↔expanded 切換與拖寬（含 navbar/overlay 同拍）
               在閘開後照常過度。 */
            .canvas-chat-panel.canvas-ws-settled {
              transition: width 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
            }
            .canvas-chat-rail {
              /* 收起態 = 聊天气泡 FAB（2026-08-25 暴君裁定；2026-08-27 尺寸鎖死修復：
                 面板基礎規則的 top/bottom/right 拉伸定位 + width/height:auto 會讓
                 FAB 在移動端撐滿整屏成一個大白橢圓，完全不可用——四邊與尺寸全部顯式固定）。 */
              top: calc(var(--site-header-offset, 4.25rem) + 0.75rem);
              bottom: auto !important;
              right: auto !important;
              left: var(--site-shell-left, 0.75rem);
              width: 44px !important;
              height: 44px !important;
              min-width: 0 !important;
              max-width: none !important;
              overflow: hidden;
              /* FAB 態殼自身給玻璃外觀（此態無 lg-card 內層可依賴）。 */
              background: rgba(255, 255, 255, 0.72);
              border: 1px solid rgba(0, 0, 0, 0.08);
              border-radius: 999px;
              box-shadow: 0 8px 32px rgba(0, 0, 0, 0.10);
              backdrop-filter: blur(40px) saturate(180%);
              -webkit-backdrop-filter: blur(40px) saturate(180%);
            }
            /* FAB 入場彈現（首秒零回縮閘）：只在 settled 後、且不是「舊持久值
               rail 直接首幀載入」時播——用戶動作收合是過度，載入直出是終態。
               canvas-ws-was-rail 由工作站於 settled 當幀偵測（見 tsx）。 */
            .canvas-chat-rail.canvas-ws-settled:not(.canvas-ws-was-rail) {
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
              background: transparent;
            }
            /* 面板態聊天區：scroll 容器變縱向 flex、不再自己滾，滾動收進
               transcript 內部（agent 面的固定高在 46dvh 抽屜裡會溢出被裁）。
               2026-09-24 暴君終裁：聊天態與空態一律吃滿全高，空態內容置中由
               transcript 內部 justify-center 負責（舊 :has() 分流作廢）。
               justify-content: center 保留：滿高時無感，置中卡靠它。 */
            .canvas-chat-scroll.canvas-chat-scroll-fill {
              display: flex;
              flex-direction: column;
              justify-content: center;
              overflow: hidden;
              overflow-y: hidden;
              padding: 0;
            }
            .canvas-chat-scroll-fill > * { min-height: 0; }
            .canvas-chat-scroll-fill > section.lg-card {
              flex: 1 1 0%;
              min-height: 0;
              overflow: hidden;
              margin: 0;
              border-radius: 30px;
              /* 2026-09-24 用戶版面方案（卡片減法陰影）：壓掉全域 lg-card 的
                 重陰影與四邊漸變邊框——「深陰影會讓它顯得過時，邊框撐浮感就夠」；
                 只覆寫 box-shadow/border，lg-card 的玻璃材質（backdrop-filter）
                 原樣保留。 */
              box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
              border: 1px solid oklch(0% 0 0 / 6%);
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
              /* 選擇器權重要蓋得過 settled 閘規則（.x.canvas-ws-settled = 0,2,0）。 */
              .canvas-ws-overlay,
              .canvas-ws-overlay.canvas-ws-settled { animation: none; transition: none; }
              .canvas-ws-backdrop,
              .canvas-ws-backdrop.canvas-ws-settled { animation: none; }
              .canvas-chat-panel,
              .canvas-chat-panel.canvas-ws-settled { transition: none; }
              .canvas-chat-rail,
              .canvas-chat-rail.canvas-ws-settled:not(.canvas-ws-was-rail) { animation: none; }
              html[data-ws-settled] #global-navbar nav { transition: none; }
            }
            @media (max-width: 767px) {
              /* 2026-09-05 暴君裁定：手機端 agent 態 = 全螢幕聊天，
                 手機用戶沒有操作畫布的需求——畫布 overlay/模板庫直接不渲染。 */
              .canvas-ws-overlay { display: none; }
              .canvas-ws-backdrop { display: none; }
              .canvas-chat-panel {
                left: 0;
                right: 0;
                top: var(--site-header-offset, 4.25rem);
                bottom: 0;
                height: auto;
                width: auto !important;
                max-width: none;
                max-height: none;
                border-radius: 0;
                background: transparent;
                padding-top: env(safe-area-inset-top, 0px);
                padding-bottom: env(safe-area-inset-bottom, 0px);
                --agent-pop-top: calc(env(safe-area-inset-top, 0px) + 3.25rem);
              }
              /* FAB 態手機位置：靠左上角（導航欄下方）。 */
              .canvas-chat-rail {
                top: calc(var(--site-header-offset, 4.25rem) + 0.75rem);
                left: 0.5rem;
                border-radius: 0;
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
          <div className={cn("canvas-ws-backdrop", wsSettled && "canvas-ws-settled")} aria-hidden="true" />
          <div
            className={cn("canvas-ws-overlay", wsSettled && "canvas-ws-settled")}
            style={
              {
                /* dock 偏移讀單一真相源：expanded = 面板寬+12px 間隙（CSS 變數
                   即時跟隨拖寬，JS 不經回寫）；rail 態 = 64px（FAB 44＋間隙）
                   保持既有分支。字符串常量化＝SSR 首幀即終態、零 hydration 跳動。 */
                "--ce-dock-left": chatPanelState === "rail" ? "64px" : "calc(var(--ws-panel-w) + 12px)",
                left: "calc(var(--site-shell-left, 0.75rem) + var(--ce-dock-left, 0px))",
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
        ref={chatPanelRef}
        className={cn(
          inCanvasWorkstation ? "canvas-chat-panel" : "min-w-0",
          // settled 閘：width 過度與入場動畫只在首幀穩定後開啟（見 style 塊）。
          inCanvasWorkstation && wsSettled && "canvas-ws-settled",
          inCanvasWorkstation && chatPanelState === "rail" && "canvas-chat-rail",
          // 舊持久值 rail＝首幀終態，不補播 fab-in（settled 當幀偵測，見上）。
          inCanvasWorkstation &&
            wsSettled &&
            chatPanelState === "rail" &&
            railAtSettleRef.current &&
            "canvas-ws-was-rail",
        )}
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
        {/* 面板右緣拖寬手柄（320–720px，2026-09-24 用戶版面方案放寬上限） */}
        <div
          className={inCanvasWorkstation && chatPanelState === "expanded" ? "canvas-chat-resize" : "hidden"}
          onPointerDown={(e) => {
            // 拖寬起始值：無顯式寬（null，CSS clamp 默認在場）時實測渲染寬——
            // JS 不再假設 420 這類魔法數。
            const startW = chatPanelWidth ?? chatPanelRef.current?.getBoundingClientRect().width ?? CHAT_PANEL_MIN_WIDTH;
            chatPanelDragRef.current = { pointerId: e.pointerId, startX: e.clientX, startW };
            e.currentTarget.setPointerCapture(e.pointerId);
            e.preventDefault();
          }}
          onPointerMove={(e) => {
            const d = chatPanelDragRef.current;
            if (!d || d.pointerId !== e.pointerId) return;
            setChatPanelWidth(Math.min(CHAT_PANEL_MAX_WIDTH, Math.max(CHAT_PANEL_MIN_WIDTH, d.startW + (e.clientX - d.startX))));
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
