"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 畫布工作站聊天面板的私有狀態：expanded|rail 兩態 + 右緣拖寬（320–720px），
 * localStorage 記憶。面板殼（樣式/overlay/拖寬手柄）在 CanvasChatWorkstation，
 * 這裡只持有 state 與持久化 effect——呼叫方是面板殼組件本身，對外零 props。
 */
export function useChatPanel() {
  const [chatPanelState, setChatPanelState] = useState<"expanded" | "rail">("expanded");
  const [chatPanelWidth, setChatPanelWidth] = useState(420);
  const chatPanelDragRef = useRef<{ pointerId: number; startX: number; startW: number } | null>(null);

  // ─── 畫布工作站：面板記憶載入/持久化 ───
  useEffect(() => {
    const s = window.localStorage.getItem("canvas-chat-panel-state");
    // 2026-09-05 暴君裁定：手機端 agent 態 = 全螢幕聊天，沒有操作畫布的需求——
    // rail（FAB 收起態）只在桌面有意義，手機舊持久值一律忽略、保持 expanded。
    if (s === "rail" && !window.matchMedia("(max-width: 767px)").matches) {
      setChatPanelState("rail");
    }
    // 2026-09-24 用戶版面方案（左欄 40/60）：用戶存過寬度就尊重存值不動；
    // 無存值時掛載後設為視口寬 40%、clamp 360–720px（SSR/hydration：不在
    // useState 初始值讀 window，改在此 mount effect 決定）。
    const stored = window.localStorage.getItem("canvas-chat-panel-width");
    const w = Number(stored);
    if (stored !== null && Number.isFinite(w) && w >= 320 && w <= 720) {
      setChatPanelWidth(w);
    } else {
      setChatPanelWidth(Math.min(720, Math.max(360, Math.round(window.innerWidth * 0.4))));
    }
  }, []);
  useEffect(() => {
    window.localStorage.setItem("canvas-chat-panel-state", chatPanelState);
  }, [chatPanelState]);
  useEffect(() => {
    window.localStorage.setItem("canvas-chat-panel-width", String(chatPanelWidth));
  }, [chatPanelWidth]);

  return {
    chatPanelState,
    setChatPanelState,
    chatPanelWidth,
    setChatPanelWidth,
    chatPanelDragRef,
  };
}
