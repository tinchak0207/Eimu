"use client";

import { useEffect, useRef, useState } from "react";
import type { PromptInputMode } from "@/components/PromptInput";

/** D-24 状态A 一个 session 只提示一次的记号。 */
const AGENT_HINT_SEEN_KEY = "agent-hint-seen-v1";

/**
 * ── D-24 状态A：渐进披露第一层 ──
 * 打了第一个字之后停顿 >5 秒（= 卡住了，不是打字中），才在输入框下面浮一条
 * 「Agent 帮你完成」。一个 session 只出现一次，用过或关掉就不再烦。
 * 不能一进页面就弹：那是广告，不是帮忙。
 */
export function useAgentHint({
  displayMode,
  input,
  isLoading,
}: {
  displayMode: PromptInputMode;
  input: string;
  isLoading?: boolean;
}) {
  const [agentHintOpen, setAgentHintOpen] = useState(false);
  const [agentHintSpent, setAgentHintSpent] = useState(false);
  // 已送出（生成中/完成后看图）→ 抑制提示：提示只属于「还没送出、卡在输入」的时段。
  // input 内容一变（使用者重新写新任务）就解除，让新任务也能获得一次提示机会。
  const [agentHintSuppressed, setAgentHintSuppressed] = useState(false);
  const agentHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // 只跟 sessionStorage：换 tab 重来一次可以，同一 session 内不重复。
    try {
      if (sessionStorage.getItem(AGENT_HINT_SEEN_KEY) === "1") setAgentHintSpent(true);
    } catch {
      // 隐私模式下 sessionStorage 会抛，当成没看过即可
    }
  }, []);

  useEffect(() => {
    if (agentHintTimerRef.current) clearTimeout(agentHintTimerRef.current);
    // 只在生成模式、已经打了字、还没用掉、还没送出、且不正在生成的情况下计时。
    // isLoading = 生成请求已发出：任务在跑时不弹「AI 助理帮你完成」，避免打断等待。
    // agentHintSuppressed = 已送出：生成完成后看图/检查图片期间也不弹，直到重新输入新任务。
    if (agentHintSpent || agentHintSuppressed || displayMode !== "generate" || input.trim().length === 0 || isLoading) {
      setAgentHintOpen(false);
      return;
    }
    agentHintTimerRef.current = setTimeout(() => setAgentHintOpen(true), 5000);
    return () => {
      if (agentHintTimerRef.current) clearTimeout(agentHintTimerRef.current);
    };
  }, [input, displayMode, agentHintSpent, agentHintSuppressed, isLoading]);

  // 送出后 suppress 只被「输入内容变化」解除：改成新任务的字才重新计时。
  useEffect(() => {
    setAgentHintSuppressed(false);
  }, [input]);

  const spendAgentHint = () => {
    setAgentHintOpen(false);
    setAgentHintSpent(true);
    try {
      sessionStorage.setItem(AGENT_HINT_SEEN_KEY, "1");
    } catch {
      // 存不下就只在本次挂载内生效，不影响主流程
    }
  };

  /**
   * 送出即抑制 D-24 提示：generate / edit / upscale 三条送出路径闭包共享同一个
   * 下发（Task 3 抽 hook 时统一收敛到这里）。
   */
  const suppress = () => {
    setAgentHintOpen(false);
    setAgentHintSuppressed(true);
  };

  return { agentHintOpen, spendAgentHint, suppress };
}
