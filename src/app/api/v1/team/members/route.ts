// /v1/team/members —— 团队名册与角色（面 1：角色）。
//
//   GET  → 团队名册（含 role）＋ 席位/容量 ＋ 呼叫方的可指派角色
//   POST → { action: "set_role", member_key_id, role } | { action: "remove", member_key_id }
//
// 鉴权与回执形状逐行沿用 /v1/team/quota：身份只来自 Authorization 的 B 端密钥，
// 团队主帐 = 呼叫方密钥的 user_id（不从 body 取，否则任何人可代别人管事）。
// 只有「意图」写本地（role），点数一律不碰（禁影子帐本，分配走 /v1/team/quota）。

import { NextRequest, NextResponse } from "next/server";

import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import {
  TEAM_ROLES,
  isTeamRole,
  listTeamRoster,
  readTeamSettings,
  removeTeamMember,
  resolveActorTeam,
  resolveTeamActor,
  setMemberRole,
  teamCapacity,
} from "@/lib/generation-core/team-governance";
import { MEMBER_QUOTA_MODES, readQuotaLimits } from "@/lib/generation-core/team-quota-limits";

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
  const roster = await listTeamRoster(actorTeam.teamUserId);
  const settings = await readTeamSettings(actorTeam.teamUserId);
  const capacity = teamCapacity();
  const actor = resolveTeamActor({ userId: auth.key.userId, teamUserId: actorTeam.teamUserId, roster });
  // 配额意图面（速率／上界，非余额）：读不到（映射层不在）就不冒充，省略该栏。
  const quotaLimits = await readQuotaLimits({
    teamUserId: actorTeam.teamUserId,
    roster: roster.map((member) => ({
      memberUserId: member.memberUserId,
      displayName: member.displayName,
      role: member.role,
    })),
  });

  return NextResponse.json(
    {
      success: true,
      team_user_id: actorTeam.teamUserId,
      actor: { user_id: auth.key.userId, role: actor?.role ?? actorTeam.role, is_owner: actor?.role === "owner" },
      seats: settings.seats,
      capacity: {
        min_members: capacity.minMembers,
        default_max_members: capacity.defaultMaxMembers,
        max_members: capacity.maxMembers,
        member_count: roster.length,
      },
      settings: { member_create_canvas: settings.memberCreateCanvas },
      ...(quotaLimits
        ? {
            quota: {
              team: {
                mode: quotaLimits.team.mode,
                fixed_quota: quotaLimits.team.fixedQuota,
                daily_reset_at: quotaLimits.team.dailyResetAt,
              },
              member_modes: [...MEMBER_QUOTA_MODES],
            },
          }
        : {}),
      members: roster.map((member) => ({
        member_key_id: member.memberKeyId,
        member_user_id: member.memberUserId,
        display_name: member.displayName,
        enabled: member.enabled,
        role: member.role,
        ...(quotaLimits
          ? (() => {
              const limit = quotaLimits.members.find((m) => m.memberUserId === member.memberUserId);
              return limit
                ? {
                    quota: {
                      mode: limit.mode,
                      fixed_quota: limit.fixedQuota,
                      daily_quota: limit.dailyQuota,
                      daily_used: limit.dailyUsed,
                      daily_remaining: limit.dailyRemaining,
                    },
                  }
                : {};
            })()
          : {}),
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "invalid_json", "请求体必须是 JSON。");
  }
  const payload = (body ?? {}) as Record<string, unknown>;
  const action = typeof payload.action === "string" ? payload.action.trim() : "";
  const memberKeyId = typeof payload.member_key_id === "string" ? payload.member_key_id.trim() : "";
  if (!memberKeyId) {
    return fail(400, "missing_member_key_id", "缺少 member_key_id（要操作的成员密钥 id）。");
  }

  // 呼叫方所属团队：名册成员 → 其团队；团队主帐 → 自己。
  const actorTeam = await resolveActorTeam(auth.key.userId);
  const teamUserId = actorTeam.teamUserId;

  if (action === "set_role") {
    const role = typeof payload.role === "string" ? payload.role.trim() : "";
    if (!isTeamRole(role)) {
      return fail(400, "invalid_role", `role 必须是 ${TEAM_ROLES.join(" / ")} 之一。`);
    }
    const result = await setMemberRole({ teamUserId, actorUserId: auth.key.userId, memberKeyId, role });
    if (!result.ok) return fail(result.status, result.code, result.message);
    return NextResponse.json(
      {
        success: true,
        member_key_id: memberKeyId,
        member_user_id: result.memberUserId,
        role: result.role,
        unchanged: result.unchanged,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (action === "remove") {
    const result = await removeTeamMember({ teamUserId, actorUserId: auth.key.userId, memberKeyId });
    if (!result.ok) return fail(result.status, result.code, result.message);
    return NextResponse.json(
      { success: true, member_key_id: memberKeyId, member_user_id: result.memberUserId, removed: result.removed },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return fail(400, "unknown_action", "action 必须是 set_role 或 remove。");
}
