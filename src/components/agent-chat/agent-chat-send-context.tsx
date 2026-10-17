"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * 会话发送通道的轻量上下文（2026-10-17）。
 *
 * 用途：消息气泡里由模型渲染出来的交互组件（OpenUI 的 @ToAssistant 按钮）
 * 需要把一句话送回对话——不经由输入框，也不新造发送路径。这里把面板既有的
 * `onSend` 直接下发给气泡，避免 transcript → bubble → markdown → block 多层
 * prop drilling。
 *
 * 缺省 undefined：不在 Provider 内（或面板没接线）时，调用方应禁用发送按钮，
 * 而不是自行 fetch 网关。
 */
export type AgentChatSend = (text: string) => void | Promise<void>;

const AgentChatSendContext = createContext<AgentChatSend | undefined>(undefined);

export function AgentChatSendProvider({
  value,
  children,
}: {
  /** 面板既有的 onSend（与输入框走同一条通道，不另包一层发送逻辑）。 */
  value: AgentChatSend;
  children: ReactNode;
}) {
  return <AgentChatSendContext.Provider value={value}>{children}</AgentChatSendContext.Provider>;
}

/** 取当前会话的发送通道；未接线时为 undefined。 */
export function useAgentChatSend(): AgentChatSend | undefined {
  return useContext(AgentChatSendContext);
}
