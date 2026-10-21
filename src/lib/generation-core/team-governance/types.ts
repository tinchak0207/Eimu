import type { GenerationSql } from "../database";
import type { TeamLock } from "../member-quota";

// ─────────────────────────────────────────── 配置（常量可调，不硬编）

export const TEAM_CAPACITY_ENV = {
  minMembers: "TEAM_MIN_MEMBERS",
  defaultMaxMembers: "TEAM_DEFAULT_MAX_MEMBERS",
  maxMembers: "TEAM_MAX_MEMBERS",
  maxOwnedTeams: "TEAM_MAX_OWNED_TEAMS",
  maxJoinedTeams: "TEAM_MAX_JOINED_TEAMS",
  dissolveCooloffHours: "TEAM_DISSOLVE_COOLOFF_HOURS",
} as const;

/** 与竞品可对标的默认容量语义（常量放 config 可调，见 teamCapacity()）。 */
export const TEAM_MIN_MEMBERS_DEFAULT = 2;
export const TEAM_DEFAULT_MAX_MEMBERS_DEFAULT = 10;
export const TEAM_MAX_MEMBERS_DEFAULT = 200;
export const TEAM_MAX_OWNED_TEAMS_DEFAULT = 5;
export const TEAM_MAX_JOINED_TEAMS_DEFAULT = 5;
export const TEAM_DISSOLVE_COOLOFF_HOURS_DEFAULT = 48;
export const HOUR_MS = 3_600_000;

export interface TeamCapacity {
  minMembers: number;
  defaultMaxMembers: number;
  maxMembers: number;
}

function envInt(
  name: string,
  fallback: number,
  bounds: { min: number; max: number },
  env: Record<string, string | undefined>,
): number {
  const raw = env[name];
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

export function teamCapacity(env: Record<string, string | undefined> = process.env): TeamCapacity {
  const minMembers = envInt(TEAM_CAPACITY_ENV.minMembers, TEAM_MIN_MEMBERS_DEFAULT, { min: 1, max: 100 }, env);
  const maxMembers = envInt(TEAM_CAPACITY_ENV.maxMembers, TEAM_MAX_MEMBERS_DEFAULT, { min: minMembers, max: 10_000 }, env);
  const defaultMaxMembers = envInt(TEAM_CAPACITY_ENV.defaultMaxMembers, TEAM_DEFAULT_MAX_MEMBERS_DEFAULT, {
    min: minMembers,
    max: maxMembers,
  }, env);
  return { minMembers, defaultMaxMembers, maxMembers };
}

export interface TeamJoinLimits {
  maxOwnedTeams: number;
  maxJoinedTeams: number;
}

export function teamJoinLimits(env: Record<string, string | undefined> = process.env): TeamJoinLimits {
  return {
    maxOwnedTeams: envInt(TEAM_CAPACITY_ENV.maxOwnedTeams, TEAM_MAX_OWNED_TEAMS_DEFAULT, { min: 1, max: 100 }, env),
    maxJoinedTeams: envInt(TEAM_CAPACITY_ENV.maxJoinedTeams, TEAM_MAX_JOINED_TEAMS_DEFAULT, { min: 1, max: 100 }, env),
  };
}

export function teamDissolveCooloffMs(env: Record<string, string | undefined> = process.env): number {
  return envInt(TEAM_CAPACITY_ENV.dissolveCooloffHours, TEAM_DISSOLVE_COOLOFF_HOURS_DEFAULT, { min: 1, max: 8760 }, env) * HOUR_MS;
}
// ─────────────────────────────────────────── 角色与权限
export type TeamRole = "owner" | "admin" | "member";
export const TEAM_ROLES: readonly TeamRole[] = ["owner", "admin", "member"];

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === "string" && (TEAM_ROLES as readonly string[]).includes(value);
}

export interface TeamRosterEntry {
  id: string;
  teamUserId: number;
  memberUserId: number;
  memberKeyId: string;
  displayName: string;
  enabled: boolean;
  role: TeamRole;
}

export type RosterRow = {
  id: string;
  team_user_id: number;
  member_user_id: number;
  member_key_id: string;
  display_name: string | null;
  enabled: boolean;
  role: string | null;
};

export function mapRosterRow(row: RosterRow): TeamRosterEntry {
  return {
    id: row.id,
    teamUserId: Number(row.team_user_id),
    memberUserId: Number(row.member_user_id),
    memberKeyId: row.member_key_id,
    displayName: row.display_name ?? "",
    enabled: row.enabled !== false,
    // 023 之前的列没有 role ⇒ 默认 member（不把缺栏位读成 owner）。
    role: isTeamRole(row.role) ? row.role : "member",
  };
}

/** 团队 actor 的有效角色。null = 与此团队无治理关系（外人）。 */
export interface TeamActor {
  userId: number;
  teamUserId: number;
  role: TeamRole;
  isOwner: boolean;
  /** true = 名册成员；false = 团队主帐（owner，不在名册）。 */
  isMember: boolean;
}
export interface CanvasPermission {
  allowed: boolean;
  code?: string;
  message: string;
  /** 命中的团队（null = 呼叫方不是任何团队的受管成员，不受此闸）。 */
  teamUserId: number | null;
  role: TeamRole | null;
}
// ── 团队设定（意图层）

export interface TeamSettingsRecord {
  teamUserId: number;
  memberCreateCanvas: boolean;
  seats: number;
  dissolveScheduledAt: string | null;
  dissolvedAt: string | null;
}

export type SettingsRow = {
  team_user_id: number;
  member_create_canvas: boolean;
  seats: number;
  dissolve_scheduled_at: Date | string | null;
  dissolved_at: Date | string | null;
};

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function mapSettingsRow(row: SettingsRow): TeamSettingsRecord {
  return {
    teamUserId: Number(row.team_user_id),
    memberCreateCanvas: row.member_create_canvas === true,
    seats: Number(row.seats),
    dissolveScheduledAt: toIso(row.dissolve_scheduled_at),
    dissolvedAt: toIso(row.dissolved_at),
  };
}
// ─────────────────────────────────────────── 结果型

export type GovernanceCode =
  | "store_unavailable"
  | "forbidden"
  | "invalid_role"
  | "invalid_seats"
  | "seats_below_members"
  | "seats_below_minimum"
  | "seats_above_maximum"
  | "last_owner"
  | "member_not_found"
  | "not_a_member"
  | "already_member"
  | "member_already_in_team"
  | "joined_teams_limit"
  | "cannot_join_own_team"
  | "request_not_found"
  | "request_not_pending"
  | "team_full"
  | "already_dissolved"
  | "no_schedule"
  | "cooloff_elapsed";

export interface GovernanceFailure {
  ok: false;
  status: 400 | 403 | 404 | 409 | 503;
  code: GovernanceCode;
  message: string;
}

export type GovernanceResult<T> = ({ ok: true } & T) | GovernanceFailure;
export interface TeamGovernanceDeps {
  sql?: GenerationSql;
  withTeamLock?: TeamLock;
  newId?: () => string;
  now?: () => number;
}
export type JoinRequestStatus = "pending" | "approved" | "rejected" | "ignored";
export const JOIN_REQUEST_STATUSES: readonly JoinRequestStatus[] = ["pending", "approved", "rejected", "ignored"];

export interface TeamJoinRequestRecord {
  id: string;
  teamUserId: number;
  applicantUserId: number;
  applicantMemberKeyId: string;
  displayName: string;
  status: JoinRequestStatus;
  createdAt: string | null;
  decidedAt: string | null;
  decidedByUserId: number | null;
}

export type JoinRow = {
  id: string;
  team_user_id: number;
  applicant_user_id: number;
  applicant_member_key_id: string;
  display_name: string | null;
  status: string;
  created_at: Date | string | null;
  decided_at: Date | string | null;
  decided_by_user_id: number | null;
};

export function mapJoinRow(row: JoinRow): TeamJoinRequestRecord {
  return {
    id: row.id,
    teamUserId: Number(row.team_user_id),
    applicantUserId: Number(row.applicant_user_id),
    applicantMemberKeyId: row.applicant_member_key_id,
    displayName: row.display_name ?? "",
    status: (JOIN_REQUEST_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as JoinRequestStatus)
      : "pending",
    createdAt: toIso(row.created_at),
    decidedAt: toIso(row.decided_at),
    decidedByUserId: row.decided_by_user_id === null || row.decided_by_user_id === undefined ? null : Number(row.decided_by_user_id),
  };
}
// ─────────────────────────────────────────── 面 4：生命周期

export interface TeamLifecycle {
  teamUserId: number;
  memberCount: number;
  dissolved: boolean;
  dissolvedAt: string | null;
  dissolveScheduledAt: string | null;
  cooloffMs: number;
  /** 冷静期是否已过（到期即为「应执行」）。 */
  due: boolean;
  /** 距离可执行还剩多少毫秒（未排程 = null）。 */
  remainingMs: number | null;
}
export interface TeamUsageRecord {
  id: string;
  userId: number;
  entryType: string;
  amount: number;
  amountCoins: number;
  source: string;
  sourceRef: string;
  jobId: string | null;
  operationId: string | null;
  createdAt: string | null;
}

export interface TeamMemberUsage {
  memberKeyId: string;
  memberUserId: number;
  displayName: string;
  role: TeamRole;
  enabled: boolean;
  granted: number;
  used: number;
  remaining: number;
  coins: { granted: number; used: number; remaining: number };
  unavailable: boolean;
  records: TeamUsageRecord[];
}

export interface TeamUsageSummary {
  teamUserId: number;
  seats: number;
  memberCount: number;
  capacity: TeamCapacity;
  totals: { granted: number; used: number; remaining: number; coins: { granted: number; used: number; remaining: number } };
  /**
   * 守恒检验（沿用 member-quota 已宣告的不变量）：
   *   主帐手上余额 + Σ 成员桶剩余 = 团队未消耗总额；consumed = Σ成员已用。
   */
  conservation: {
    masterRemaining: number;
    membersRemaining: number;
    teamRemaining: number;
    consumed: number;
    balanced: boolean;
    formula: string;
  };
  members: TeamMemberUsage[];
  records: TeamUsageRecord[];
}
