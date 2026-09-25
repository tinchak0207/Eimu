// GET /v1/quota —— agent gateway 餘額閘的生產讀法。
//
// 餘額權威（REQ-E1a）＋池口徑（REQ-D3）＋C 端降級的完整決策住在 ./decision.ts
// （Next.js 對 route 檔匯出做白名單型別檢查，值匯出滯留本檔會炸 `next build`；
// 2026-09-23 遠端建置實錘後拆檔，行為零改動）。本檔只做 HTTP 包裝。
//
// 回應形狀（success / balance_coins / currency）與 503（quota_unavailable）
// 一字不改——契約不破。

import { NextRequest, NextResponse } from "next/server";
import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { decideQuota } from "./decision";

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

  const decision = await decideQuota(auth.key.userId);
  return NextResponse.json(decision.body, { status: decision.status, headers: decision.headers });
}
