// 團隊治理六面（席位／角色／建畫布權限／加入審批／生命週期／用量）。
//
// 定性：**在既有團隊真源上長**，不新建第二套團隊模型（見 db/migrations/023）。
//   團隊身份 = team_user_id（= 團隊主 B key 的 biz_api_key.user_id = new-api users.id）
//   成員名冊 = team_member_quota（019）＋ role 欄（023）
//   配額真源 = new-api（users.quota）；本模組**不碰任何點數數字**，
//   也**不呼叫任何上游額度調整**——分配/回收唯一通路是 member-quota.ts（禁影子帳本）。
//
// 分工：
//   - member-quota.ts：配額映射與轉移（唯一權威）。本模組不重寫它，只讀名冊與配額可視面。
//   - account-ledger.ts：用量統計的逐筆來源（讀既有帳本，不新建統計帳本）。
//   - 本模組：身份與意圖（role / member_create_canvas / seats / 申請四態 / 解散冷靜期）。
//
// 角色模型（與 member-quota 的 user 層模型一致）：
//   ★ 團隊主帳 team_user_id 恆為 owner，且不入名冊（019 CHECK 禁止 member 名冊含主帳）。
//   ★ 名冊 role = owner（共同所有者）/ admin / member；owner 集合恆非空
//     ⇒ 「移除/降級團隊主帳」被 409 last_owner 拒（最後一個 owner 保護）。
//
// 不變量：
//   ① 不可移除/降級最後一個 owner（團隊主帳不可被移除、不可 leave）。
//   ② min_members ≤ 名冊成員數 ≤ seats ≤ max_members(硬上限)；滿員時申請不得通過。
//   ③ 48h 解散冷靜期內可撤回；冷靜期過後不可撤回，執行才生效且幂等。
//   ④ 所有寫入幂等：重放同請求不產生第二次副作用、不重複登記、不重複扣費。
//   ⑤ 審批/角色/席位/解散全路徑不觸碰點數（無上游調整呼叫）⇒ 無影子帳本、無重複扣費。

import { randomUUID } from "node:crypto";

import type { fetchGatewayUser } from "@/lib/gateway-admin";

import { readAccountLedger, type LedgerEntry } from "./account-ledger";
import { generationControlPlaneEnabled, getGenerationSql, type GenerationSql } from "./database";
import { readTeamQuotaView, toCoins, upsertTeamMember, type TeamLock } from "./member-quota";

// ─────────────────────────────────────────── 配置（常量可調，不硬編）

export const TEAM_CAPACITY_ENV = {
  minMembers: "TEAM_MIN_MEMBERS",
  defaultMaxMembers: "TEAM_DEFAULT_MAX_MEMBERS",
  maxMembers: "TEAM_MAX_MEMBERS",
  maxOwnedTeams: "TEAM_MAX_OWNED_TEAMS",
  maxJoinedTeams: "TEAM_MAX_JOINED_TEAMS",
  dissolveCooloffHours: "TEAM_DISSOLVE_COOLOFF_HOURS",
} as const;

/** 與競品可對標的默認容量語義（常量放 config 可調，見 teamCapacity()）。 */
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

function governanceStoreEnabled(): boolean {
  return generationControlPlaneEnabled();
}

// ─────────────────────────────────────────── 角色與權限

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

type RosterRow = {
  id: string;
  team_user_id: number;
  member_user_id: number;
  member_key_id: string;
  display_name: string | null;
  enabled: boolean;
  role: string | null;
};

function mapRosterRow(row: RosterRow): TeamRosterEntry {
  return {
    id: row.id,
    teamUserId: Number(row.team_user_id),
    memberUserId: Number(row.member_user_id),
    memberKeyId: row.member_key_id,
    displayName: row.display_name ?? "",
    enabled: row.enabled !== false,
    // 023 之前的列沒有 role ⇒ 默認 member（不把缺欄位讀成 owner）。
    role: isTeamRole(row.role) ? row.role : "member",
  };
}

/** 團隊 actor 的有效角色。null = 與此團隊無治理關係（外人）。 */
export interface TeamActor {
  userId: number;
  teamUserId: number;
  role: TeamRole;
  isOwner: boolean;
  /** true = 名冊成員；false = 團隊主帳（owner，不在名冊）。 */
  isMember: boolean;
}

export function resolveTeamActor(input: {
  userId: number;
  teamUserId: number;
  roster: Pick<TeamRosterEntry, "memberUserId" | "role">[];
}): TeamActor | null {
  if (input.userId === input.teamUserId) {
    return { userId: input.userId, teamUserId: input.teamUserId, role: "owner", isOwner: true, isMember: false };
  }
  const row = input.roster.find((entry) => entry.memberUserId === input.userId);
  if (!row) return null;
  return {
    userId: input.userId,
    teamUserId: input.teamUserId,
    role: row.role,
    isOwner: row.role === "owner",
    isMember: true,
  };
}

export function isTeamManager(role: TeamRole): boolean {
  return role === "owner" || role === "admin";
}

/**
 * 角色變更授權（純函式）：
 *   owner → 可改他人（任何角色）；admin → 只能改「現角色為 member」的人，且不得指派 owner；
 *   member → 不可改任何人。
 */
export function canManageRole(
  actor: TeamActor,
  target: { role: TeamRole; memberUserId: number },
  nextRole: TeamRole,
): boolean {
  if (target.memberUserId === actor.teamUserId) return false; // 團隊主帳恆 owner，不可被改
  if (actor.role === "owner") return true;
  if (actor.role === "admin") return target.role === "member" && nextRole !== "owner";
  return false;
}

/** 名冊角色可寫入性：owner 可指派任何角色；admin 不得製造新 owner（同上）。 */
export function assignableRoles(actor: TeamActor): TeamRole[] {
  if (actor.role === "owner") return [...TEAM_ROLES];
  if (actor.role === "admin") return ["admin", "member"];
  return [];
}

/** owner 集合大小 = 團隊主帳(必為 owner) + 名冊 owner。恆 ≥ 1。 */
export function ownerCount(teamUserId: number, roster: Pick<TeamRosterEntry, "role">[]): number {
  return 1 + roster.filter((entry) => entry.role === "owner").length;
}

// ── 建畫布權限（團隊級開關）

/** 成員不可建共享畫布的文案（語義對齊競品，風格用我方）。 */
export const TEAM_CANVAS_FORBIDDEN_MESSAGE =
  "只有团队创建者或管理员可以创建共享画布，请联系团队管理员开启「成员创建画布」权限。";
export const TEAM_CANVAS_FORBIDDEN_CODE = "member_canvas_forbidden";

export interface CanvasPermission {
  allowed: boolean;
  code?: string;
  message: string;
  /** 命中的團隊（null = 呼叫方不是任何團隊的受管成員，不受此閘）。 */
  teamUserId: number | null;
  role: TeamRole | null;
}

/**
 * 純函式判定：owner/admin 一律可建；member 需團隊開關開啟；非成員不受此閘。
 */
export function canCreateSharedCanvas(input: {
  actor: Pick<TeamActor, "role"> | null;
  memberCreateCanvas: boolean;
}): { allowed: boolean; code?: string; message: string } {
  if (!input.actor) return { allowed: true, message: "" };
  if (isTeamManager(input.actor.role)) return { allowed: true, message: "" };
  if (input.memberCreateCanvas) return { allowed: true, message: "" };
  return { allowed: false, code: TEAM_CANVAS_FORBIDDEN_CODE, message: TEAM_CANVAS_FORBIDDEN_MESSAGE };
}

// ── 資產面 RBAC（三級權限矩陣；與 canCreateSharedCanvas **並列**，不覆蓋）

/**
 * 資產面權限矩陣（逐字對照 Dramagic Team/Asset 頁；語義照做，命名用我方）。
 *
 * | 層級                     | view                | manage                              |
 * |--------------------------|---------------------|-------------------------------------|
 * | Main（Super Admin）      | 全帳號              | 全帳號（all global assets）          |
 * | Sub（Team Admin）        | 隊內全部            | 隊內全部（含他人建的）               |
 * | Sub（Member）            | 隊內全部            | **只可管自己建的**                   |
 *
 * 帳號級（= 非團隊資產 / 個人資產）維度：
 *   - 自己建的 → 可管（任何人管自己的資產恆真）。
 *   - 他人建的個人資產 → 任何人都不可管（跨帳號是硬邊界，見 asset-scope
 *     resolveAssetVisibility 的「跨帳號：一律不可見（跨帳號是 RBAC 那一刀）」）。
 *
 * **fail-closed**：actor 為 null（查不到身份）或 actorUserId 不合法 → 拒。
 * 這與建畫布閘的 fail-open **刻意不同**：建畫布閘的 null 語義是「relay 掛了」，
 * 放行只是不擋創作；資產管理是**寫別人的資料**，證明不了身份就不得放行。
 */
export const TEAM_ASSET_FORBIDDEN_CODE = "team_asset_forbidden";
export const TEAM_ASSET_FORBIDDEN_MESSAGE = "无权管理该资产：只有资产创建者或团队管理员可以修改团队资产。";

/** 資產面總開關：Main / Team Admin 恆真，Member 需資產屬主。 */
export function canManageTeamAsset(input: {
  /** 判定主體的有效角色；null = 查不到身份（fail-closed → 拒）。 */
  actor: Pick<TeamActor, "role"> | null;
  /** 資產屬主 user id（= 建該資產的帳號）。 */
  assetOwnerUserId: number | null;
  /** 當前操作者 user id。 */
  actorUserId: number | null;
}): { allowed: boolean; code?: string; message: string } {
  // fail-closed ①：身份不明 → 不得管任何資產。
  if (!input.actor) return { allowed: false, code: TEAM_ASSET_FORBIDDEN_CODE, message: TEAM_ASSET_FORBIDDEN_MESSAGE };
  if (
    typeof input.actorUserId !== "number" ||
    !Number.isInteger(input.actorUserId) ||
    input.actorUserId <= 0
  ) {
    return { allowed: false, code: TEAM_ASSET_FORBIDDEN_CODE, message: TEAM_ASSET_FORBIDDEN_MESSAGE };
  }
  // 自己的資產恆可管（含匿名資產：assetOwnerUserId 為 null 時**只有**自己建的視角成立；
  // 查不出屬主的資產不得被當成「人人可管」——見 fail-closed ③）。
  if (input.assetOwnerUserId === input.actorUserId) return { allowed: true, message: "" };
  // owner（= Main，含團隊主帳與共同所有者）與 admin（= Team Admin）：隊內/全帳號全部資產。
  if (isTeamManager(input.actor.role)) return { allowed: true, message: "" };
  // fail-closed ③：member 且屬主不明 → 拒（不把「查不出屬主」讀成「自己的」）。
  if (
    input.assetOwnerUserId === null ||
    typeof input.assetOwnerUserId !== "number" ||
    !Number.isInteger(input.assetOwnerUserId) ||
    input.assetOwnerUserId <= 0
  ) {
    return { allowed: false, code: TEAM_ASSET_FORBIDDEN_CODE, message: TEAM_ASSET_FORBIDDEN_MESSAGE };
  }
  // member：只可管自己建的（上面已排除相等情形）⇒ 他人資產一律拒。
  return { allowed: false, code: TEAM_ASSET_FORBIDDEN_CODE, message: TEAM_ASSET_FORBIDDEN_MESSAGE };
}

/** 資產面**讀取**權：Main / Team Admin / Member 皆可讀隊內全部；非成員只可讀自己的。 */
export function canViewTeamAsset(input: {
  actor: Pick<TeamActor, "role"> | null;
  assetOwnerUserId: number | null;
  actorUserId: number | null;
}): boolean {
  if (input.assetOwnerUserId === input.actorUserId && typeof input.actorUserId === "number") return true;
  if (!input.actor) return false; // fail-closed：身份不明 → 不可讀他人資產
  // 隊內任何角色皆可讀隊內資產（Dramagic：Member「Team assets view」）。
  return true;
}

// ─────────────────────────────────────────── 映射層存取（唯讀名冊/設定）

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

/** 成員側查自己的團隊與角色（治理閘的入口）。 */
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

/** 呼叫方的治理歸屬：名冊成員 → 其團隊；主帳（無名冊列）→ 自己（owner）。 */
export async function resolveActorTeam(
  actorUserId: number,
  sql?: GenerationSql,
): Promise<{ teamUserId: number; role: TeamRole; isMember: boolean }> {
  const row = await findRosterEntryByUserId(actorUserId, sql);
  if (row) return { teamUserId: row.teamUserId, role: row.role, isMember: true };
  return { teamUserId: actorUserId, role: "owner", isMember: false };
}

async function countRoster(teamUserId: number, sql: GenerationSql): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM team_member_quota WHERE team_user_id = ${teamUserId}
  `;
  return Number(rows[0]?.count ?? 0);
}

/** 該 user 已加入的團隊數（019 的 UNIQUE(member_user_id) 使其結構上 ≤ 1）。 */
export async function countJoinedTeams(memberUserId: number, sql?: GenerationSql): Promise<number> {
  if (!governanceStoreEnabled()) return 0;
  const db = sql ?? getGenerationSql();
  const rows = await db<{ count: number }[]>`
    SELECT count(*)::int AS count FROM team_member_quota WHERE member_user_id = ${memberUserId}
  `;
  return Number(rows[0]?.count ?? 0);
}

/** 該 user 已擁有的團隊數 = 自己的主帳團隊(1) + 名冊 owner 列。 */
export async function countOwnedTeams(userId: number, sql?: GenerationSql): Promise<number> {
  if (!governanceStoreEnabled()) return 0;
  const db = sql ?? getGenerationSql();
  const rows = await db<{ count: number }[]>`
    SELECT count(*)::int AS count FROM team_member_quota
    WHERE member_user_id = ${userId} AND role = 'owner'
  `;
  return 1 + Number(rows[0]?.count ?? 0);
}

// ── 團隊設定（意圖層）

export interface TeamSettingsRecord {
  teamUserId: number;
  memberCreateCanvas: boolean;
  seats: number;
  dissolveScheduledAt: string | null;
  dissolvedAt: string | null;
}

type SettingsRow = {
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

function mapSettingsRow(row: SettingsRow): TeamSettingsRecord {
  return {
    teamUserId: Number(row.team_user_id),
    memberCreateCanvas: row.member_create_canvas === true,
    seats: Number(row.seats),
    dissolveScheduledAt: toIso(row.dissolve_scheduled_at),
    dissolvedAt: toIso(row.dissolved_at),
  };
}

/** 未寫過設定的團隊拿到「默認意圖」（不落庫、不產生副作用）。 */
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

// ─────────────────────────────────────────── 結果型

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

function fail<T>(
  status: GovernanceFailure["status"],
  code: GovernanceCode,
  message: string,
): GovernanceResult<T> {
  return { ok: false, status, code, message };
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** 與 member-quota 同一把團隊鎖：治理寫入與配額分配互相串行化。 */
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

export interface TeamGovernanceDeps {
  sql?: GenerationSql;
  withTeamLock?: TeamLock;
  newId?: () => string;
  now?: () => number;
}

function lockFor(deps: TeamGovernanceDeps, sql: GenerationSql): TeamLock {
  return deps.withTeamLock ?? ((teamUserId, fn) => defaultGovernanceLock(sql, teamUserId, fn));
}

function nowMs(deps: TeamGovernanceDeps): number {
  return (deps.now ?? Date.now)();
}

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
      // 最後一個 owner：團隊主帳恆為 owner，任何針對它的降級/移除一律拒。
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

// ─────────────────────────────────────────── 面 2：建畫布權限開關

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

// ─────────────────────────────────────────── 面 3：加入審批

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

type JoinRow = {
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

function mapJoinRow(row: JoinRow): TeamJoinRequestRecord {
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
 * 申請加入團隊（申請人身份來自身份驗證，不從 body 取 user）。
 * 幂等：已有 pending 申請 → 回同一條（created=false）；已駁回/忽略 → 重開為 pending。
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
  // 主帳恆為 owner，不是成員；申請自己的團隊無意義。
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

/** 審批台列表：owner/admin 可看；可按狀態過濾（默認 pending）。 */
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
 * 審批（approve/reject/ignore）。不變量：
 *   ① 只有 owner/admin 可審批；
 *   ② 滿員（名冊成員數 ≥ seats 或 ≥ max_members 硬上限）時不得通過；
 *   ③ 申請人已在別的團隊時不得通過（成員同時只能屬一個團隊，019 UNIQUE 為結構約束）；
 *   ④ 幂等：重放同一審批不產生第二次名冊登記、不重複扣費（本路徑完全不碰點數）。
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
      // 幂等：重放同一決定 = no-op（不再登記名冊、不再改狀態）。
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
        // ② 滿員不得通過（席位閘 + 硬上限雙閘）。
        if (memberCount + 1 > settings.seats || memberCount + 1 > capacity.maxMembers) {
          return fail<{ requestId: string; status: JoinRequestStatus; memberUserId: number | null; unchanged: boolean }>(409, "team_full", `团队席位已满（当前 ${memberCount} 人，席位数 ${settings.seats}），请先扩容或腾出席位。`);
        }
        // ③ 成員同時只能屬一個團隊（配額桶模型 + 019 UNIQUE）。
        const joined = await countJoinedTeams(request.applicantUserId, tx);
        const limits = teamJoinLimits();
        if (joined >= limits.maxJoinedTeams) {
          return fail<{ requestId: string; status: JoinRequestStatus; memberUserId: number | null; unchanged: boolean }>(409, "joined_teams_limit", `该成员已达到可加入团队数上限 ${limits.maxJoinedTeams}。`);
        }
        if (joined > 0) {
          return fail<{ requestId: string; status: JoinRequestStatus; memberUserId: number | null; unchanged: boolean }>(409, "member_already_in_team", "该成员已归属其他团队，不可跨团队加入。");
        }
        // 名冊登記走既有 upsertTeamMember（member-quota 的唯一登記通路），role 由 DDL 默認 member。
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

// ─────────────────────────────────────────── 面 4：生命週期

export interface TeamLifecycle {
  teamUserId: number;
  memberCount: number;
  dissolved: boolean;
  dissolvedAt: string | null;
  dissolveScheduledAt: string | null;
  cooloffMs: number;
  /** 冷靜期是否已過（到期即為「應執行」）。 */
  due: boolean;
  /** 距離可執行還剩多少毫秒（未排程 = null）。 */
  remainingMs: number | null;
}

export function dissolutionDueAt(scheduledAt: string | null): number | null {
  if (!scheduledAt) return null;
  const ms = new Date(scheduledAt).getTime();
  return Number.isFinite(ms) ? ms : null;
}

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

/** 排程解散（owner）。重放同一請求 = 幂等（不重置冷靜期起點）。 */
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

/** 冷靜期內撤回解散（owner）。 */
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
 * 執行解散（冷靜期到期才生效，幂等）。意圖層動作：名冊成員一併停用
 * （令其單被既有預檢按「成員已停用」拒），**不動任何點數**——成員桶裡已轉出的
 * 額度留在該 user，不自動回收（回收要走 member-quota 的 allocate，不在本函式）。
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

/** 退出團隊（成員側）。最後一個 owner（= 團隊主帳）不可直接退出。 */
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
      // 名冊裡沒有這個 user：可能是團隊主帳（owner）——主帳不可「退出」，須先轉移或解散。
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

/** 移除成員（管理側）。不變量同角色變更：不可移除最後一個 owner（團隊主帳）。 */
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

// ─────────────────────────────────────────── 面 2（續）：成員建畫布閘

/**
 * 成員側建共享畫布閘：呼叫方（billingUserId）若不是受管成員 → 放行（不受此閘）；
 * 是成員 → owner/admin 放行，member 依團隊開關。控制面未配置時放行（無治理層）。
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
    // 讀不到治理層不擋創作（與既有降級一致；點數閘仍由預檢 fail-closed 執法）。
    console.error(`[team-governance] canMemberCreateSharedCanvas 降级放行 user=${billingUserId}: ${reasonOf(error)}`);
    return { allowed: true, message: "", teamUserId: null, role: null };
  }
}

// ─────────────────────────────────────────── 面 6：用量統計

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
   * 守恆檢驗（沿用 member-quota 已宣告的不變量）：
   *   主帳手上餘額 + Σ 成員桶剩餘 = 團隊未消耗總額；consumed = Σ成員已用。
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

function mapLedgerRecord(entry: LedgerEntry): TeamUsageRecord {
  return {
    id: entry.id,
    userId: entry.billingUserId,
    entryType: entry.entryType,
    amount: entry.amount,
    amountCoins: toCoins(entry.amount),
    source: entry.source,
    sourceRef: entry.sourceRef,
    jobId: entry.jobId,
    operationId: entry.operationId,
    createdAt: entry.createdAt ?? null,
  };
}

export type TeamLedgerReader = (billingUserId: number, sql?: GenerationSql) => Promise<LedgerEntry[]>;

/**
 * 團隊／成員維度用量彙總：數字一律讀既有權威面（new-api 經 member-quota 的可視面；
 * 逐筆明細讀既有 account_ledger），**不新建統計帳本**。
 */
export async function readTeamUsage(
  input: { teamUserId: number; memberKeyId?: string },
  deps: {
    sql?: GenerationSql;
    fetchUser?: typeof fetchGatewayUser;
    readLedger?: TeamLedgerReader;
  } = {},
): Promise<TeamUsageSummary | null> {
  const view = await readTeamQuotaView({ teamUserId: input.teamUserId }, { sql: deps.sql, fetchUser: deps.fetchUser });
  if (!view) return null;
  const settings = await readTeamSettings(input.teamUserId, deps.sql);
  const roleByUser = new Map((await listTeamRoster(input.teamUserId, deps.sql)).map((entry) => [entry.memberUserId, entry.role]));
  const readLedger = deps.readLedger ?? ((userId: number, sql?: GenerationSql) => readAccountLedger(userId, { sql }));

  const members: TeamMemberUsage[] = [];
  const allRecords: TeamUsageRecord[] = [];
  let membersRemaining = 0;
  for (const member of view.members) {
    if (input.memberKeyId && member.memberKeyId !== input.memberKeyId) continue;
    let records: TeamUsageRecord[] = [];
    try {
      records = (await readLedger(member.memberUserId, deps.sql)).map(mapLedgerRecord);
    } catch (error) {
      console.error(`[team-governance] 成员用量明细读取失败 user=${member.memberUserId}: ${reasonOf(error)}`);
    }
    membersRemaining += member.remaining;
    members.push({
      memberKeyId: member.memberKeyId,
      memberUserId: member.memberUserId,
      displayName: member.displayName,
      role: roleByUser.get(member.memberUserId) ?? "member",
      enabled: member.enabled,
      granted: member.granted,
      used: member.used,
      remaining: member.remaining,
      coins: member.coins,
      unavailable: member.unavailable,
      records,
    });
    allRecords.push(...records);
  }
  allRecords.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  const teamRemaining = view.team.remaining;
  return {
    teamUserId: view.teamUserId,
    seats: settings.seats,
    memberCount: view.members.length,
    capacity: teamCapacity(),
    totals: {
      granted: view.allocated,
      used: view.used,
      remaining: teamRemaining,
      coins: { granted: view.allocatedCoins, used: view.usedCoins, remaining: view.team.coins },
    },
    conservation: {
      masterRemaining: view.master.remaining,
      membersRemaining,
      teamRemaining,
      consumed: view.used,
      balanced: view.master.remaining + membersRemaining === teamRemaining,
      formula: "主帳手上余额 + Σ成员桶剩余 = 团队未消耗总额",
    },
    members,
    records: allRecords,
  };
}
