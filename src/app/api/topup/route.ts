// POST /api/topup — 兑换充值码。
//
// 上游 `POST /api/user/topup` 是唯一改余额的地方（new-api 原子地消费兑换码并把额度
// 加到用户身上），本路由把它接回站内，让 `pricing#redeem` 不用跨域跳网关。
//
// 关于「兑换即记帐」（2026-10-25 恢复时写清，旧注释说这条通路「不写帐本所以不许有」）：
// 帐本的唯一入帐依据是「上游记录显示该码已被使用」（见 account-ledger/recharge-ingest.ts
// 头部），由 worker 维护循环按 10 分钟节奏扫描。本路由刻意**不**写帐本：发码即记会让
// 未兑换的码凭空变余额；在代理层抢先记一笔，则与扫描形成两个事实源，重放/并发下双算。
// 两条路径的幂等键同为 `redemption:<id>`，故「先兑换、扫描后补记」是设计行为。
//
// 失败语义：上游非 2xx 或 `success:false`（码无效/已用/过期）原样回前端；网络异常回
// 503 且不暗示成功——前端只在 `success:true` 时刷新余额并清空输入框。

import { NextRequest, NextResponse } from "next/server";

import { getGatewayBaseUrl } from "@/lib/new-api-auth-server";

export const preferredRegion = "sfo1";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization") ?? "";
  const userId = req.headers.get("x-user-id") ?? "";
  if (!auth) {
    return NextResponse.json({ success: false, message: "请先登录" }, { status: 401 });
  }

  let body: string;
  try {
    body = await req.text();
  } catch {
    return NextResponse.json({ success: false, message: "请求内容无法读取" }, { status: 400 });
  }

  const headers: Record<string, string> = {
    Authorization: auth,
    "Content-Type": "application/json",
  };
  if (userId) headers["New-Api-User"] = userId;

  try {
    const upstream = await fetch(`${getGatewayBaseUrl()}/api/user/topup`, {
      method: "POST",
      headers,
      body,
      cache: "no-store",
    });
    const text = await upstream.text();
    if (!text) {
      return NextResponse.json(
        { success: false, message: "网关没有返回结果，请稍后重试" },
        { status: 502 },
      );
    }
    const payload = JSON.parse(text) as unknown;
    return NextResponse.json(payload, { status: upstream.status });
  } catch (error) {
    console.error("[topup]", error);
    return NextResponse.json(
      { success: false, message: "兑换通道暂时不可用，请稍后重试" },
      { status: 503 },
    );
  }
}
