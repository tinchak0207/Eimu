// POST /v1/team/seats/allocate —— 席位 ↔ 配額分配（刀 3）。
//
//   入參：{ member_user_id, seats, per_seat_coins }
//   出參：目標額度（seats × per_seat_coins 幣）＋ 成員桶的權威讀數（new-api）＋
//        本次實際轉移（正 = 劃出、負 = 回收、0 = 幂等 no-op）。
//
// 唯一通路：src/lib/generation-core/team-seat-allocation.ts → member-quota.ts 的
// allocateMemberQuota（主帳扣、成員加、先扣後加失敗回滾、團隊鎖串行化）。
// **本路由不寫任何本地點數**（禁影子帳本）：配額真相只在 new-api users.quota。
//
// 成員身份按 user（member_user_id，019 的 user 層模型：配額桶在成員 user 身上），
// 不走 key——同一 user 的多把密鑰共用同一桶。鑑權與回執形狀逐行沿用同群組的
// /v1/team/quota：團隊主帳 = 呼叫方密鑰的 user_id（不從 body 取）。

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

  // 成員不得自行分配額度（同 /v1/team/quota：成員 user 已在名冊裡 ⇒ 403）。
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
