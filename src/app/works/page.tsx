import { Suspense } from "react";
import { WorksClient } from "@/components/WorksClient";

const TITLE = "我的作品 · Eimu";
export const metadata = {
  title: { absolute: TITLE },
  robots: { index: false, follow: false },
  description: "看成片、改某一镜、对比新旧版本、用这条、分享给朋友接着做。",
};

export default function WorksPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <WorksClient />
    </Suspense>
  );
}
