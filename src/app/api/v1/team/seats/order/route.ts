// POST /v1/team/seats/order —— 席位下单（报价 + 待支付订单 + 收银台入口）。
//
//   入参：{ tier, cycle, seats }
//   出参：报价（quote）＋ 待支付订单（pending_order，决定性 out_trade_no ⇒ 重放同一张）
//        ＋ payment: { payable: true } ＋ checkout 入口 ＋ todo（余下接线清单）。
//
// 全链已接线（2026-10-01）：本路由只算价、出决定性订单 id、给收银台入口；收款由
// GET /api/payments/mapay/checkout?plan=seat:... 发起，回调由 notify 的席位履约分支
// （src/lib/team-seat-fulfillment.ts）同源覆核金额后把配额加到团队主帐。
// **本路由与本档不真收款、不写任何已支付状态、不落本地订单表**（禁影子帐本）。
// 价格未配置 → 409 seat_price_not_configured；参数不合法 → 400（各自的码）。
//
// 鉴权与回执形状逐行沿用同群组的 /v1/team/seats 与 /v1/team/quota：身份只来自
// Authorization 的 B 端密钥；团队主帐由 resolveActorTeam 解析（成员呼叫时解析到其团队，
// 但席位订单是出资方的动作 ⇒ 只有 owner 可下单）。

import { NextRequest, NextResponse } from "next/server";

import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import {
  listTeamRoster,
  resolveActorTeam,
  resolveTeamActor,
} from "@/lib/generation-core/team-governance";
import { decideSeatOrder } from "@/lib/team-seat-order";

export const runtime = "nodejs";
export const preferredRegion = "sfo1";

function fail(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): NextResponse {
  return NextResponse.json(
    { success: false, error: { message, code }, ...extra },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) {
    return NextResponse.json(
      { success: false, error: { message: auth.message, code: auth.code } },
      {
        status: auth.status,
        headers: {
          "Cache-Control": "no-store",
          ...(auth.retryAfterSeconds ? { "Retry-After": String(auth.retryAfterSeconds) } : {}),
        },
      },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "invalid_json", "请求体必须是 JSON。");
  }
  const payload = (body ?? {}) as Record<string, unknown>;

  // 席位订单是出资方（团队）的动作：只有 owner 可以下单（与 023 的席位调整同权限语义）。
  const actorTeam = await resolveActorTeam(auth.key.userId);
  const roster = await listTeamRoster(actorTeam.teamUserId);
  const actor = resolveTeamActor({ userId: auth.key.userId, teamUserId: actorTeam.teamUserId, roster });
  if (!actor || !actor.isOwner) {
    return fail(403, "forbidden", "只有团队所有者可以下席位订单。");
  }

  const decision = decideSeatOrder({
    teamUserId: actorTeam.teamUserId,
    tier: payload.tier,
    cycle: payload.cycle,
    seats: payload.seats,
  });

  if (decision.ok) {
    // 报价合法 → 可支付：回待支付订单 + 收银台入口（全链已接线：收银台 checkout
    // 与 notify 席位履约分支与本判定同源同一个 out_trade_no）。
    return NextResponse.json(
      {
        success: true,
        team_user_id: actorTeam.teamUserId,
        quote: decision.quote,
        pending_order: decision.pending_order,
        payment: { payable: true, wired: true },
        checkout: decision.checkout,
        todo: decision.todo,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return fail(decision.status, decision.code, decision.message);
}
