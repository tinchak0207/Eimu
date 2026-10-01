// POST /v1/team/seats/order —— 席位下單（報價 + 待支付訂單 + 收銀台入口）。
//
//   入參：{ tier, cycle, seats }
//   出參：報價（quote）＋ 待支付訂單（pending_order，決定性 out_trade_no ⇒ 重放同一張）
//        ＋ payment: { payable: true } ＋ checkout 入口 ＋ todo（餘下接線清單）。
//
// 全鏈已接線（2026-10-01）：本路由只算價、出決定性訂單 id、給收銀台入口；收款由
// GET /api/payments/mapay/checkout?plan=seat:... 發起，回調由 notify 的席位履約分支
// （src/lib/team-seat-fulfillment.ts）同源覆核金額後把配額加到團隊主帳。
// **本路由與本檔不真收款、不寫任何已支付狀態、不落本地訂單表**（禁影子帳本）。
// 價格未配置 → 409 seat_price_not_configured；參數不合法 → 400（各自的碼）。
//
// 鑑權與回執形狀逐行沿用同群組的 /v1/team/seats 與 /v1/team/quota：身份只來自
// Authorization 的 B 端密鑰；團隊主帳由 resolveActorTeam 解析（成員呼叫時解析到其團隊，
// 但席位訂單是出資方的動作 ⇒ 只有 owner 可下單）。

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

  // 席位訂單是出資方（團隊）的動作：只有 owner 可以下單（與 023 的席位調整同權限語義）。
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
    // 報價合法 → 可支付：回待支付訂單 + 收銀台入口（全鏈已接線：收銀台 checkout
    // 與 notify 席位履約分支與本判定同源同一個 out_trade_no）。
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
