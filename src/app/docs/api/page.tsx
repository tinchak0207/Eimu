import type { Metadata } from "next";
import { DevAppendix } from "./DevAppendix";

export const metadata: Metadata = {
  title: "开发进阶（B 端 API） | 文档中心 | Eimu",
};

export default function DocsApiPage() {
  return (
    <div className="flex flex-col gap-6">
      <a
        href="/docs"
        className="text-ios-footnote text-[rgba(0,0,0,0.48)] lg-transition hover:text-[#007AFF]"
      >
        ← 文档中心
      </a>
      <DevAppendix />
    </div>
  );
}
