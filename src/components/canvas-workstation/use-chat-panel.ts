"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** 面板拖寬範圍（與 CSS 默認 clamp 同族，2026-09-24 用戶版面方案上限 560→720）。 */
export const CHAT_PANEL_MIN_WIDTH = 320;
export const CHAT_PANEL_MAX_WIDTH = 720;

/**
 * 寬度持久化 v2 key（2026-09-24 垃圾值大赦，暴君回報「Ctrl+Shift+R 聊天框先佔
 * 幾乎半屏、秒縮回 30% 以下，非常恐怖」）：只認「用戶真的拖過寬」寫入的值。
 * 舊 key（v1 時代）存的是垃圾——useState(420) 時代 mount effect 無條件落盤 420、
 * 40vw mount effect 落盤舊視口快照——視口變了或從未手動拖過時該值 ≠ CSS 默認，
 * 造成「首幀 clamp（40vw 半屏）→ 水合後被垃圾值縮回」的跳變。v1 一律不讀，
 * 載入即 removeItem 清除。layout.tsx 的 pre-paint 同步腳本與本檔讀同一個 v2、
 * 同一套校驗（320–720 整數；下限取拖寬底 320 而非 clamp 底 360——用戶真的拖到
 * 320 時若腳本拒認，首幀 clamp 水合後跳 320，同款跳變只是換了方向）。
 */
export const CHAT_PANEL_WIDTH_STORAGE_KEY = "canvas-chat-panel-width.v2";
/** 已作廢的 v1 key：只准 removeItem，禁止任何讀取。 */
export const CHAT_PANEL_WIDTH_LEGACY_KEY = "canvas-chat-panel-width";

/** v2 存值校驗：320–720 的整數才可信；其餘（null/空字串/浮點/越界）＝無存值。 */
export function parseStoredPanelWidth(raw: string | null): number | null {
  if (raw === null) return null;
  const w = Number(raw);
  if (!Number.isInteger(w) || w < CHAT_PANEL_MIN_WIDTH || w > CHAT_PANEL_MAX_WIDTH) return null;
  return w;
}

/**
 * 畫布工作站聊天面板的私有狀態：expanded|rail 兩態 + 右緣拖寬（320–720px），
 * localStorage 記憶。面板殼（樣式/overlay/拖寬手柄）在 CanvasChatWorkstation，
 * 這裡只持有 state 與持久化 effect——呼叫方是面板殼組件本身，對外零 props。
 *
 * 寬度單一真相源（2026-09-24 首秒零回縮 + 同日追殺回填跳變）：面板寬的唯一
 * 表示是 CSS 自訂屬性 --ws-panel-w——面板 width、overlay 的 --ce-dock-left、
 * navbar 的 --ws-navbar-inset 全部讀它。其值有兩源：
 *   - 無存值：CSS :root 默認 clamp(360px,40vw,720px)（宣告在 CanvasChatWorkstation
 *     的 <style>），SSR 首幀即新用戶終態——JS 什麼都不寫；
 *   - 有 v2 存值：由 <head>/body 頂端的 pre-paint 同步腳本（src/app/layout.tsx）
 *     在首個 paint 前把顯式 px 寫進 <html>——「首幀即終態」對冷載入（Ctrl+Shift+R）
 *     同樣成立。useLayoutEffect 對冷載入無能為力：HTML+CSS 早已繪出第一幀，
 *     水合再「paint 前」寫入也已是 paint 之後的第二次變更。本檔初始態經
 *     readStoredPanelWidth() 同步讀同一個 v2，mount 時 useLayoutEffect 重寫
 *     同一值＝零視覺變化；React markup 從不內聯 width，SSR 端不讀 window 也
 *     不產生 hydration mismatch。
 * 舊實裝「初始值 420 + mount effect 改寫視口 40%」與「useLayoutEffect 讀舊
 * localStorage 回填」兩代都是 reload 跳變元凶，已全部拆掉。
 *
 * rail 態讀取已大赦（2026-09-24 第二跳變源）：收合鈕 09-05 從 UI 裁掉後，
 * rail 對現行 UI 不可達，任何 state="rail" 持久值都是純舊垃圾；水合後載入它
 * 會讓面板從首幀 expanded 縮成 44px FAB（比寬度跳變更誇張），故一律不讀。
 * state 持久化寫入保留（恒為 expanded，向後相容舊讀取方）。
 */
export function useChatPanel() {
  const [chatPanelState, setChatPanelState] = useState<"expanded" | "rail">("expanded");
  // 初始態＝同步讀同一個校驗過的 v2（SSR 端 typeof window 守衛回 null）。
  // 這裡不能留 null 等 useLayoutEffect 回填：null 会让 mount 時的寫入 effect
  // removeProperty 掉 pre-paint 腳本剛設好的顯式寬——跳變只是換了方向。
  const [chatPanelWidth, setChatPanelWidth] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return parseStoredPanelWidth(window.localStorage.getItem(CHAT_PANEL_WIDTH_STORAGE_KEY));
    } catch {
      return null;
    }
  });
  const chatPanelDragRef = useRef<{ pointerId: number; startX: number; startW: number } | null>(null);
  // 面板殼 DOM：拖寬起始值要 getBoundingClientRect().width 實測——
  // chatPanelWidth 為 null 時寬度活在 CSS 側，JS 從來不知道它是幾。
  const chatPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    window.localStorage.setItem("canvas-chat-panel-state", chatPanelState);
  }, [chatPanelState]);
  // 持久化只收顯式寬度（用戶真的拖過），且只寫 v2；null = CSS 默認跟隨視口，
  // 禁止固化落盤（舊實裝連默認值都寫進 localStorage，把「40vw 跟視口」的活
  // 語義釘死成 px，且首個 commit 先落盤初始值——全部不再可能：state 為 null
  // 時根本不寫）。舊 key 垃圾值順手清除，永絕後患。
  useEffect(() => {
    try {
      window.localStorage.removeItem(CHAT_PANEL_WIDTH_LEGACY_KEY);
    } catch {
      /* 無存儲環境靜默 */
    }
    if (chatPanelWidth === null) return;
    try {
      window.localStorage.setItem(CHAT_PANEL_WIDTH_STORAGE_KEY, String(chatPanelWidth));
    } catch {
      /* 無存儲環境靜默 */
    }
  }, [chatPanelWidth]);
  // --ws-panel-w 唯一 JS 寫入端：有顯式值→寫 px；無→移除，讓 CSS :root 默認
  // （clamp）接管。useLayoutEffect = 首個 effect、paint 前完成；此刻 width
  // transition 的 settled 閘還未開啟，寫入＝瞬變終值零動畫。冷載入的首幀前
  // 套用由 layout.tsx pre-paint 腳本完成，本 effect 重寫同一值＝零跳。
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
