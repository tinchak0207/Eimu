"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** 面板拖寬範圍（與 CSS 默認 clamp 同族，2026-09-24 用戶版面方案上限 560→720）。 */
export const CHAT_PANEL_MIN_WIDTH = 320;
export const CHAT_PANEL_MAX_WIDTH = 720;

/**
 * 畫布工作站聊天面板的私有狀態：expanded|rail 兩態 + 右緣拖寬（320–720px），
 * localStorage 記憶。面板殼（樣式/overlay/拖寬手柄）在 CanvasChatWorkstation，
 * 這裡只持有 state 與持久化 effect——呼叫方是面板殼組件本身，對外零 props。
 *
 * 寬度單一真相源（2026-09-24 首秒零回縮，暴君裁定「reload 一堆明顯回縮破壞
 * 首秒體驗」）：面板寬的唯一表示是 CSS 自訂屬性 --ws-panel-w——面板 width、
 * overlay 的 --ce-dock-left、navbar 的 --ws-navbar-inset 全部讀它。其值有兩源：
 *   - null（默認，無存值）：CSS :root 默認 clamp(360px,40vw,720px)（宣告在
 *     CanvasChatWorkstation 的 <style>），SSR 首幀即新用戶終態——JS 什麼都不寫；
 *   - 非 null（用戶存值/拖寬中）：useLayoutEffect 把顯式 px 寫進 <html>，
 *     首幀繪製前完成，同樣零過度。
 * 舊實裝「初始值 420 + mount effect 改寫視口 40%」正是 reload 時 420→40vw
 * 伸展回縮的元凶，已刪——默認寬度交給純 CSS，JS 不再發明預設值。
 */
export function useChatPanel() {
  const [chatPanelState, setChatPanelState] = useState<"expanded" | "rail">("expanded");
  // null = 無顯式寬度，由 CSS 默認（clamp）決定——SSR 安全：初始值零 window 讀取。
  const [chatPanelWidth, setChatPanelWidth] = useState<number | null>(null);
  const chatPanelDragRef = useRef<{ pointerId: number; startX: number; startW: number } | null>(null);
  // 面板殼 DOM：拖寬起始值要 getBoundingClientRect().width 實測——
  // chatPanelWidth 為 null 時寬度活在 CSS 側，JS 從來不知道它是幾。
  const chatPanelRef = useRef<HTMLDivElement | null>(null);

  // ─── 面板記憶載入：useLayoutEffect（2026-09-24 由 useEffect 提前）───
  // 首幀繪製前跑完：存值直接成為首幀終態，不再看見「默認寬→存值寬」的跳變。
  useLayoutEffect(() => {
    const s = window.localStorage.getItem("canvas-chat-panel-state");
    // 2026-09-05 暴君裁定：手機端 agent 態 = 全螢幕聊天，沒有操作畫布的需求——
    // rail（FAB 收起態）只在桌面有意義，手機舊持久值一律忽略、保持 expanded。
    if (s === "rail" && !window.matchMedia("(max-width: 767px)").matches) {
      setChatPanelState("rail");
    }
    // 用戶存過寬度就尊重存值；無存值 = 維持 CSS 默認，不落顯式值。
    const w = Number(window.localStorage.getItem("canvas-chat-panel-width"));
    if (Number.isFinite(w) && w >= CHAT_PANEL_MIN_WIDTH && w <= CHAT_PANEL_MAX_WIDTH) {
      setChatPanelWidth(w);
    }
  }, []);
  useEffect(() => {
    window.localStorage.setItem("canvas-chat-panel-state", chatPanelState);
  }, [chatPanelState]);
  // 持久化只收顯式寬度（用戶真的拖過）。null = CSS 默認跟隨視口，禁止固化落盤
  // （舊實裝連默認值都寫進 localStorage，把「40vw 跟視口」的活語義釘死成 px，
  // 且首個 commit 先落盤初始值——全部不再可能：state 為 null 時根本不寫）。
  useEffect(() => {
    if (chatPanelWidth === null) return;
    window.localStorage.setItem("canvas-chat-panel-width", String(chatPanelWidth));
  }, [chatPanelWidth]);
  // --ws-panel-w 唯一 JS 寫入端：有顯式值→寫 px；無→移除，讓 CSS :root 默認
  // （clamp）接管。useLayoutEffect = 首個 effect、paint 前完成；此時 width
  // transition 的 settled 閘還未開啟，寫入＝瞬變終值零動畫。
  useLayoutEffect(() => {
    if (chatPanelWidth === null) {
      document.documentElement.style.removeProperty("--ws-panel-w");
    } else {
      document.documentElement.style.setProperty("--ws-panel-w", `${chatPanelWidth}px`);
    }
  }, [chatPanelWidth]);

  return {
    chatPanelState,
    setChatPanelState,
    chatPanelWidth,
    setChatPanelWidth,
    chatPanelDragRef,
    chatPanelRef,
  };
}
