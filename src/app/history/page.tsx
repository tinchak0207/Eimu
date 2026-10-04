import { Suspense } from "react";
import { HistoryClient } from "@/components/HistoryClient";

const HISTORY_TITLE = "生成历史 · Eimu";
const HISTORY_DESCRIPTION = "查看你在 Eimu 用 GPT Image 2、Nano Banana Pro 生成的所有历史记录和金币消耗明细。";

export const metadata = {
  title: { absolute: HISTORY_TITLE },
  // 个人页（需登入）：不进索引，别浪费爬取预算。
  robots: { index: false, follow: false },
  description: HISTORY_DESCRIPTION,
  openGraph: {
    title: HISTORY_TITLE,
    description: HISTORY_DESCRIPTION,
    url: "https://eimu.dev/history",
  },
  twitter: {
    card: "summary_large_image",
    title: HISTORY_TITLE,
    description: HISTORY_DESCRIPTION,
  },
};

/** 首屏骨架。HistoryClient 用了 useSearchParams，静态渲染阶段必须有 Suspense 边界。 */
function HistoryPageFallback() {
  return (
    <div className="min-h-screen bg-transparent px-4 pb-28 pt-8 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1440px]">
        <div className="flex items-center justify-center py-20">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-[rgba(0,122,255,0.20)] border-t-[#007AFF]" />
        </div>
      </div>
    </div>
  );
}

export default function HistoryPage() {
  return (
    <Suspense fallback={<HistoryPageFallback />}>
      <HistoryClient />
    </Suspense>
  );
}
