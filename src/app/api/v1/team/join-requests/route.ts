// /v1/team/join-requests —— 加入审批（面 3：pending/approved/rejected/ignored 四态）。
//
//   GET  → 待审名单（owner/admin）?status=approved|rejected|ignored 可切换
//   POST → { action: "apply", team_user_id }                    （申请人身份来自身份验证）
//          { action: "decide", request_id, decision }           decision = approve|reject|ignore
//
// 容量不变量：min_members(2) ≤ 名册成员数 ≤ seats ≤ max_members(200)。
// 满员时申请不得自动通过；通过 = 既有 upsertTeamMember 登记名册（role 默认 member），
// **不触碰任何点数、不做任何扣费**（禁影子帐本、禁重复扣费）。

import { NextRequest, NextResponse } from "next/server";

import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import {
  applyToJoinTeam,
  decideJoinRequest,
  listJoinRequests,
  resolveActorTeam,
  teamCapacity,
  teamJoinLimits,
  type JoinRequestStatus,
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

  const rawStatus = req.nextUrl.searchParams.get("status");
  const status = rawStatus === "approved" || rawStatus === "rejected" || rawStatus === "ignored" ? (rawStatus as JoinRequestStatus) : "pending";
  const actorTeam = await resolveActorTeam(auth.key.userId);
  const result = await listJoinRequests({ teamUserId: actorTeam.teamUserId, actorUserId: auth.key.userId, status });
  if (!result.ok) return fail(result.status, result.code, result.message);

  const capacity = teamCapacity();
  return NextResponse.json(
    {
      success: true,
      team_user_id: actorTeam.teamUserId,
      status,
      capacity: {
        min_members: capacity.minMembers,
        default_max_members: capacity.defaultMaxMembers,
        max_members: capacity.maxMembers,
      },
      join_limits: teamJoinLimits(),
      requests: result.requests.map((request) => ({
        request_id: request.id,
        applicant_user_id: request.applicantUserId,
        applicant_member_key_id: request.applicantMemberKeyId,
        display_name: request.displayName,
        status: request.status,
        created_at: request.createdAt,
        decided_at: request.decidedAt,
        decided_by_user_id: request.decidedByUserId,
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

  if (action === "apply") {
    const teamUserId = Number(payload.team_user_id);
    if (!Number.isInteger(teamUserId) || teamUserId <= 0) {
      return fail(400, "invalid_team_user_id", "缺少 team_user_id（要加入的团队主账号）。");
    }
    // 申请人身份只来自密钥（user_id + 这把 key），不从 body 取 user。
    const result = await applyToJoinTeam({
      teamUserId,
      applicantUserId: auth.key.userId,
      applicantMemberKeyId: auth.key.id,
      displayName: auth.key.label,
    });
    if (!result.ok) return fail(result.status, result.code, result.message);
    return NextResponse.json(
      {
        success: true,
        request_id: result.request.id,
        team_user_id: result.request.teamUserId,
        applicant_user_id: result.request.applicantUserId,
        status: result.request.status,
        created: result.created,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (action === "decide") {
    const requestId = typeof payload.request_id === "string" ? payload.request_id.trim() : "";
    const decision = typeof payload.decision === "string" ? payload.decision.trim() : "";
    if (!requestId) return fail(400, "missing_request_id", "缺少 request_id。");
    if (decision !== "approve" && decision !== "reject" && decision !== "ignore") {
      return fail(400, "invalid_decision", "decision 必须是 approve、reject 或 ignore。");
    }
    // 审批者所属团队：名册 admin → 其团队；团队主帐 → 自己。
    const actorTeam = await resolveActorTeam(auth.key.userId);
    const result = await decideJoinRequest({
      teamUserId: actorTeam.teamUserId,
      actorUserId: auth.key.userId,
      requestId,
      decision,
    });
    if (!result.ok) return fail(result.status, result.code, result.message);
    return NextResponse.json(
      {
        success: true,
        request_id: result.requestId,
        status: result.status,
        member_user_id: result.memberUserId,
        unchanged: result.unchanged,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return fail(400, "unknown_action", "action 必须是 apply 或 decide。");
}
