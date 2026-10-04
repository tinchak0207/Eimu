// 公开的模型定价读取端点：定价本来就展示在前端，无敏感资讯，不需要登入。
// 前端 usePricingRevision() 以 revision 订阅重绘，这里给的是「Blob 写入版本 pathname」
// 当 revision——客户端拿到新 revision 就重画按新价。失败永不抛错：回空覆写 + 200，
// 客户端沿用基准价（定价读取是降级优先，不能挡展示）。
//
// 快取策略：max-age=0 让浏览器每帧都重新验证，s-maxage=15 让 CDN 最多存 15 秒，
// stale-while-revalidate=300 让 CDN 在背景刷新时先用旧值回（新鲜度仍是 15 秒：过期后第一个请求
// 触发背景重取，下一个请求就拿新值；2026-10-01 效能审计 P1-E 由 60 拉长，冷 MISS 实测 1.1–1.6s）。

import { NextResponse } from "next/server";
import { getRuntimeModelPricingOverrides, readModelPricingOverrides } from "@/lib/pricing-overrides";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

export async function GET() {
  // getRuntimeModelPricingOverrides() 永不抛错：读失败服务 last-known-good，冷实例回 {}。
  const overrides = await getRuntimeModelPricingOverrides();

  // revision = 写入版本 pathname；记忆体模式或读取失败就 null。这是降级路径，绝不抛错。
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
        "Cache-Control": "public, max-age=0, s-maxage=15, stale-while-revalidate=300",
      },
    },
  );
}
