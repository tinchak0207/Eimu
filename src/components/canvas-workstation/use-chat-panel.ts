"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 畫布工作站聊天面板的私有狀態：expanded|rail 兩態 + 右緣拖寬（320–560px），
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
    if (s === "rail") {
      setChatPanelState("rail");
    } else if (!s && window.matchMedia("(max-width: 767px)").matches) {
      // 手機首次進工作站：抽屜預設收成 rail。展開態是 46dvh 的底部抽屜，
      // 一進場就蓋掉半屏畫布（節點卡只剩標題列可見）——要看畫布再收、要聊再開。
      setChatPanelState("rail");
    }
    const w = Number(window.localStorage.getItem("canvas-chat-panel-width"));
    if (Number.isFinite(w) && w >= 320 && w <= 560) setChatPanelWidth(w);
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
