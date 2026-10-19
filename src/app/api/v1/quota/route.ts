// GET /v1/quota —— agent gateway 余额闸的生产读法。
//
// 余额权威（REQ-E1a）＋池口径（REQ-D3）＋C 端降级的完整决策住在 ./decision.ts
// （Next.js 对 route 档汇出做白名单型别检查，值汇出滞留本档会炸 `next build`；
// 2026-09-23 远端建置实锤后拆档，行为零改动）。本档只做 HTTP 包装。
//
// 回应形状（success / balance_coins / currency）与 503（quota_unavailable）
// 一字不改——契约不破。

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
