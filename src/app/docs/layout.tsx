import type { Metadata } from "next";
import { DocsSidebar } from "./DocsSidebar";

export const metadata: Metadata = {
  title: "文档中心 | Eimu",
  description:
    "Eimu 使用指南：CDK 兑换、B 端 OpenAI 兼容 API 文档、MCP 接入教学。",
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