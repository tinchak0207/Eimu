import { getGenerationSql, type GenerationSql } from "../database";
import { fail, findRosterEntryByUserId, governanceStoreEnabled, listTeamRoster, lockFor, readTeamSettings, reasonOf } from "./store";
import { canCreateSharedCanvas, canManageRole, isTeamManager, ownerCount, resolveTeamActor } from "./policies";
import type { CanvasPermission, GovernanceResult, TeamGovernanceDeps, TeamRole } from "./types";
import { isTeamRole } from "./types";
import { teamCapacity } from "./types";

// ─────────────────────────────────────────── 面 1：角色

export async function setMemberRole(
  input: { teamUserId: number; actorUserId: number; memberKeyId: string; role: TeamRole },
  deps: TeamGovernanceDeps = {},
): Promise<GovernanceResult<{ memberUserId: number; role: TeamRole; unchanged: boolean }>> {
  if (!governanceStoreEnabled()) {
    return fail(503, "store_unavailable", "团队成员治理映射层不可用（控制面数据库未配置）。");
  }
  if (!isTeamRole(input.role)) {
    return fail(400, "invalid_role", "role 必须是 owner、admin 或 member。");
  }
  const sql = deps.sql ?? getGenerationSql();
  try {
    return await lockFor(deps, sql)(input.teamUserId, async (tx) => {
      const roster = await listTeamRoster(input.teamUserId, tx);
      const actor = resolveTeamActor({ userId: input.actorUserId, teamUserId: input.teamUserId, roster });
      if (!actor) return fail<{ memberUserId: number; role: TeamRole; unchanged: boolean }>(403, "forbidden", "你不是该团队成员，无权变更角色。");
      const target = roster.find((entry) => entry.memberKeyId === input.memberKeyId);
      if (!target) {
        return fail<{ memberUserId: number; role: TeamRole; unchanged: boolean }>(404, "member_not_found", `未找到成员密钥 ${input.memberKeyId} 对应的团队成员。`);
      }
      // 最后一个 owner：团队主帐恒为 owner，任何针对它的降级/移除一律拒。
      if (target.memberUserId === input.teamUserId) {
        return fail<{ memberUserId: number; role: TeamRole; unchanged: boolean }>(409, "last_owner", "团队主账号是所有者的最后一位，不能降级或移除。");
      }
      if (target.role === "owner" && input.role !== "owner" && ownerCount(input.teamUserId, roster) <= 1) {
        return fail<{ memberUserId: number; role: TeamRole; unchanged: boolean }>(409, "last_owner", "团队至少需要一个所有者，不能移除最后一位所有者。");
      }
      if (!canManageRole(actor, target, input.role)) {
        return fail<{ memberUserId: number; role: TeamRole; unchanged: boolean }>(403, "forbidden", "你的角色无权变更该成员的角色。");
      }
      if (target.role === input.role) {
        return { ok: true, memberUserId: target.memberUserId, role: input.role, unchanged: true };
      }
      await tx`
        UPDATE team_member_quota SET role = ${input.role}, updated_at = now()
        WHERE team_user_id = ${input.teamUserId} AND member_user_id = ${target.memberUserId}
      `;
      return { ok: true, memberUserId: target.memberUserId, role: input.role, unchanged: false };
    });
  } catch (error) {
    console.error(`[team-governance] setMemberRole 失败 team=${input.teamUserId}: ${reasonOf(error)}`);
    return fail(503, "store_unavailable", "团队成员治理暂不可用，请稍后重试。");
  }
}

// ─────────────────────────────────────────── 面 2：建画布权限开关

export async function updateTeamSettings(
  input: { teamUserId: number; actorUserId: number; memberCreateCanvas?: boolean },
  deps: TeamGovernanceDeps = {},
): Promise<GovernanceResult<{ memberCreateCanvas: boolean; unchanged: boolean }>> {
  if (!governanceStoreEnabled()) {
    return fail(503, "store_unavailable", "团队成员治理映射层不可用（控制面数据库未配置）。");
  }
  const sql = deps.sql ?? getGenerationSql();
  try {
    return await lockFor(deps, sql)(input.teamUserId, async (tx) => {
      const roster = await listTeamRoster(input.teamUserId, tx);
      const actor = resolveTeamActor({ userId: input.actorUserId, teamUserId: input.teamUserId, roster });
      if (!actor || !isTeamManager(actor.role)) {
        return fail<{ memberCreateCanvas: boolean; unchanged: boolean }>(403, "forbidden", "只有团队创建者或管理员可以修改团队设置。");
      }
      const current = await readTeamSettings(input.teamUserId, tx);
      const next = input.memberCreateCanvas === undefined ? current.memberCreateCanvas : input.memberCreateCanvas === true;
      if (next === current.memberCreateCanvas) {
        return { ok: true, memberCreateCanvas: next, unchanged: true };
      }
      await tx`
        INSERT INTO team_settings (team_user_id, member_create_canvas, seats)
        VALUES (${input.teamUserId}, ${next}, ${current.seats})
        ON CONFLICT (team_user_id) DO UPDATE SET
          member_create_canvas = EXCLUDED.member_create_canvas,
          updated_at = now()
      `;
      return { ok: true, memberCreateCanvas: next, unchanged: false };
    });
  } catch (error) {
    console.error(`[team-governance] updateTeamSettings 失败 team=${input.teamUserId}: ${reasonOf(error)}`);
    return fail(503, "store_unavailable", "团队设置修改暂不可用，请稍后重试。");
  }
}

// ─────────────────────────────────────────── 面 5：席位

export async function setTeamSeats(
  input: { teamUserId: number; actorUserId: number; seats: number },
  deps: TeamGovernanceDeps = {},
): Promise<GovernanceResult<{ seats: number; memberCount: number; unchanged: boolean }>> {
  if (!governanceStoreEnabled()) {
    return fail(503, "store_unavailable", "团队成员治理映射层不可用（控制面数据库未配置）。");
  }
  const seats = Math.trunc(Number(input.seats));
  if (!Number.isFinite(seats) || seats <= 0) {
    return fail(400, "invalid_seats", "席位数必须是正整数。");
  }
  const capacity = teamCapacity();
  const sql = deps.sql ?? getGenerationSql();
  try {
    return await lockFor(deps, sql)(input.teamUserId, async (tx) => {
      const roster = await listTeamRoster(input.teamUserId, tx);
      const actor = resolveTeamActor({ userId: input.actorUserId, teamUserId: input.teamUserId, roster });
      if (!actor || !actor.isOwner) {
        return fail<{ seats: number; memberCount: number; unchanged: boolean }>(403, "forbidden", "只有团队所有者可以调整席位数。");
      }
      const memberCount = roster.length;
      if (seats < capacity.minMembers) {
        return fail<{ seats: number; memberCount: number; unchanged: boolean }>(409, "seats_below_minimum", `席位数不得低于团队最小容量 ${capacity.minMembers}。`);
      }
      if (seats > capacity.maxMembers) {
        return fail<{ seats: number; memberCount: number; unchanged: boolean }>(409, "seats_above_maximum", `席位数不得超过团队硬上限 ${capacity.maxMembers}。`);
      }
      if (seats < memberCount) {
        return fail<{ seats: number; memberCount: number; unchanged: boolean }>(409, "seats_below_members", `席位数不得低于现有成员数 ${memberCount}。`);
      }
      const current = await readTeamSettings(input.teamUserId, tx);
      if (current.seats === seats) {
        return { ok: true, seats, memberCount, unchanged: true };
      }
      await tx`
        INSERT INTO team_settings (team_user_id, member_create_canvas, seats)
        VALUES (${input.teamUserId}, ${current.memberCreateCanvas}, ${seats})
        ON CONFLICT (team_user_id) DO UPDATE SET
          seats = EXCLUDED.seats,
          updated_at = now()
      `;
      return { ok: true, seats, memberCount, unchanged: false };
    });
  } catch (error) {
    console.error(`[team-governance] setTeamSeats 失败 team=${input.teamUserId}: ${reasonOf(error)}`);
    return fail(503, "store_unavailable", "席位调整暂不可用，请稍后重试。");
  }
}
// ─────────────────────────────────────────── 面 2（续）：成员建画布闸

/**
 * 成员侧建共享画布闸：呼叫方（billingUserId）若不是受管成员 → 放行（不受此闸）；
 * 是成员 → owner/admin 放行，member 依团队开关。控制面未配置时放行（无治理层）。
 */
export async function canMemberCreateSharedCanvas(
  billingUserId: number,
  deps: { sql?: GenerationSql } = {},
): Promise<CanvasPermission> {
  if (!governanceStoreEnabled()) {
    return { allowed: true, message: "", teamUserId: null, role: null };
  }
  try {
    const entry = await findRosterEntryByUserId(billingUserId, deps.sql);
    if (!entry) return { allowed: true, message: "", teamUserId: null, role: null };
    const settings = await readTeamSettings(entry.teamUserId, deps.sql);
    const decision = canCreateSharedCanvas({
      actor: { role: entry.role },
      memberCreateCanvas: settings.memberCreateCanvas,
    });
    return { ...decision, teamUserId: entry.teamUserId, role: entry.role };
  } catch (error) {
    // 读不到治理层不挡创作（与既有降级一致；点数闸仍由预检 fail-closed 执法）。
    console.error(`[team-governance] canMemberCreateSharedCanvas 降级放行 user=${billingUserId}: ${reasonOf(error)}`);
    return { allowed: true, message: "", teamUserId: null, role: null };
  }
}
