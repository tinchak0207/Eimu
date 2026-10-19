// /v1/team/quota —— 团队成员点数配额（REQ-B1，user 层模型）的分配面与可视面。
//
//   GET  → 主帐总额／已分配／各成员额度与消耗（全部当场读 new-api 权威源）
//   POST → 团队主 → 成员划额度：{ member_key_id, target_coins | target_quota }
//          target 是**绝对目标值**，大于现值 = 划额度、小于现值 = 回收、
//          等于现值 = 幂等 no-op（不写上游）。
//
// 鉴权与计费主体只来自 B 端密钥记录（authenticateBizApiKey），与 /v1/quota 同一套：
// 呼叫方 key 的 user_id 就是团队主帐（出资方）。成员金钥的 user 若已在成员名册
// 里，即不得自行分配额度（403）——否则「团队主分配」这条线形同虚设。
//
// 成员 = new-api 另一个 user（子帐号）：配额桶 = 成员 user 自己的 users.quota，
// 分配 = 主帐扣、成员加（转移，两条腿不成功即回滚，见 member-quota.ts）。
// 所有金额对外以币（coins）为准（1 币 = QUOTA_PER_COIN quota）；需要精确到
// quota 单位的呼叫方可以传 target_quota。禁影子帐本：本路由不写任何本地余额，
// 额度真源只有 new-api（users.quota）。

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
        // 读不到上游时诚实给第三态，不画 0 冒充足额。
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

  // 成员不得自行分配额度（否则成员可以自己给自己加额度）。
  // user 层判据：呼叫方 key 的 user 若已在成员名册里，就代表它是「被分配的成员」
  // （成员 user ≠ 团队主帐 user，见 019 的 CHECK 约束），不是出资方 ⇒ 403。
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
  // 币优先：呼叫方按点数思考；quota 只是内部的精确单位。
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
