// /v1/team/seats —— 席位数（面 5：席位上限闸与调整 API）。
//
//   GET  → { seats, member_count, 容量常量, 可否再容纳 }
//   POST → { seats: number }（owner 可改）
//
// 席位语义：seats = 团队可容纳人数，且 min_members ≤ 现有成员数 ≤ seats ≤ max_members。
// 本片只做上限闸与调整，**不接支付**（按席位计价的下单是另一片，此处不碰计费）。
// 调整只写意图（整数），不碰任何点数（禁影子帐本）。

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
      // 诚实标注（刀 3）：席位目前只是意图整数，未接计费——不能按席位购买/续费/扣款。
      // 席位若要计价，既有下单入口是 GET /api/payments/mapay/checkout?plan=<id>
      // （套餐目录 src/lib/plans.ts，前端 src/components/PricingClient.tsx）；
      // 到帐后成员额度分配的唯一通路是 member-quota.ts 的 allocateMemberQuota。
      // 本端点刻意不做任何计费写入（禁影子帐本）。
      billing_connected: false,
      billing_note:
        "席位当前仅为人数上限的意图整数，未接入计费（不支持按席位购买/续费）；购买与续费走 /pricing 套餐，额度分配走 B 端额度接口。",
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
