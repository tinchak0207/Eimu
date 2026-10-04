// POST /v1/team/seats/allocate —— 席位 ↔ 配额分配（刀 3）。
//
//   入参：{ member_user_id, seats, per_seat_coins }
//   出参：目标额度（seats × per_seat_coins 币）＋ 成员桶的权威读数（new-api）＋
//        本次实际转移（正 = 划出、负 = 回收、0 = 幂等 no-op）。
//
// 唯一通路：src/lib/generation-core/team-seat-allocation.ts → member-quota.ts 的
// allocateMemberQuota（主帐扣、成员加、先扣后加失败回滚、团队锁串行化）。
// **本路由不写任何本地点数**（禁影子帐本）：配额真相只在 new-api users.quota。
//
// 成员身份按 user（member_user_id，019 的 user 层模型：配额桶在成员 user 身上），
// 不走 key——同一 user 的多把密钥共用同一桶。鉴权与回执形状逐行沿用同群组的
// /v1/team/quota：团队主帐 = 呼叫方密钥的 user_id（不从 body 取）。

import { NextRequest, NextResponse } from "next/server";

import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { findMemberByUserId } from "@/lib/generation-core/member-quota";
import { applySeatAllocation } from "@/lib/generation-core/team-seat-allocation";

export const runtime = "nodejs";
export const preferredRegion = "sfo1";

function fail(status: number, code: string, message: string): NextResponse {
  return NextResponse.json(
    { success: false, error: { message, code } },
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

  // 成员不得自行分配额度（同 /v1/team/quota：成员 user 已在名册里 ⇒ 403）。
  const callerIsMember = await findMemberByUserId(auth.key.userId);
  if (callerIsMember) {
    return fail(403, "member_cannot_allocate", "成员密钥不得自行分配额度，请用团队主账号密钥操作。");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "invalid_json", "请求体必须是 JSON。");
  }
  const payload = (body ?? {}) as Record<string, unknown>;

  const result = await applySeatAllocation({
    teamUserId: auth.key.userId,
    memberUserId: Number(payload.member_user_id),
    seats: payload.seats as number,
    perSeatCoins: Number(payload.per_seat_coins),
  });
  if (!result.ok) return fail(result.status, result.code, result.message);

  return NextResponse.json(
    {
      success: true,
      team_user_id: auth.key.userId,
      member_key_id: result.memberKeyId,
      member_user_id: result.memberUserId,
      seats: result.seats,
      per_seat_coins: result.perSeatCoins,
      target_coins: result.targetCoins,
      target_quota: result.targetQuota,
      granted_quota: result.granted,
      used_quota: result.used,
      remaining_quota: result.remaining,
      transferred_quota: result.transferred,
      transferred_coins: result.transferredCoins,
      unchanged: result.unchanged,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
