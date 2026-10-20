import { randomUUID } from "node:crypto";

import { getGenerationSql, type GenerationSql } from "../database";
import { upsertTeamMember } from "../member-quota";
import { isTeamManager, resolveTeamActor } from "./policies";
import { countJoinedTeams, fail, governanceStoreEnabled, listTeamRoster, lockFor, readTeamSettings, reasonOf } from "./store";
import { mapJoinRow, type JoinRow, type JoinRequestStatus, type TeamGovernanceDeps, type TeamJoinRequestRecord, type GovernanceResult } from "./types";
import { teamCapacity, teamJoinLimits } from "./types";

// ─────────────────────────────────────────── 面 3：加入审批
async function findJoinRequest(input: {
  teamUserId: number;
  applicantUserId: number;
  sql: GenerationSql;
}): Promise<TeamJoinRequestRecord | null> {
  const rows = await input.sql<JoinRow[]>`
    SELECT id, team_user_id, applicant_user_id, applicant_member_key_id, display_name, status,
           created_at, decided_at, decided_by_user_id
    FROM team_join_request
    WHERE team_user_id = ${input.teamUserId} AND applicant_user_id = ${input.applicantUserId}
    LIMIT 1
  `;
  return rows[0] ? mapJoinRow(rows[0]) : null;
}

/**
 * 申请加入团队（申请人身份来自身份验证，不从 body 取 user）。
 * 幂等：已有 pending 申请 → 回同一条（created=false）；已驳回/忽略 → 重开为 pending。
 */
export async function applyToJoinTeam(
  input: { teamUserId: number; applicantUserId: number; applicantMemberKeyId: string; displayName?: string },
  deps: TeamGovernanceDeps = {},
): Promise<GovernanceResult<{ request: TeamJoinRequestRecord; created: boolean }>> {
  if (!governanceStoreEnabled()) {
    return fail(503, "store_unavailable", "团队成员治理映射层不可用（控制面数据库未配置）。");
  }
  if (!Number.isInteger(input.teamUserId) || input.teamUserId <= 0) {
    return fail(400, "cannot_join_own_team", "team_user_id 必须是有效的团队主账号。");
  }
  // 主帐恒为 owner，不是成员；申请自己的团队无意义。
  if (input.applicantUserId === input.teamUserId) {
    return fail(409, "cannot_join_own_team", "你是该团队的创建者，无需申请加入。");
  }
  const sql = deps.sql ?? getGenerationSql();
  try {
    return await lockFor(deps, sql)(input.teamUserId, async (tx) => {
      const roster = await listTeamRoster(input.teamUserId, tx);
      if (roster.some((entry) => entry.memberUserId === input.applicantUserId)) {
        return fail<{ request: TeamJoinRequestRecord; created: boolean }>(409, "already_member", "你已经是该团队成员。");
      }
      const existing = await findJoinRequest({ teamUserId: input.teamUserId, applicantUserId: input.applicantUserId, sql: tx });
      if (existing && existing.status === "pending") {
        return { ok: true, request: existing, created: false };
      }
      if (existing && existing.status === "approved") {
        return fail<{ request: TeamJoinRequestRecord; created: boolean }>(409, "already_member", "你的加入申请已通过。");
      }
      const id = existing?.id ?? (deps.newId ?? randomUUID)();
      await tx`
        INSERT INTO team_join_request (id, team_user_id, applicant_user_id, applicant_member_key_id, display_name, status, decided_at, decided_by_user_id)
        VALUES (${id}, ${input.teamUserId}, ${input.applicantUserId}, ${input.applicantMemberKeyId}, ${input.displayName ?? ""}, 'pending', NULL, NULL)
        ON CONFLICT (team_user_id, applicant_user_id) DO UPDATE SET
          status = 'pending', applicant_member_key_id = EXCLUDED.applicant_member_key_id,
          display_name = EXCLUDED.display_name, decided_at = NULL, decided_by_user_id = NULL, updated_at = now()
      `;
      const stored = await findJoinRequest({ teamUserId: input.teamUserId, applicantUserId: input.applicantUserId, sql: tx });
      return { ok: true, request: stored ?? { ...(existing as TeamJoinRequestRecord), id, status: "pending" as JoinRequestStatus }, created: true };
    });
  } catch (error) {
    console.error(`[team-governance] applyToJoinTeam 失败 team=${input.teamUserId}: ${reasonOf(error)}`);
    return fail(503, "store_unavailable", "加入申请提交暂不可用，请稍后重试。");
  }
}

/** 审批台列表：owner/admin 可看；可按状态过滤（默认 pending）。 */
export async function listJoinRequests(
  input: { teamUserId: number; actorUserId: number; status?: JoinRequestStatus },
  deps: TeamGovernanceDeps = {},
): Promise<GovernanceResult<{ requests: TeamJoinRequestRecord[] }>> {
  if (!governanceStoreEnabled()) {
    return fail(503, "store_unavailable", "团队成员治理映射层不可用（控制面数据库未配置）。");
  }
  const sql = deps.sql ?? getGenerationSql();
  try {
    const roster = await listTeamRoster(input.teamUserId, sql);
    const actor = resolveTeamActor({ userId: input.actorUserId, teamUserId: input.teamUserId, roster });
    if (!actor || !isTeamManager(actor.role)) {
      return fail<{ requests: TeamJoinRequestRecord[] }>(403, "forbidden", "只有团队创建者或管理员可以查看加入申请。");
    }
    const status = input.status ?? "pending";
    const rows = await sql<JoinRow[]>`
      SELECT id, team_user_id, applicant_user_id, applicant_member_key_id, display_name, status,
             created_at, decided_at, decided_by_user_id
      FROM team_join_request
      WHERE team_user_id = ${input.teamUserId} AND status = ${status}
      ORDER BY created_at ASC
    `;
    return { ok: true, requests: rows.map(mapJoinRow) };
  } catch (error) {
    console.error(`[team-governance] listJoinRequests 失败 team=${input.teamUserId}: ${reasonOf(error)}`);
    return fail(503, "store_unavailable", "加入申请查询暂不可用，请稍后重试。");
  }
}

/**
 * 审批（approve/reject/ignore）。不变量：
 *   ① 只有 owner/admin 可审批；
 *   ② 满员（名册成员数 ≥ seats 或 ≥ max_members 硬上限）时不得通过；
 *   ③ 申请人已在别的团队时不得通过（成员同时只能属一个团队，019 UNIQUE 为结构约束）；
 *   ④ 幂等：重放同一审批不产生第二次名册登记、不重复扣费（本路径完全不碰点数）。
 */
export async function decideJoinRequest(
  input: {
    teamUserId: number;
    actorUserId: number;
    requestId: string;
    decision: "approve" | "reject" | "ignore";
  },
  deps: TeamGovernanceDeps = {},
): Promise<GovernanceResult<{ requestId: string; status: JoinRequestStatus; memberUserId: number | null; unchanged: boolean }>> {
  if (!governanceStoreEnabled()) {
    return fail(503, "store_unavailable", "团队成员治理映射层不可用（控制面数据库未配置）。");
  }
  const nextStatus: JoinRequestStatus =
    input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "ignored";
  const sql = deps.sql ?? getGenerationSql();
  try {
    return await lockFor(deps, sql)(input.teamUserId, async (tx) => {
      const roster = await listTeamRoster(input.teamUserId, tx);
      const actor = resolveTeamActor({ userId: input.actorUserId, teamUserId: input.teamUserId, roster });
      if (!actor || !isTeamManager(actor.role)) {
        return fail<{ requestId: string; status: JoinRequestStatus; memberUserId: number | null; unchanged: boolean }>(403, "forbidden", "只有团队创建者或管理员可以审批加入申请。");
      }
      const rows = await tx<JoinRow[]>`
        SELECT id, team_user_id, applicant_user_id, applicant_member_key_id, display_name, status,
               created_at, decided_at, decided_by_user_id
        FROM team_join_request
        WHERE id = ${input.requestId} AND team_user_id = ${input.teamUserId}
        LIMIT 1
      `;
      const request = rows[0] ? mapJoinRow(rows[0]) : null;
      if (!request) {
        return fail<{ requestId: string; status: JoinRequestStatus; memberUserId: number | null; unchanged: boolean }>(404, "request_not_found", "未找到该加入申请。");
      }
      // 幂等：重放同一决定 = no-op（不再登记名册、不再改状态）。
      if (request.status === nextStatus) {
        return { ok: true, requestId: request.id, status: nextStatus, memberUserId: request.applicantUserId, unchanged: true };
      }
      if (input.decision !== "reject" && input.decision !== "ignore" && request.status !== "pending") {
        return fail<{ requestId: string; status: JoinRequestStatus; memberUserId: number | null; unchanged: boolean }>(409, "request_not_pending", `该申请当前状态为 ${request.status}，不可再批准。`);
      }
      if (request.status === "approved" && input.decision !== "approve") {
        return fail<{ requestId: string; status: JoinRequestStatus; memberUserId: number | null; unchanged: boolean }>(409, "request_not_pending", "该申请已通过，不可再驳回或忽略。");
      }

      if (input.decision === "approve") {
        const capacity = teamCapacity();
        const settings = await readTeamSettings(input.teamUserId, tx);
        const memberCount = roster.length;
        if (roster.some((entry) => entry.memberUserId === request.applicantUserId)) {
          return fail<{ requestId: string; status: JoinRequestStatus; memberUserId: number | null; unchanged: boolean }>(409, "already_member", "该申请人已是团队成员。");
        }
        // ② 满员不得通过（席位闸 + 硬上限双闸）。
        if (memberCount + 1 > settings.seats || memberCount + 1 > capacity.maxMembers) {
          return fail<{ requestId: string; status: JoinRequestStatus; memberUserId: number | null; unchanged: boolean }>(409, "team_full", `团队席位已满（当前 ${memberCount} 人，席位数 ${settings.seats}），请先扩容或腾出席位。`);
        }
        // ③ 成员同时只能属一个团队（配额桶模型 + 019 UNIQUE）。
        const joined = await countJoinedTeams(request.applicantUserId, tx);
        const limits = teamJoinLimits();
        if (joined >= limits.maxJoinedTeams) {
          return fail<{ requestId: string; status: JoinRequestStatus; memberUserId: number | null; unchanged: boolean }>(409, "joined_teams_limit", `该成员已达到可加入团队数上限 ${limits.maxJoinedTeams}。`);
        }
        if (joined > 0) {
          return fail<{ requestId: string; status: JoinRequestStatus; memberUserId: number | null; unchanged: boolean }>(409, "member_already_in_team", "该成员已归属其他团队，不可跨团队加入。");
        }
        // 名册登记走既有 upsertTeamMember（member-quota 的唯一登记通路），role 由 DDL 默认 member。
        await upsertTeamMember(
          {
            id: (deps.newId ?? randomUUID)(),
            teamUserId: input.teamUserId,
            memberUserId: request.applicantUserId,
            memberKeyId: request.applicantMemberKeyId,
            displayName: request.displayName,
            enabled: true,
          },
          tx,
        );
      }

      await tx`
        UPDATE team_join_request
        SET status = ${nextStatus}, decided_at = now(), decided_by_user_id = ${input.actorUserId}, updated_at = now()
        WHERE id = ${request.id} AND team_user_id = ${input.teamUserId}
      `;
      return {
        ok: true,
        requestId: request.id,
        status: nextStatus,
        memberUserId: input.decision === "approve" ? request.applicantUserId : null,
        unchanged: false,
      };
    });
  } catch (error) {
    console.error(`[team-governance] decideJoinRequest 失败 team=${input.teamUserId}: ${reasonOf(error)}`);
    return fail(503, "store_unavailable", "加入申请审批暂不可用，请稍后重试。");
  }
}
