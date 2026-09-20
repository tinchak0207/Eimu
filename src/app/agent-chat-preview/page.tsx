import type { Metadata } from "next";
import { AgentChatPreviewClient } from "@/components/agent-chat-preview/AgentChatPreviewClient";

export const metadata: Metadata = {
  title: "AI 助理 · UI 预览",
  robots: { index: false, follow: false },
};

/**
 * 环境背景：真实产品里聊天面板浮在画布之上，玻璃要有东西可折射。
 * 页面底 = --background（hsl 210 23% 97%），上铺三团极淡的柔光色斑
 * （ios-blue / ios-teal / ios-indigo 的 radial 渐变 blob，fixed 不动）。
 * 是空气不是装饰——克制到「不留意就看不见」。
 */
export default function AgentChatPreviewPage() {
  return (
    <div className="relative flex min-h-dvh flex-col items-center overflow-hidden bg-background">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute -top-32 left-[8%] h-[30rem] w-[30rem] rounded-full bg-[radial-gradient(circle,rgba(0,122,255,0.13)_0%,transparent_70%)] blur-3xl" />
        <div className="absolute bottom-[-10%] right-[4%] h-[26rem] w-[26rem] rounded-full bg-[radial-gradient(circle,rgba(90,200,250,0.14)_0%,transparent_70%)] blur-3xl" />
        <div className="absolute left-[-6%] top-[38%] h-[22rem] w-[22rem] rounded-full bg-[radial-gradient(circle,rgba(88,86,214,0.09)_0%,transparent_70%)] blur-3xl" />
      </div>
      <p className="relative z-10 pb-1 pt-3 text-center text-ios-footnote text-muted-foreground">
        UI 预览 · 静态假数据 · 不连后端
      </p>
      <AgentChatPreviewClient />
    </div>
  );
}
