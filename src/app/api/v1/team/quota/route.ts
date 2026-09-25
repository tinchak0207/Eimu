// /v1/team/quota —— 團隊成員點數配額（REQ-B1，user 層模型）的分配面與可視面。
//
//   GET  → 主帳總額／已分配／各成員額度與消耗（全部當場讀 new-api 權威源）
//   POST → 團隊主 → 成員劃額度：{ member_key_id, target_coins | target_quota }
//          target 是**絕對目標值**，大於現值 = 劃額度、小於現值 = 回收、
//          等於現值 = 幂等 no-op（不寫上游）。
//
// 鑑權與計費主體只來自 B 端密鑰記錄（authenticateBizApiKey），與 /v1/quota 同一套：
// 呼叫方 key 的 user_id 就是團隊主帳（出資方）。成員金鑰的 user 若已在成員名冊
// 裡，即不得自行分配額度（403）——否則「團隊主分配」這條線形同虛設。
//
// 成員 = new-api 另一個 user（子帳號）：配額桶 = 成員 user 自己的 users.quota，
// 分配 = 主帳扣、成員加（轉移，兩條腿不成功即回滾，見 member-quota.ts）。
// 所有金額對外以幣（coins）為準（1 幣 = QUOTA_PER_COIN quota）；需要精確到
// quota 單位的呼叫方可以傳 target_quota。禁影子帳本：本路由不寫任何本地餘額，
// 額度真源只有 new-api（users.quota）。

import { NextRequest, NextResponse } from "next/server";

import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import {
  allocateMemberQuota,
  findMemberByUserId,
  readTeamQuotaView,
  toCoins,
} from "@/lib/generation-core/member-quota";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";

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

  const view = await readTeamQuotaView({ teamUserId: auth.key.userId });
  if (!view) {
    return fail(503, "quota_unavailable", "配额查询暂不可用，请稍后重试。");
  }

  return NextResponse.json(
    {
      success: true,
      team_user_id: view.teamUserId,
      master: { remaining_quota: view.master.remaining, balance_coins: view.master.coins },
      allocated: { quota: view.allocated, coins: view.allocatedCoins },
      used: { quota: view.used, coins: view.usedCoins },
      unallocated: { quota: view.unallocated, coins: view.unallocatedCoins },
      team_remaining: { quota: view.team.remaining, coins: view.team.coins },
      members: view.members.map((member) => ({
        member_key_id: member.memberKeyId,
        member_user_id: member.memberUserId,
        display_name: member.displayName,
        enabled: member.enabled,
        unlimited: member.unlimited,
        granted_quota: member.granted,
        used_quota: member.used,
        remaining_quota: member.remaining,
        granted_coins: member.coins.granted,
        used_coins: member.coins.used,
        remaining_coins: member.coins.remaining,
        // 讀不到上游時誠實給第三態，不畫 0 冒充足額。
        ...(member.unavailable ? { unavailable: true } : {}),
      })),
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

  // 成員不得自行分配額度（否則成員可以自己給自己加額度）。
  // user 層判據：呼叫方 key 的 user 若已在成員名冊裡，就代表它是「被分配的成員」
  // （成員 user ≠ 團隊主帳 user，見 019 的 CHECK 約束），不是出資方 ⇒ 403。
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

  const memberKeyId = typeof payload.member_key_id === "string" ? payload.member_key_id.trim() : "";
  if (!memberKeyId) {
    return fail(400, "missing_member_key_id", "缺少 member_key_id（要分配额度的成员密钥 id）。");
  }

  const targetCoins = payload.target_coins === undefined ? null : Number(payload.target_coins);
  const targetQuota = payload.target_quota === undefined ? null : Number(payload.target_quota);
  if (targetCoins === null && targetQuota === null) {
    return fail(400, "missing_target", "缺少 target_coins（或精确到 quota 的 target_quota）。");
  }
  if (targetCoins !== null && !Number.isFinite(targetCoins)) {
    return fail(400, "invalid_target", "target_coins 必须是数字。");
  }
  if (targetQuota !== null && !Number.isFinite(targetQuota)) {
    return fail(400, "invalid_target", "target_quota 必须是数字。");
  }
  // 幣優先：呼叫方按點數思考；quota 只是內部的精確單位。
  const targetGranted =
    targetCoins !== null ? Math.round(targetCoins * QUOTA_PER_COIN) : Math.round(targetQuota as number);

  const result = await allocateMemberQuota({
    teamUserId: auth.key.userId,
    memberKeyId,
    targetGranted,
  });
  if (!result.ok) {
    return fail(result.status, result.code, result.message);
  }

  return NextResponse.json(
    {
      success: true,
      member_key_id: result.memberKeyId,
      member_user_id: result.memberUserId,
      granted_quota: result.granted,
      used_quota: result.used,
      remaining_quota: result.remaining,
      granted_coins: toCoins(result.granted),
      remaining_coins: toCoins(result.remaining),
      transferred_quota: result.transferred,
      transferred_coins: toCoins(result.transferred),
      unchanged: result.unchanged,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
