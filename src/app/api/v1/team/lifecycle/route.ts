// /v1/team/lifecycle —— 团队生命周期（面 4：解散冷静期／退出）。
//
//   GET  → { dissolved, dissolve_scheduled_at, due, remaining_ms, cooloff_hours }
//   POST → { action: "dissolve" }   排程解散（owner；48h 冷静期）
//          { action: "withdraw" }   冷静期内撤回（owner）
//          { action: "leave" }      成员退出（最后一个 owner 不可直接退出）
//
// 冷静期常量放 config（TEAM_DISSOLVE_COOLOFF_HOURS，默认 48）。执行解散只停用名册，
// 不动任何点数（成员桶已转出的额度留在该 user，回收走 member-quota 的分配通路）。

import { NextRequest, NextResponse } from "next/server";

import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import {
  HOUR_MS,
  getTeamLifecycle,
  leaveTeam,
  resolveActorTeam,
  scheduleTeamDissolution,
  teamDissolveCooloffMs,
  withdrawTeamDissolution,
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
  const lifecycle = await getTeamLifecycle(actorTeam.teamUserId);
  return NextResponse.json(
    {
      success: true,
      team_user_id: lifecycle.teamUserId,
      member_count: lifecycle.memberCount,
      dissolved: lifecycle.dissolved,
      dissolved_at: lifecycle.dissolvedAt,
      dissolve_scheduled_at: lifecycle.dissolveScheduledAt,
      due: lifecycle.due,
      remaining_ms: lifecycle.remainingMs,
      cooloff_hours: teamDissolveCooloffMs() / HOUR_MS,
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

  if (action === "dissolve") {
    const actorTeam = await resolveActorTeam(auth.key.userId);
    const result = await scheduleTeamDissolution({ teamUserId: actorTeam.teamUserId, actorUserId: auth.key.userId });
    if (!result.ok) return fail(result.status, result.code, result.message);
    return NextResponse.json(
      {
        success: true,
        dissolve_scheduled_at: result.dissolveScheduledAt,
        cooloff_hours: result.cooloffHours,
        unchanged: result.unchanged,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (action === "withdraw") {
    const actorTeam = await resolveActorTeam(auth.key.userId);
    const result = await withdrawTeamDissolution({ teamUserId: actorTeam.teamUserId, actorUserId: auth.key.userId });
    if (!result.ok) return fail(result.status, result.code, result.message);
    return NextResponse.json({ success: true, withdrawn: result.withdrawn }, { headers: { "Cache-Control": "no-store" } });
  }

  if (action === "leave") {
    const result = await leaveTeam({ actorUserId: auth.key.userId });
    if (!result.ok) return fail(result.status, result.code, result.message);
    return NextResponse.json(
      { success: true, team_user_id: result.teamUserId, member_user_id: result.memberUserId, left: result.left },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return fail(400, "unknown_action", "action 必须是 dissolve、withdraw 或 leave。");
}
