// /v1/team/usage —— 團隊與成員維度用量統計（面 6）。
//
//   GET → 團隊總量 ＋ 各成員用量 ＋ 逐筆明細（?member_key_id= 可只看一個成員）
//
// 數字一律讀既有權威面（new-api 經 member-quota 的可視面；逐筆明細讀既有
// account_ledger），**不新建統計帳本**。回傳帶守恆檢驗：
//   主帳手上餘額 + Σ成員桶剩餘 = 團隊未消耗總額（沿用 member-quota 的不變量）。

import { NextRequest, NextResponse } from "next/server";

import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { readTeamUsage, resolveActorTeam } from "@/lib/generation-core/team-governance";

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
  const memberKeyId = req.nextUrl.searchParams.get("member_key_id")?.trim() || undefined;
  const usage = await readTeamUsage({ teamUserId: actorTeam.teamUserId, memberKeyId });
  if (!usage) {
    return fail(503, "usage_unavailable", "用量查询暂不可用，请稍后重试。");
  }

  return NextResponse.json(
    {
      success: true,
      team_user_id: usage.teamUserId,
      seats: usage.seats,
      member_count: usage.memberCount,
      capacity: usage.capacity,
      totals: {
        granted_quota: usage.totals.granted,
        used_quota: usage.totals.used,
        remaining_quota: usage.totals.remaining,
        granted_coins: usage.totals.coins.granted,
        used_coins: usage.totals.coins.used,
        remaining_coins: usage.totals.coins.remaining,
      },
      conservation: {
        master_remaining_quota: usage.conservation.masterRemaining,
        members_remaining_quota: usage.conservation.membersRemaining,
        team_remaining_quota: usage.conservation.teamRemaining,
        consumed_quota: usage.conservation.consumed,
        balanced: usage.conservation.balanced,
        formula: usage.conservation.formula,
      },
      members: usage.members.map((member) => ({
        member_key_id: member.memberKeyId,
        member_user_id: member.memberUserId,
        display_name: member.displayName,
        role: member.role,
        enabled: member.enabled,
        granted_quota: member.granted,
        used_quota: member.used,
        remaining_quota: member.remaining,
        granted_coins: member.coins.granted,
        used_coins: member.coins.used,
        remaining_coins: member.coins.remaining,
        ...(member.unavailable ? { unavailable: true } : {}),
        records: member.records.map((record) => ({
          record_id: record.id,
          user_id: record.userId,
          entry_type: record.entryType,
          amount_quota: record.amount,
          amount_coins: record.amountCoins,
          source: record.source,
          source_ref: record.sourceRef,
          job_id: record.jobId,
          operation_id: record.operationId,
          created_at: record.createdAt,
        })),
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
