import type { Metadata } from "next";
import { DocsSidebar } from "./DocsSidebar";

export const metadata: Metadata = {
  title: "AI 助理快速上手 | 文档中心 | Eimu",
  description:
    "面向 AI 助理聊天用户的单一教学文档：怎么开始对话、一轮会发生什么、助理设定与野兽模式、计费放心、把助理带走（MCP 接入），并附开发者 API 参考。",
  openGraph: {
    title: "AI 助理快速上手 | 文档中心 | Eimu",
    description:
      "面向 AI 助理聊天用户的单一教学文档：怎么开始对话、一轮会发生什么、助理设定与野兽模式、计费放心、把助理带走（MCP 接入），并附开发者 API 参考。",
    url: "https://eimu.dev/docs",
  },
  twitter: {
    card: "summary_large_image",
    title: "AI 助理快速上手 | 文档中心 | Eimu",
    description:
      "面向 AI 助理聊天用户的单一教学文档：怎么开始对话、一轮会发生什么、助理设定与野兽模式、计费放心、把助理带走（MCP 接入），并附开发者 API 参考。",
  },
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="page-shell relative pt-24 pb-20">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-10">
        <DocsSidebar />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}