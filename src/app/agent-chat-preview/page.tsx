import type { Metadata } from "next";
import { AgentChatPreviewClient } from "@/components/agent-chat-preview/AgentChatPreviewClient";

export const metadata: Metadata = {
  title: "AI 助理 · UI 预览",
  robots: { index: false, follow: false },
};

/**
 * 环境背景：不自铺色斑，直接透出首页 body::after 的环境光（蓝/粉，globals.css 唯一配方）。
 * 原本这里自带 ios-teal 色斑——青色在设计系统里禁用，且与首页不同步＝劣化
 * （09-20 裁定：助理背景必须与首页环境光逐字同步）。外层不能有实底，否则盖掉 body::after。
 */
export default function AgentChatPreviewPage() {
  return (
    <div className="relative flex min-h-dvh flex-col items-center overflow-hidden">
      <p className="relative z-10 pb-1 pt-3 text-center text-ios-footnote text-muted-foreground">
        UI 预览 · 静态假数据 · 不连后端
      </p>
      <AgentChatPreviewClient />
    </div>
  );
}
