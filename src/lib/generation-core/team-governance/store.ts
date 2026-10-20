import { generationControlPlaneEnabled, getGenerationSql, type GenerationSql } from "../database";
import type { TeamLock } from "../member-quota";
import { mapRosterRow, mapSettingsRow, type GovernanceCode, type GovernanceFailure, type GovernanceResult, type RosterRow, type SettingsRow, type TeamGovernanceDeps, type TeamRosterEntry, type TeamRole, type TeamSettingsRecord, teamCapacity } from "./types";

export function governanceStoreEnabled(): boolean {
  return generationControlPlaneEnabled();
}
// ─────────────────────────────────────────── 映射层存取（唯读名册/设定）

export async function listTeamRoster(teamUserId: number, sql?: GenerationSql): Promise<TeamRosterEntry[]> {
  if (!governanceStoreEnabled()) return [];
  const db = sql ?? getGenerationSql();
  const rows = await db<RosterRow[]>`
    SELECT id, team_user_id, member_user_id, member_key_id, display_name, enabled, role
    FROM team_member_quota
    WHERE team_user_id = ${teamUserId}
    ORDER BY created_at ASC
  `;
  return rows.map(mapRosterRow);
}

/** 成员侧查自己的团队与角色（治理闸的入口）。 */
export async function findRosterEntryByUserId(
  memberUserId: number,
  sql?: GenerationSql,
): Promise<TeamRosterEntry | null> {
  if (!governanceStoreEnabled()) return null;
  const db = sql ?? getGenerationSql();
  const rows = await db<RosterRow[]>`
    SELECT id, team_user_id, member_user_id, member_key_id, display_name, enabled, role
    FROM team_member_quota
    WHERE member_user_id = ${memberUserId}
    LIMIT 1
  `;
  return rows[0] ? mapRosterRow(rows[0]) : null;
}

/** 呼叫方的治理归属：名册成员 → 其团队；主帐（无名册列）→ 自己（owner）。 */
export async function resolveActorTeam(
  actorUserId: number,
  sql?: GenerationSql,
): Promise<{ teamUserId: number; role: TeamRole; isMember: boolean }> {
  const row = await findRosterEntryByUserId(actorUserId, sql);
  if (row) return { teamUserId: row.teamUserId, role: row.role, isMember: true };
  return { teamUserId: actorUserId, role: "owner", isMember: false };
}

export async function countRoster(teamUserId: number, sql: GenerationSql): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM team_member_quota WHERE team_user_id = ${teamUserId}
  `;
  return Number(rows[0]?.count ?? 0);
}

/** 该 user 已加入的团队数（019 的 UNIQUE(member_user_id) 使其结构上 ≤ 1）。 */
export async function countJoinedTeams(memberUserId: number, sql?: GenerationSql): Promise<number> {
  if (!governanceStoreEnabled()) return 0;
  const db = sql ?? getGenerationSql();
  const rows = await db<{ count: number }[]>`
    SELECT count(*)::int AS count FROM team_member_quota WHERE member_user_id = ${memberUserId}
  `;
  return Number(rows[0]?.count ?? 0);
}

/** 该 user 已拥有的团队数 = 自己的主帐团队(1) + 名册 owner 列。 */
export async function countOwnedTeams(userId: number, sql?: GenerationSql): Promise<number> {
  if (!governanceStoreEnabled()) return 0;
  const db = sql ?? getGenerationSql();
  const rows = await db<{ count: number }[]>`
    SELECT count(*)::int AS count FROM team_member_quota
    WHERE member_user_id = ${userId} AND role = 'owner'
  `;
  return 1 + Number(rows[0]?.count ?? 0);
}
/** 未写过设定的团队拿到「默认意图」（不落库、不产生副作用）。 */
export function defaultTeamSettings(teamUserId: number): TeamSettingsRecord {
  return {
    teamUserId,
    memberCreateCanvas: false,
    seats: teamCapacity().defaultMaxMembers,
    dissolveScheduledAt: null,
    dissolvedAt: null,
  };
}

export async function readTeamSettings(teamUserId: number, sql?: GenerationSql): Promise<TeamSettingsRecord> {
  if (!governanceStoreEnabled()) return defaultTeamSettings(teamUserId);
  const db = sql ?? getGenerationSql();
  const rows = await db<SettingsRow[]>`
    SELECT team_user_id, member_create_canvas, seats, dissolve_scheduled_at, dissolved_at
    FROM team_settings
    WHERE team_user_id = ${teamUserId}
    LIMIT 1
  `;
  return rows[0] ? mapSettingsRow(rows[0]) : defaultTeamSettings(teamUserId);
}
export function fail<T>(
  status: GovernanceFailure["status"],
  code: GovernanceCode,
  message: string,
): GovernanceResult<T> {
  return { ok: false, status, code, message };
}

export function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** 与 member-quota 同一把团队锁：治理写入与配额分配互相串行化。 */
async function defaultGovernanceLock<T>(
  sql: GenerationSql,
  teamUserId: number,
  fn: (tx: GenerationSql) => Promise<T>,
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`team-member-quota:${teamUserId}`}))`;
    return await fn(tx as unknown as GenerationSql);
  })) as T;
}
export function lockFor(deps: TeamGovernanceDeps, sql: GenerationSql): TeamLock {
  return deps.withTeamLock ?? ((teamUserId, fn) => defaultGovernanceLock(sql, teamUserId, fn));
}

export function nowMs(deps: TeamGovernanceDeps): number {
  return (deps.now ?? Date.now)();
}
