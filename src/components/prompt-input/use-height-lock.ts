"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PromptInputMode } from "@/components/PromptInput";

/** 这两个面不需要卡片顶部那个描述框：放大没有描述，agent 自带输入区。 */
export const MODES_WITHOUT_TEXTAREA = new Set<PromptInputMode>(["upscale", "agent"]);

/**
 * ── 全模式共用外框高度（2026-08-22 暴君裁定：AI 助理 toggle 時大面板高度
 *    不可變，溢出不可接受）──
 * 不猜固定數字：在 generate/edit（textarea 可見）時實測內容區自然高度，
 * 鎖定為所有模式的外框高度。generate 回到原本自然高（零溢出）；
 * agent/upscale 複製同一高度，內容由 flex-1 拉滿、內部自滾——切換零跳動。
 * 內容多寡隨模型變化（視頻有 時長/音訊 行），所以進 generate/edit、換模型、
 * 窗口縮放都要重測。測量前先把舊鎖定清掉，避免 offsetHeight 被自己撐住。
 *
 * 測量根必須仍是包含所有模式面的同一個 section DOM 節點：contentRef 由
 * 本 hook 回傳，PromptInput 把它綁在卡片根 section 上——模式面抽成子組件
 * 也不能改變這個測量根。
 */
export function useHeightLock({
  displayMode,
  modelId,
  fillAvailableHeight,
}: {
  displayMode: PromptInputMode;
  modelId: string;
  fillAvailableHeight: boolean;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const measureContentHeight = useCallback(() => {
    if (fillAvailableHeight) return;
    const el = contentRef.current;
    if (!el) return;
    const textareaVisible = !MODES_WITHOUT_TEXTAREA.has(displayMode);
    if (!textareaVisible) return;
    // 先解除鎖定再量：否則固定的 height 會讓 offsetHeight 恆等於上次值。
    setContentHeight(null);
    requestAnimationFrame(() => {
      const el2 = contentRef.current;
      if (el2 && el2.offsetHeight > 0) setContentHeight(el2.offsetHeight);
    });
  }, [displayMode, fillAvailableHeight]);
  useEffect(() => {
    measureContentHeight();
  }, [measureContentHeight, modelId, displayMode]);
  useEffect(() => {
    if (fillAvailableHeight) return;
    window.addEventListener("resize", measureContentHeight);
    return () => window.removeEventListener("resize", measureContentHeight);
  }, [measureContentHeight, fillAvailableHeight]);

  return { contentRef, contentHeight };
}
