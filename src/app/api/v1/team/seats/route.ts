// /v1/team/seats —— 席位數（面 5：席位上限閘與調整 API）。
//
//   GET  → { seats, member_count, 容量常量, 可否再容納 }
//   POST → { seats: number }（owner 可改）
//
// 席位語義：seats = 團隊可容納人數，且 min_members ≤ 現有成員數 ≤ seats ≤ max_members。
// 本片只做上限閘與調整，**不接支付**（按席位計價的下單是另一片，此處不碰計費）。
// 調整只寫意圖（整數），不碰任何點數（禁影子帳本）。

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
      // 誠實標註（刀 3）：席位目前只是意圖整數，未接計費——不能按席位購買/續費/扣款。
      // 席位若要計價，既有下單入口是 GET /api/payments/mapay/checkout?plan=<id>
      // （套餐目錄 src/lib/plans.ts，前端 src/components/PricingClient.tsx）；
      // 到帳後成員額度分配的唯一通路是 member-quota.ts 的 allocateMemberQuota。
      // 本端點刻意不做任何計費寫入（禁影子帳本）。
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
