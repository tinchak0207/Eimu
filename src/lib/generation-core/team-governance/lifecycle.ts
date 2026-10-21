import { getGenerationSql, type GenerationSql } from "../database";
import { allocateMemberQuota, readMemberQuota } from "../member-quota";
import { canManageRole, dissolutionDueAt, ownerCount, resolveTeamActor } from "./policies";
import { countRoster, fail, findRosterEntryByUserId, governanceStoreEnabled, listTeamRoster, lockFor, nowMs, readTeamSettings, reasonOf } from "./store";
import { HOUR_MS, teamDissolveCooloffMs, type GovernanceResult, type TeamGovernanceDeps, type TeamLifecycle } from "./types";

export async function getTeamLifecycle(
  teamUserId: number,
  deps: TeamGovernanceDeps = {},
): Promise<TeamLifecycle> {
  const sql = deps.sql ?? getGenerationSql();
  const settings = await readTeamSettings(teamUserId, sql);
  const roster = await listTeamRoster(teamUserId, sql);
  const dueMs = dissolutionDueAt(settings.dissolveScheduledAt);
  const now = nowMs(deps);
  return {
    teamUserId,
    memberCount: roster.length,
    dissolved: settings.dissolvedAt !== null,
    dissolvedAt: settings.dissolvedAt,
    dissolveScheduledAt: settings.dissolveScheduledAt,
    cooloffMs: teamDissolveCooloffMs(),
    due: dueMs !== null && settings.dissolvedAt === null && now >= dueMs,
    remainingMs: dueMs === null || settings.dissolvedAt !== null ? null : Math.max(0, dueMs - now),
  };
}

/** 排程解散（owner）。重放同一请求 = 幂等（不重置冷静期起点）。 */
export async function scheduleTeamDissolution(
  input: { teamUserId: number; actorUserId: number },
  deps: TeamGovernanceDeps = {},
): Promise<GovernanceResult<{ dissolveScheduledAt: string; cooloffHours: number; unchanged: boolean }>> {
  if (!governanceStoreEnabled()) {
    return fail(503, "store_unavailable", "团队成员治理映射层不可用（控制面数据库未配置）。");
  }
  const sql = deps.sql ?? getGenerationSql();
  try {
    return await lockFor(deps, sql)(input.teamUserId, async (tx) => {
      const roster = await listTeamRoster(input.teamUserId, tx);
      const actor = resolveTeamActor({ userId: input.actorUserId, teamUserId: input.teamUserId, roster });
      if (!actor || !actor.isOwner) {
        return fail<{ dissolveScheduledAt: string; cooloffHours: number; unchanged: boolean }>(403, "forbidden", "只有团队所有者可以解散团队。");
      }
      const current = await readTeamSettings(input.teamUserId, tx);
      if (current.dissolvedAt) {
        return fail<{ dissolveScheduledAt: string; cooloffHours: number; unchanged: boolean }>(409, "already_dissolved", "团队已解散。");
      }
      const cooloffMs = teamDissolveCooloffMs();
      if (current.dissolveScheduledAt) {
        return { ok: true, dissolveScheduledAt: current.dissolveScheduledAt, cooloffHours: cooloffMs / HOUR_MS, unchanged: true };
      }
      const scheduledAt = new Date(nowMs(deps) + cooloffMs).toISOString();
      await tx`
        INSERT INTO team_settings (team_user_id, member_create_canvas, seats, dissolve_scheduled_at)
        VALUES (${input.teamUserId}, ${current.memberCreateCanvas}, ${current.seats}, ${scheduledAt})
        ON CONFLICT (team_user_id) DO UPDATE SET dissolve_scheduled_at = EXCLUDED.dissolve_scheduled_at, updated_at = now()
      `;
      return { ok: true, dissolveScheduledAt: scheduledAt, cooloffHours: cooloffMs / HOUR_MS, unchanged: false };
    });
  } catch (error) {
    console.error(`[team-governance] scheduleTeamDissolution 失败 team=${input.teamUserId}: ${reasonOf(error)}`);
    return fail(503, "store_unavailable", "解散排程暂不可用，请稍后重试。");
  }
}

/** 冷静期内撤回解散（owner）。 */
export async function withdrawTeamDissolution(
  input: { teamUserId: number; actorUserId: number },
  deps: TeamGovernanceDeps = {},
): Promise<GovernanceResult<{ withdrawn: boolean }>> {
  if (!governanceStoreEnabled()) {
    return fail(503, "store_unavailable", "团队成员治理映射层不可用（控制面数据库未配置）。");
  }
  const sql = deps.sql ?? getGenerationSql();
  try {
    return await lockFor(deps, sql)(input.teamUserId, async (tx) => {
      const roster = await listTeamRoster(input.teamUserId, tx);
      const actor = resolveTeamActor({ userId: input.actorUserId, teamUserId: input.teamUserId, roster });
      if (!actor || !actor.isOwner) {
        return fail<{ withdrawn: boolean }>(403, "forbidden", "只有团队所有者可以撤回解散。");
      }
      const current = await readTeamSettings(input.teamUserId, tx);
      if (current.dissolvedAt) {
        return fail<{ withdrawn: boolean }>(409, "already_dissolved", "团队已解散，无法撤回。");
      }
      if (!current.dissolveScheduledAt) {
        return fail<{ withdrawn: boolean }>(409, "no_schedule", "团队未排程解散。");
      }
      const dueMs = dissolutionDueAt(current.dissolveScheduledAt);
      if (dueMs !== null && nowMs(deps) >= dueMs) {
        return fail<{ withdrawn: boolean }>(409, "cooloff_elapsed", "48 小时冷静期已过，无法撤回解散。");
      }
      await tx`
        UPDATE team_settings SET dissolve_scheduled_at = NULL, updated_at = now()
        WHERE team_user_id = ${input.teamUserId}
      `;
      return { ok: true, withdrawn: true };
    });
  } catch (error) {
    console.error(`[team-governance] withdrawTeamDissolution 失败 team=${input.teamUserId}: ${reasonOf(error)}`);
    return fail(503, "store_unavailable", "解散撤回暂不可用，请稍后重试。");
  }
}

/**
 * 执行解散（冷静期到期才生效，幂等）。意图层动作：名册成员一并停用
 * （令其单被既有预检按「成员已停用」拒），**不动任何点数**——成员桶里已转出的
 * 额度留在该 user，不自动回收（回收要走 member-quota 的 allocate，不在本函式）。
 */
export async function executeTeamDissolution(
  input: { teamUserId: number },
  deps: TeamGovernanceDeps = {},
): Promise<GovernanceResult<{ executed: boolean; reason?: string; membersDisabled: number }>> {
  if (!governanceStoreEnabled()) {
    return fail(503, "store_unavailable", "团队成员治理映射层不可用（控制面数据库未配置）。");
  }
  const sql = deps.sql ?? getGenerationSql();
  try {
    return await lockFor(deps, sql)(input.teamUserId, async (tx) => {
      const current = await readTeamSettings(input.teamUserId, tx);
      if (current.dissolvedAt) {
        return { ok: true, executed: false, reason: "already_dissolved", membersDisabled: 0 };
      }
      const dueMs = dissolutionDueAt(current.dissolveScheduledAt);
      if (dueMs === null) {
        return { ok: true, executed: false, reason: "not_scheduled", membersDisabled: 0 };
      }
      if (nowMs(deps) < dueMs) {
        return { ok: true, executed: false, reason: "cooloff_pending", membersDisabled: 0 };
      }
      const roster = await listTeamRoster(input.teamUserId, tx);
      await tx`
        UPDATE team_member_quota SET enabled = false, updated_at = now()
        WHERE team_user_id = ${input.teamUserId}
      `;
      await tx`
        UPDATE team_settings SET dissolved_at = now(), dissolve_scheduled_at = NULL, updated_at = now()
        WHERE team_user_id = ${input.teamUserId}
      `;
      return { ok: true, executed: true, membersDisabled: roster.length };
    });
  } catch (error) {
    console.error(`[team-governance] executeTeamDissolution 失败 team=${input.teamUserId}: ${reasonOf(error)}`);
    return fail(503, "store_unavailable", "解散执行暂不可用，请稍后重试。");
  }
}

/** 退出团队（成员侧）。最后一个 owner（= 团队主帐）不可直接退出。 */
export async function leaveTeam(
  input: { actorUserId: number },
  deps: TeamGovernanceDeps = {},
): Promise<GovernanceResult<{ teamUserId: number; memberUserId: number; left: boolean }>> {
  if (!governanceStoreEnabled()) {
    return fail(503, "store_unavailable", "团队成员治理映射层不可用（控制面数据库未配置）。");
  }
  const sql = deps.sql ?? getGenerationSql();
  try {
    const self = await findRosterEntryByUserId(input.actorUserId, sql);
    if (!self) {
      // 名册里没有这个 user：可能是团队主帐（owner）——主帐不可「退出」，须先转移或解散。
      const owns = await countRoster(input.actorUserId, sql);
      if (owns > 0) {
        return fail<{ teamUserId: number; memberUserId: number; left: boolean }>(409, "last_owner", "团队主账号是最后一位所有者，不能直接退出；请先转移所有权或解散团队。");
      }
      return fail<{ teamUserId: number; memberUserId: number; left: boolean }>(404, "not_a_member", "你不是任何团队的成员。");
    }
    return await lockFor(deps, sql)(self.teamUserId, async (tx) => {
      const roster = await listTeamRoster(self.teamUserId, tx);
      const mine = roster.find((entry) => entry.memberUserId === input.actorUserId);
      if (!mine) {
        return fail<{ teamUserId: number; memberUserId: number; left: boolean }>(404, "not_a_member", "你不是该团队成员。");
      }
      if (mine.role === "owner" && ownerCount(self.teamUserId, roster) <= 1) {
        return fail<{ teamUserId: number; memberUserId: number; left: boolean }>(409, "last_owner", "你是团队最后一位所有者，不能直接退出；请先转移所有权或解散团队。");
      }
      await tx`
        DELETE FROM team_member_quota WHERE team_user_id = ${self.teamUserId} AND member_user_id = ${input.actorUserId}
      `;
      return { ok: true, teamUserId: self.teamUserId, memberUserId: input.actorUserId, left: true };
    });
  } catch (error) {
    console.error(`[team-governance] leaveTeam 失败 user=${input.actorUserId}: ${reasonOf(error)}`);
    return fail(503, "store_unavailable", "退出团队暂不可用，请稍后重试。");
  }
}

/** 移除成员（管理侧）。不变量同角色变更：不可移除最后一个 owner（团队主帐）。 */
export async function removeTeamMember(
  input: { teamUserId: number; actorUserId: number; memberKeyId: string },
  deps: TeamGovernanceDeps = {},
): Promise<GovernanceResult<{ memberUserId: number; removed: boolean }>> {
  if (!governanceStoreEnabled()) {
    return fail(503, "store_unavailable", "团队成员治理映射层不可用（控制面数据库未配置）。");
  }
  const sql = deps.sql ?? getGenerationSql();
  try {
    return await lockFor(deps, sql)(input.teamUserId, async (tx) => {
      const roster = await listTeamRoster(input.teamUserId, tx);
      const actor = resolveTeamActor({ userId: input.actorUserId, teamUserId: input.teamUserId, roster });
      if (!actor) {
        return fail<{ memberUserId: number; removed: boolean }>(403, "forbidden", "你不是该团队成员，无权移除成员。");
      }
      const target = roster.find((entry) => entry.memberKeyId === input.memberKeyId);
      if (!target) {
        return fail<{ memberUserId: number; removed: boolean }>(404, "member_not_found", `未找到成员密钥 ${input.memberKeyId} 对应的团队成员。`);
      }
      if (target.memberUserId === input.teamUserId) {
        return fail<{ memberUserId: number; removed: boolean }>(409, "last_owner", "团队主账号是所有者的最后一位，不能移除。");
      }
      if (target.role === "owner" && ownerCount(input.teamUserId, roster) <= 1) {
        return fail<{ memberUserId: number; removed: boolean }>(409, "last_owner", "团队至少需要一个所有者，不能移除最后一位所有者。");
      }
      if (!canManageRole(actor, target, "member")) {
        return fail<{ memberUserId: number; removed: boolean }>(403, "forbidden", "你的角色无权移除该成员。");
      }
      const snapshot = await readMemberQuota(target.memberUserId);
      if (!snapshot) {
        return fail<{ memberUserId: number; removed: boolean }>(503, "store_unavailable", "成员剩余额度读不到，已停止移除。");
      }
      if (snapshot.remaining > 0) {
        const reclaimed = await allocateMemberQuota(
          {
            teamUserId: input.teamUserId,
            memberKeyId: target.memberKeyId,
            targetGranted: snapshot.used,
          },
          { sql: tx, withTeamLock: async (_teamUserId, fn) => fn(tx) },
        );
        if (!reclaimed.ok) {
          const status = reclaimed.status === 400 || reclaimed.status === 403 || reclaimed.status === 404 || reclaimed.status === 409
            ? reclaimed.status
            : 503;
          return fail<{ memberUserId: number; removed: boolean }>(status, "store_unavailable", "成员剩余额度退回失败，未移除该成员。");
        }
      }
      await tx`
        DELETE FROM team_member_quota WHERE team_user_id = ${input.teamUserId} AND member_user_id = ${target.memberUserId}
      `;
      return { ok: true, memberUserId: target.memberUserId, removed: true };
    });
  } catch (error) {
    console.error(`[team-governance] removeTeamMember 失败 team=${input.teamUserId}: ${reasonOf(error)}`);
    return fail(503, "store_unavailable", "移除成员暂不可用，请稍后重试。");
  }
}
