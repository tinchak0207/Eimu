// GET /v1/quota —— agent gateway 餘額閘的生產讀法。
//
// gateway 的 workflow preflightBudget（R5-B）與 fetchBalance（錢包角標）都打
// 這條路：Bearer B端/agent key → biz_api_key.userId → new-api admin API 讀
// users.quota（唯一真源，1 幣 = 500000）→ { balance_coins }。
// 2026-08-29 事故前此路由不存在：預檢 404 → fail-open 靜默放行，agent 影片
// 批量把餘額扣成負數無人攔截。餘額可為負（真實狀態，不夾到 0）。

import { NextRequest, NextResponse } from "next/server";
import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { fetchGatewayUser } from "@/lib/gateway-admin";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";

export const runtime = "nodejs";
export const preferredRegion = "sfo1";

export async function GET(req: NextRequest) {
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) {
    return NextResponse.json(
      { success: false, error: { message: auth.message, code: auth.code } },
      {
        status: auth.status,
        ...(auth.retryAfterSeconds ? { headers: { "Retry-After": String(auth.retryAfterSeconds) } } : {}),
      },
    );
  }

  let user: Awaited<ReturnType<typeof fetchGatewayUser>>;
  try {
    user = await fetchGatewayUser(auth.key.userId);
  } catch {
    user = null;
  }
  if (!user) {
    return NextResponse.json(
      { success: false, error: { message: "余额查询暂不可用，请稍后重试。", code: "quota_unavailable" } },
      { status: 503 },
    );
  }

  const balanceCoins = Math.round((user.quota / QUOTA_PER_COIN) * 1e6) / 1e6;
  return NextResponse.json(
    { success: true, balance_coins: balanceCoins, currency: "coins" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
