// POST /v1/team/seats/order —— 席位下單（刀 2：報價 + 待支付訂單語義的接縫）。
//
//   入參：{ tier, cycle, seats }
//   出參：報價（quote）＋ 待支付訂單（pending_order，決定性 out_trade_no ⇒ 重放同一張）
//        ＋ payment: { payable: false } ＋ todo（接線清單）。
//
// **本片不真收款**：不呼叫支付渠道、不寫任何已支付狀態、不落本地訂單表（禁影子帳本）。
// 價格未配置（team-seat-pricing.ts 的 null placeholder）→ 409 seat_price_not_configured；
// 價格已配置但履約端未接線 → 501 seat_order_fulfillment_unwired（回報價與待支付訂單，
// 但明確 payable:false）。收費與履約的接線清單見 src/lib/team-seat-order.ts 的 todo。
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

  if (decision.status === 501) {
    // 報價 + 待支付訂單語義照給，但 payable:false —— 本片不向支付渠道發起收款。
    return fail(501, decision.code, decision.message, {
      quote: decision.quote,
      pending_order: decision.pending_order,
      payment: { payable: false, wired: false },
      todo: decision.todo,
    });
  }

  return fail(decision.status, decision.code, decision.message);
}
