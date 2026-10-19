// /v1/team/settings —— 团队级设定（面 2：建画布权限开关）。
//
//   GET  → { member_create_canvas } ＋ 容量/席位快照
//   POST → { member_create_canvas: boolean }（owner/admin 可改）
//
// 开关只决定「非 owner/admin 的成员能否建共享画布」；owner/admin 恒可建。
// 只写意图（布林），不碰任何点数。成员侧闸见 canMemberCreateSharedCanvas()。

import { NextRequest, NextResponse } from "next/server";

import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import {
  listTeamRoster,
  readTeamSettings,
  resolveActorTeam,
  resolveTeamActor,
  teamCapacity,
  updateTeamSettings,
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
  const actor = resolveTeamActor({ userId: auth.key.userId, teamUserId: actorTeam.teamUserId, roster });

  return NextResponse.json(
    {
      success: true,
      team_user_id: actorTeam.teamUserId,
      actor: { user_id: auth.key.userId, role: actor?.role ?? actorTeam.role },
      member_create_canvas: settings.memberCreateCanvas,
      seats: settings.seats,
      capacity: {
        min_members: capacity.minMembers,
        default_max_members: capacity.defaultMaxMembers,
        max_members: capacity.maxMembers,
        member_count: roster.length,
      },
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
  if (typeof payload.member_create_canvas !== "boolean") {
    return fail(400, "invalid_member_create_canvas", "缺少 member_create_canvas（布林值）。");
  }

  const actorTeam = await resolveActorTeam(auth.key.userId);
  const result = await updateTeamSettings({
    teamUserId: actorTeam.teamUserId,
    actorUserId: auth.key.userId,
    memberCreateCanvas: payload.member_create_canvas,
  });
  if (!result.ok) return fail(result.status, result.code, result.message);

  return NextResponse.json(
    { success: true, member_create_canvas: result.memberCreateCanvas, unchanged: result.unchanged },
    { headers: { "Cache-Control": "no-store" } },
  );
}
