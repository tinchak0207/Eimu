import type { Metadata } from "next";
import { getSiteUrlFromEnv } from "@/lib/site-url";
import { DevAppendix } from "./DevAppendix";

const SITE_URL = getSiteUrlFromEnv();

export const metadata: Metadata = {
  title: "开发进阶（B 端 API） | 文档中心 | Eimu",
  alternates: { canonical: `${SITE_URL}/docs/api` },
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
