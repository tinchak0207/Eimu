// POST /api/topup — 已停用。
// 原先 makeProxy 到上游 POST /api/user/topup，由上游直接改余额，本路由不写帐本。
// 控制面没有「兑换即记帐」的 HTTP 路由：帐本是 worker 事后扫描上游已用兑换码
// （ingestRedeemedRecharges），那不是用户可调用的兑换入口。此处不再代上游创建余额。

import { NextResponse } from "next/server";

export const preferredRegion = "sfo1";

export function POST() {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: "redemption_requires_accounted_control_plane",
        message:
          "兑换必须走已记账的控制面路径。此接口只反代上游创建余额、不写帐本，已关闭。当前没有可调用的记账兑换 HTTP 路由。",
      },
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
