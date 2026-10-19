// /v1/team/seats —— 席位数（面 5：席位上限闸与调整 API）。
//
//   GET  → { seats, member_count, 容量常量, 可否再容纳 }
//   POST → { seats: number }（owner 可改）
//
// 席位语义：seats = 团队可容纳人数，且 min_members ≤ 现有成员数 ≤ seats ≤ max_members。
// 本路由只读写人数上限整数，不扣款、不创建支付单。
// 按席位购买在 POST /v1/team/seats/order：报价合法就给出待支付订单和收银台入口；
// 收款是 GET /api/payments/mapay/checkout，到帐由 notify 的席位分支履约。续费/退款未做。

import { NextRequest, NextResponse } from "next/server";

import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import {
  listTeamRoster,
  readTeamSettings,
  resolveActorTeam,
  setTeamSeats,
  teamCapacity,
} from "@/lib/generation-core/team-governance";

export const runtime = "nodejs";
export const preferredRegion = "sfo1";

function fail(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ success: false, error: { message, code } }, { status });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
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

  const actorTeam = await resolveActorTeam(auth.key.userId);
  const settings = await readTeamSettings(actorTeam.teamUserId);
  const roster = await listTeamRoster(actorTeam.teamUserId);
  const capacity = teamCapacity();

  return NextResponse.json(
    {
      success: true,
      team_user_id: actorTeam.teamUserId,
      seats: settings.seats,
      member_count: roster.length,
      capacity: {
        min_members: capacity.minMembers,
        default_max_members: capacity.defaultMaxMembers,
        max_members: capacity.maxMembers,
      },
      can_admit_more: roster.length < settings.seats,
      // 本 GET/POST 不写支付。购买是否接通看 order 路由：报价合法即待支付订单，
      // checkout 真的打开 mapay 收款页，notify 按同源价表履约。续费/退款仍未做。
      billing_connected: true,
      billing_note:
        "本接口只读写人数上限，本身不扣款。按席位购买已接通：POST /v1/team/seats/order 在报价合法时返回可支付订单，收银台为 GET /api/payments/mapay/checkout。续费与退款未做。",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "invalid_json", "请求体必须是 JSON。");
  }
  const payload = (body ?? {}) as Record<string, unknown>;
  const seats = Number(payload.seats);
  if (!Number.isFinite(seats)) {
    return fail(400, "invalid_seats", "缺少 seats（正整数）。");
  }

  const actorTeam = await resolveActorTeam(auth.key.userId);
  const result = await setTeamSeats({ teamUserId: actorTeam.teamUserId, actorUserId: auth.key.userId, seats });
  if (!result.ok) return fail(result.status, result.code, result.message);

  return NextResponse.json(
    {
      success: true,
      seats: result.seats,
      member_count: result.memberCount,
      unchanged: result.unchanged,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
