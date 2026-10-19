"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PromptInputMode } from "@/components/PromptInput";

/** 这两个面不需要卡片顶部那个描述框：放大没有描述，agent 自带输入区。 */
export const MODES_WITHOUT_TEXTAREA = new Set<PromptInputMode>(["upscale", "agent"]);

/**
 * ── 全模式共用外框高度（2026-08-22 项目负责人裁定：AI 助理 toggle 时大面板高度
 *    不可变，溢出不可接受）──
 * 不猜固定数字：在 generate/edit（textarea 可见）时实测内容区自然高度，
 * 锁定为所有模式的外框高度。generate 回到原本自然高（零溢出）；
 * agent/upscale 复制同一高度，内容由 flex-1 拉满、内部自滚——切换零跳动。
 * 内容多寡随模型变化（视频有 时长/音讯 行），所以进 generate/edit、换模型、
 * 窗口缩放都要重测。测量前先把旧锁定清掉，避免 offsetHeight 被自己撑住。
 *
 * 测量根必须仍是包含所有模式面的同一个 section DOM 节点：contentRef 由
 * 本 hook 回传，PromptInput 把它绑在卡片根 section 上——模式面抽成子组件
 * 也不能改变这个测量根。
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
    // 先解除锁定再量：否则固定的 height 会让 offsetHeight 恒等于上次值。
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
