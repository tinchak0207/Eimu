// 公開的模型定價讀取端點：定價本來就展示在前端，無敏感資訊，不需要登入。
// 前端 usePricingRevision() 以 revision 訂閱重繪，這裡給的是「Blob 寫入版本 pathname」
// 當 revision——客戶端拿到新 revision 就重畫按新價。失敗永不拋錯：回空覆寫 + 200，
// 客戶端沿用基準價（定價讀取是降級優先，不能擋展示）。
//
// 快取策略：max-age=0 讓瀏覽器每幀都重新驗證，s-maxage=15 讓 CDN 最多存 15 秒，
// stale-while-revalidate=60 讓 CDN 在背景刷新時先用舊值回（正好匹配 propagationNote
// 的「其他温实例最长 15 秒后刷新」）。

import { NextResponse } from "next/server";
import { getRuntimeModelPricingOverrides, readModelPricingOverrides } from "@/lib/pricing-overrides";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // getRuntimeModelPricingOverrides() 永不拋錯：讀失敗服務 last-known-good，冷實例回 {}。
  const overrides = await getRuntimeModelPricingOverrides();

  // revision = 寫入版本 pathname；記憶體模式或讀取失敗就 null。這是降級路徑，絕不拋錯。
  let revision: string | null = null;
  try {
    const { version } = await readModelPricingOverrides();
    revision = version;
  } catch {
    revision = null;
  }

  return NextResponse.json(
    { overrides, revision, ttlMs: 60_000 },
    {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=15, stale-while-revalidate=60",
      },
    },
  );
}
