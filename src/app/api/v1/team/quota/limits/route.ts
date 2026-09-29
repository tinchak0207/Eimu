// /v1/team/quota/limits —— 團隊與成員配額（速率／上界限制）的讀寫面。
//
//   GET  → 團隊配額模式（none/fixed）＋ 各成員配額模式與當日用量
//   POST → { scope: "team",  mode: "none"|"fixed", fixed_quota? }
//          { scope: "member", member_user_id, mode: "unlimited"|"fixed"|"daily",
//            fixed_quota?, daily_quota? }
//
// 鑑權與回執形狀逐行沿用同群組的 /v1/team/quota：團隊主帳 = 呼叫方密鑰的
// user_id（不從 body 取）。成員密鑰不得改配額（403）。
//
// **禁影子帳本**：本路由只寫「意圖上限」與「速率計數」（team_settings /
// team_member_quota 的意圖欄位），不寫任何本地餘額、不呼叫上游額度調整。
// 配額是上界限制，**不預扣**；真實扣費仍走既有五態帳本。
// 「改回不限 ⇒ 剩餘全數回收」只回報應回收額度（reclaim），實際點數移動須另走
// /v1/team/quota 或 /v1/team/seats/allocate 的轉移通路。

import { NextRequest, NextResponse } from "next/server";

import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { findMemberByUserId } from "@/lib/generation-core/member-quota";
import { listTeamRoster, readTeamSettings, resolveActorTeam } from "@/lib/generation-core/team-governance";
import {
  MEMBER_QUOTA_MODES,
  TEAM_QUOTA_MODES,
  isMemberQuotaMode,
  isTeamQuotaMode,
  readQuotaLimits,
  setMemberQuotaLimit,
  setTeamQuotaLimit,
} from "@/lib/generation-core/team-quota-limits";

export const runtime = "nodejs";
export const preferredRegion = "sfo1";

function fail(status: number, code: string, message: string): NextResponse {
  return NextResponse.json(
    { success: false, error: { message, code } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
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

  const actorTeam = await resolveActorTeam(auth.key.userId);
  const roster = await listTeamRoster(actorTeam.teamUserId);
  const view = await readQuotaLimits({
    teamUserId: actorTeam.teamUserId,
    roster: roster.map((member) => ({
      memberUserId: member.memberUserId,
      displayName: member.displayName,
      role: member.role,
    })),
  });
  if (!view) return fail(503, "quota_limits_unavailable", "配額设置查询暂不可用，请稍后重试。");

  const settings = await readTeamSettings(actorTeam.teamUserId);
  return NextResponse.json(
    {
      success: true,
      team_user_id: view.teamUserId,
      actor: { user_id: auth.key.userId, role: actorTeam.role, is_owner: actorTeam.role === "owner" },
      team: {
        mode: view.team.mode,
        fixed_quota: view.team.fixedQuota,
        daily_reset_at: view.team.dailyResetAt,
        member_create_canvas: settings.memberCreateCanvas,
      },
      member_modes: QUOTA_MODE_VOCABULARY,
      members: view.members.map((member) => ({
        member_user_id: member.memberUserId,
        display_name: member.displayName,
        role: member.role,
        mode: member.mode,
        fixed_quota: member.fixedQuota,
        daily_quota: member.dailyQuota,
        daily_used: member.dailyUsed,
        daily_remaining: member.dailyRemaining,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const QUOTA_MODE_VOCABULARY = { team: [...TEAM_QUOTA_MODES], member: [...MEMBER_QUOTA_MODES] };

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

  // 成員不得自行改配額（同群組既有口徑）。
  const callerIsMember = await findMemberByUserId(auth.key.userId);
  if (callerIsMember) {
    return fail(403, "member_cannot_set_quota", "成员密钥不得修改配額，请用团队主账号或管理员密钥操作。");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "invalid_json", "请求体必须是 JSON。");
  }
  const payload = (body ?? {}) as Record<string, unknown>;
  const scope = typeof payload.scope === "string" ? payload.scope.trim() : "";

  const actorTeam = await resolveActorTeam(auth.key.userId);
  const teamUserId = actorTeam.teamUserId;

  if (scope === "team") {
    const mode = typeof payload.mode === "string" ? payload.mode.trim() : "";
    if (!isTeamQuotaMode(mode)) {
      return fail(400, "invalid_mode", "mode 必须是 none（不限）或 fixed（固定额度）。");
    }
    const fixedQuota = payload.fixed_quota === undefined ? 0 : Number(payload.fixed_quota);
    if (!Number.isFinite(fixedQuota)) return fail(400, "invalid_quota", "fixed_quota 必须是数字。");
    const result = await setTeamQuotaLimit({
      teamUserId,
      actorRole: actorTeam.role,
      mode,
      fixedQuota,
    });
    if (!result.ok) return fail(result.status, result.code, result.message);
    return NextResponse.json(
      {
        success: true,
        scope: "team",
        team_user_id: teamUserId,
        mode: result.mode,
        fixed_quota: result.fixedQuota,
        // 改回不限 ⇒ 應回收額度（實際移動須另走轉移通路）。
        reclaim_quota: result.reclaim,
        unchanged: result.unchanged,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (scope === "member") {
    const memberUserId = Number(payload.member_user_id);
    if (!Number.isInteger(memberUserId) || memberUserId <= 0) {
      return fail(400, "missing_member_user_id", "缺少 member_user_id（要设置配額的成员账号）。");
    }
    const mode = typeof payload.mode === "string" ? payload.mode.trim() : "";
    if (!isMemberQuotaMode(mode)) {
      return fail(400, "invalid_mode", "mode 必须是 unlimited / fixed / daily 之一。");
    }
    const roster = await listTeamRoster(teamUserId);
    const target = roster.find((member) => member.memberUserId === memberUserId);
    if (!target) return fail(404, "member_not_found", `未找到团队内的成员账号 ${memberUserId}。`);
    const result = await setMemberQuotaLimit({
      teamUserId,
      actorRole: actorTeam.role,
      targetMemberUserId: memberUserId,
      targetRole: target.role,
      mode,
      fixedQuota: payload.fixed_quota === undefined ? 0 : Number(payload.fixed_quota),
      dailyQuota: payload.daily_quota === undefined ? 0 : Number(payload.daily_quota),
    });
    if (!result.ok) return fail(result.status, result.code, result.message);
    return NextResponse.json(
      {
        success: true,
        scope: "member",
        team_user_id: teamUserId,
        member_user_id: memberUserId,
        mode: result.mode,
        fixed_quota: result.fixedQuota,
        daily_quota: result.dailyQuota,
        unchanged: result.unchanged,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return fail(400, "unknown_scope", "scope 必须是 team 或 member。");
}
