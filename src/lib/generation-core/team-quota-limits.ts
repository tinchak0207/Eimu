// 团队／成员配额（Dramagic 对照面）：**速率／上界限制层**，不是帐本。
//
// 铁律（禁影子帐本，见 019/023 档头与 control-plane-billing-paradigm）：
//   本模组只存「意图上限」与「当日已用计数」，**不存任何余额**。
//   真实扣费仍走既有五态帐本（billing-ledger.ts / account-ledger.ts），
//   本模组**不呼叫、不读写**任何帐本表，也不呼叫任何上游额度调整。
//
// 为什么是「速率限制不是预扣」（Dramagic Team 页逐字）：
//   「this only limits the maximum points consumption」——每日额度只是**当日消耗上界**，
//   到点重置、不累积、不先扣一笔。因此本模组的日计数是**观察值**（每次成功消耗后 +Δ），
//   差额可事后对帐，却不参与任何余额计算。
//
// 三种上限（与 Dramagic 逐字对照）：
//   团队层：`none`（= no points limit，预设；消耗主帐号可分配余额）／`fixed`（allocated fixed team points）
//          主帐可「分配／回收／设为不限」；改回不限 ⇒ 剩余全数回收（本模组只翻状态与上限，
//          实际点数移动仍由 member-quota 的转移通路决定，本模组不碰数字）。
//   成员层：`fixed`（固定点数分配）／`daily`（每日额度；UTC+8 00:00 重置且不累积）／`unlimited`。
//          Team Admin **预设 unlimited 且不得被设配额**（见 setMemberQuotaLimit）。
//
// 储存：team_settings 加两栏（团队层）＋ team_member_quota 加三栏（成员层）
//       ——在既有团队真源上长，不新建平行表（与 023 同口径）。

import { generationControlPlaneEnabled, getGenerationSql, type GenerationSql } from "./database";
import { readTeamQuotaView, toCoins } from "./member-quota";
import type { TeamRole } from "./team-governance";

export type TeamQuotaMode = "none" | "fixed";
export type MemberQuotaMode = "unlimited" | "fixed" | "daily";

export const TEAM_QUOTA_MODES: readonly TeamQuotaMode[] = ["none", "fixed"];
export const MEMBER_QUOTA_MODES: readonly MemberQuotaMode[] = ["unlimited", "fixed", "daily"];

export function isTeamQuotaMode(value: unknown): value is TeamQuotaMode {
  return typeof value === "string" && (TEAM_QUOTA_MODES as readonly string[]).includes(value);
}

export function isMemberQuotaMode(value: unknown): value is MemberQuotaMode {
  return typeof value === "string" && (MEMBER_QUOTA_MODES as readonly string[]).includes(value);
}

export const TEAM_QUOTA_INVALID_MODE_MESSAGE = "团队配额模式必须是 none（不限）或 fixed（固定额度）。";
export const MEMBER_QUOTA_INVALID_MODE_MESSAGE = "成员配额模式必须是 unlimited / fixed / daily 之一。";
export const MEMBER_QUOTA_ADMIN_LOCKED_MESSAGE =
  "团队管理员（admin）默认不限额度，且不可被设置配额。";
export const MEMBER_QUOTA_ABOVE_TEAM_REMAINING_MESSAGE =
  "成员配额不得超过团队剩余可用额度。";
export const TEAM_QUOTA_RECLAIM_ABOVE_REMAINING_MESSAGE =
  "回收额度不得超过团队剩余额度。";

/** UTC+8 的日界：每日 00:00（UTC+8）重置，且**不累积**。 */
export const DAILY_QUOTA_EPOCH_OFFSET_MINUTES = 8 * 60;

/**
 * 当前所属的「配额日」字串（`YYYY-MM-DD`，UTC+8 日界）。
 * 纯函式，吃毫秒时戳 → 便于测试跨日重置。
 */
export function quotaDayKey(nowMs: number, offsetMinutes = DAILY_QUOTA_EPOCH_OFFSET_MINUTES): string {
  const shifted = new Date(nowMs + offsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 下一次重置时刻（UTC+8 00:00，毫秒时戳）。 */
export function nextQuotaResetMs(nowMs: number, offsetMinutes = DAILY_QUOTA_EPOCH_OFFSET_MINUTES): number {
  const step = 24 * 60 * 60 * 1000;
  const shifted = nowMs + offsetMinutes * 60_000;
  const nextShifted = Math.floor(shifted / step) * step + step;
  return nextShifted - offsetMinutes * 60_000;
}

/** 每日已用计数的有效值：跨日 ⇒ 归零（**不累积**）。纯函式。 */
export function effectiveDailyUsed(input: {
  /** 盘上记的日界（`YYYY-MM-DD`）。 */
  storedDay: string | null;
  storedUsed: number;
  nowMs: number;
  offsetMinutes?: number;
}): number {
  const today = quotaDayKey(input.nowMs, input.offsetMinutes);
  if (input.storedDay !== today) return 0;
  return Number.isFinite(input.storedUsed) && input.storedUsed > 0 ? Math.floor(input.storedUsed) : 0;
}

// ─────────────────────────────────────────── 资料结构

/** 团队层配额（意图层；不含任何余额数字）。 */
export interface TeamQuotaLimit {
  teamUserId: number;
  /** none = no points limit（预设，消耗主帐号可分配余额）；fixed = allocated fixed team points。 */
  mode: TeamQuotaMode;
  /** mode==="fixed" 时的团队总额上限（new-api quota 单位）。 */
  fixedQuota: number;
  /** 该团队**已分配给成员**的额度合计（读自配额可视面，非本地帐本）。 */
  allocatedToMembers: number;
  /**
   * 团队可再分配余量 = fixedQuota − allocatedToMembers（mode==="none" ⇒ 主帐手上余额）。
   * 呼叫端拿它当「回收上限」与「成员固定额上限」的执法依据。
   */
  remaining: number;
}

/** 成员层配额设定（意图层；dailyUsed 是**速率观察值**，不是余额）。 */
export interface MemberQuotaLimit {
  memberUserId: number;
  mode: MemberQuotaMode;
  /** mode==="fixed" 时的固定额度（new-api quota 单位）。 */
  fixedQuota: number;
  /** mode==="daily" 时的每日额度（new-api quota 单位）。 */
  dailyQuota: number;
  /** 当日已用（已按日界归零）。 */
  dailyUsed: number;
  /** 剩余可消耗 = 每日额度 − 当日已用（daily 模式）或 fixedQuota（fixed 模式）；unlimited ⇒ null。 */
  remaining: number | null;
}

export interface QuotaLimitStore {
  readTeamQuotaLimit(teamUserId: number): Promise<{ mode: TeamQuotaMode; fixedQuota: number } | null>;
  writeTeamQuotaLimit(teamUserId: number, mode: TeamQuotaMode, fixedQuota: number): Promise<boolean>;
  readMemberQuotaLimit(memberUserId: number): Promise<{
    mode: MemberQuotaMode;
    fixedQuota: number;
    dailyQuota: number;
    dailyDay: string | null;
    dailyUsed: number;
  } | null>;
  writeMemberQuotaLimit(
    memberUserId: number,
    mode: MemberQuotaMode,
    fixedQuota: number,
    dailyQuota: number,
    dailyDay: string | null,
    dailyUsed: number,
  ): Promise<boolean>;
}

// ─────────────────────────────────────────── 纯函式：判定与边界

export interface QuotaDecision {
  ok: boolean;
  code?: string;
  message?: string;
}

/**
 * 成员配额设定授权（纯函式，fail-closed）：
 *   - 呼叫方必须是 owner（Main）或 admin（Team Admin）；member → 拒。
 *   - **Team Admin 预设 unlimited 且不可被设配额**（Dramagic 逐字：
 *     「team Admin is set to unlimited by default and cannot have a quota set」）
 *     ⇒ 目标角色是 admin/owner 时，只接受 unlimited；要设 fixed/daily 一律拒。
 */
export function canSetMemberQuota(input: {
  actorRole: TeamRole | null;
  targetRole: TeamRole;
  mode: MemberQuotaMode;
}): QuotaDecision {
  if (input.actorRole === null) {
    return { ok: false, code: "forbidden", message: "无权设置成员配额。" };
  }
  if (input.actorRole !== "owner" && input.actorRole !== "admin") {
    return { ok: false, code: "forbidden", message: "只有团队创建者或管理员可以设置成员配额。" };
  }
  if ((input.targetRole === "admin" || input.targetRole === "owner") && input.mode !== "unlimited") {
    return { ok: false, code: "admin_unlimited_locked", message: MEMBER_QUOTA_ADMIN_LOCKED_MESSAGE };
  }
  return { ok: true };
}

/**
 * 成员固定额上界判定（纯函式）：不得超过团队剩余（Dramagic 逐字
 * 「上限不得超过团队剩余」）。`teamRemaining === null` = 不限 ⇒ 无上界。
 */
export function memberQuotaWithinTeam(input: {
  mode: MemberQuotaMode;
  fixedQuota: number;
  dailyQuota: number;
  teamRemaining: number | null;
}): QuotaDecision {
  if (input.teamRemaining === null) return { ok: true };
  const asked = input.mode === "fixed" ? input.fixedQuota : input.mode === "daily" ? input.dailyQuota : 0;
  if (!Number.isFinite(asked) || asked < 0) {
    return { ok: false, code: "invalid_quota", message: "配额必须是不小于 0 的数值。" };
  }
  if (asked > input.teamRemaining) {
    return { ok: false, code: "exceeds_team_remaining", message: MEMBER_QUOTA_ABOVE_TEAM_REMAINING_MESSAGE };
  }
  return { ok: true };
}

/**
 * 团队固定额设定判定（纯函式）：
 *   - fixed 的额度不得低于**已分配给成员**的部分（否则等于超卖）。
 *   - 改回 `none`（不限）⇒ 剩余全数回收：回传 `reclaim` = 已分配给成员的全部额度，
 *     由呼叫端交既有转移通路执行（本模组不碰数字）。
 */
export function teamQuotaReclaim(input: {
  nextMode: TeamQuotaMode;
  nextFixedQuota: number;
  allocatedToMembers: number;
}): { ok: boolean; code?: string; message?: string; reclaim: number } {
  const allocated = Number.isFinite(input.allocatedToMembers) && input.allocatedToMembers > 0
    ? Math.floor(input.allocatedToMembers)
    : 0;
  if (input.nextMode === "none") return { ok: true, reclaim: allocated };
  if (!Number.isFinite(input.nextFixedQuota) || input.nextFixedQuota < 0) {
    return { ok: false, code: "invalid_quota", message: "配额必须是不小于 0 的数值。", reclaim: 0 };
  }
  if (input.nextFixedQuota < allocated) {
    return {
      ok: false,
      code: "below_allocated",
      message: `团队额度不能低于已分配给成员的 ${toCoins(allocated)} 币。`,
      reclaim: 0,
    };
  }
  return { ok: true, reclaim: 0 };
}

/**
 * 回收额度判定（纯函式）：**回收上限 = 团队剩余**。
 * `teamRemaining === null`（不限）⇒ 无上限。
 */
export function reclaimWithinRemaining(input: {
  reclaimQuota: number;
  teamRemaining: number | null;
}): QuotaDecision {
  if (!Number.isFinite(input.reclaimQuota) || input.reclaimQuota < 0) {
    return { ok: false, code: "invalid_quota", message: "回收额度必须是不小于 0 的数值。" };
  }
  if (input.teamRemaining === null) return { ok: true };
  if (input.reclaimQuota > input.teamRemaining) {
    return { ok: false, code: "reclaim_above_remaining", message: TEAM_QUOTA_RECLAIM_ABOVE_REMAINING_MESSAGE };
  }
  return { ok: true };
}

/** 每日额度是否仍可消耗（**速率**判定，不预扣、不写任何帐本）。 */
export function dailyQuotaAllows(input: {
  spec: Pick<MemberQuotaLimit, "mode" | "dailyQuota" | "dailyUsed">;
  costQuota: number;
}): QuotaDecision {
  if (input.spec.mode !== "daily") return { ok: true };
  const limit = Number.isFinite(input.spec.dailyQuota) ? input.spec.dailyQuota : 0;
  const used = Number.isFinite(input.spec.dailyUsed) ? input.spec.dailyUsed : 0;
  const cost = Number.isFinite(input.costQuota) && input.costQuota > 0 ? input.costQuota : 0;
  if (used + cost > limit) {
    return {
      ok: false,
      code: "daily_quota_exceeded",
      message: `今日额度已用完（${toCoins(used)}/${toCoins(limit)} 币），将于每日 00:00（UTC+8）重置。`,
    };
  }
  return { ok: true };
}

// ─────────────────────────────────────────── 映射层存取（意图栏位）

/** 治理/配额映射层可用性（C 端 Vercel 无控制面库 ⇒ 不可用）。 */
export function quotaLimitStoreEnabled(): boolean {
  return generationControlPlaneEnabled();
}

function dayOrNull(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function intOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

type TeamQuotaRow = {
  quota_mode: string | null;
  fixed_quota: number | string | null;
};

export async function readTeamQuotaLimitRow(
  teamUserId: number,
  sql?: GenerationSql,
): Promise<{ mode: TeamQuotaMode; fixedQuota: number } | null> {
  if (!quotaLimitStoreEnabled()) return null;
  const db = sql ?? getGenerationSql();
  const rows = await db<TeamQuotaRow[]>`
    SELECT quota_mode, fixed_quota FROM team_settings WHERE team_user_id = ${teamUserId}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    mode: isTeamQuotaMode(row.quota_mode) ? row.quota_mode : "none",
    fixedQuota: intOrZero(row.fixed_quota),
  };
}

/** 写入团队配额意图（**只写意图栏位，不写任何余额**）。 */
export async function writeTeamQuotaLimitRow(
  teamUserId: number,
  mode: TeamQuotaMode,
  fixedQuota: number,
  sql?: GenerationSql,
): Promise<boolean> {
  if (!quotaLimitStoreEnabled()) return false;
  const db = sql ?? getGenerationSql();
  await db`
    INSERT INTO team_settings (team_user_id, quota_mode, fixed_quota)
    VALUES (${teamUserId}, ${mode}, ${Math.floor(fixedQuota)})
    ON CONFLICT (team_user_id) DO UPDATE SET
      quota_mode = EXCLUDED.quota_mode,
      fixed_quota = EXCLUDED.fixed_quota,
      updated_at = now()
  `;
  return true;
}

type MemberQuotaRow = {
  quota_mode: string | null;
  member_fixed_quota: number | string | null;
  daily_quota: number | string | null;
  daily_quota_day: string | null;
  daily_quota_used: number | string | null;
};

export interface MemberQuotaLimitRow {
  mode: MemberQuotaMode;
  fixedQuota: number;
  dailyQuota: number;
  dailyDay: string | null;
  dailyUsed: number;
}

export async function readMemberQuotaLimitRow(
  memberUserId: number,
  sql?: GenerationSql,
): Promise<MemberQuotaLimitRow | null> {
  if (!quotaLimitStoreEnabled()) return null;
  const db = sql ?? getGenerationSql();
  const rows = await db<MemberQuotaRow[]>`
    SELECT quota_mode, member_fixed_quota, daily_quota, daily_quota_day, daily_quota_used
    FROM team_member_quota
    WHERE member_user_id = ${memberUserId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    mode: isMemberQuotaMode(row.quota_mode) ? row.quota_mode : "unlimited",
    fixedQuota: intOrZero(row.member_fixed_quota),
    dailyQuota: intOrZero(row.daily_quota),
    dailyDay: dayOrNull(row.daily_quota_day),
    dailyUsed: intOrZero(row.daily_quota_used),
  };
}

/** 写入成员配额意图（**只写意图与速率计数，不写任何余额**）。 */
export async function writeMemberQuotaLimitRow(
  memberUserId: number,
  limit: MemberQuotaLimitRow,
  sql?: GenerationSql,
): Promise<boolean> {
  if (!quotaLimitStoreEnabled()) return false;
  const db = sql ?? getGenerationSql();
  await db`
    UPDATE team_member_quota SET
      quota_mode = ${limit.mode},
      member_fixed_quota = ${Math.floor(limit.fixedQuota)},
      daily_quota = ${Math.floor(limit.dailyQuota)},
      daily_quota_day = ${limit.dailyDay},
      daily_quota_used = ${Math.floor(limit.dailyUsed)},
      updated_at = now()
    WHERE member_user_id = ${memberUserId}
  `;
  return true;
}

// ─────────────────────────────────────────── 服务层（裁决 + 意图写入）
//
// 这一层**只写意图栏位**：不呼叫 member-quota 的转移通路、不呼叫上游、
// 不写任何帐本。实际点数移动由呼叫端（管理面）另行交 member-quota 执行。

export type QuotaLimitFailureCode =
  | "store_unavailable"
  | "forbidden"
  | "invalid_quota"
  | "invalid_mode"
  | "admin_unlimited_locked"
  | "exceeds_team_remaining"
  | "reclaim_above_remaining"
  | "below_allocated"
  | "member_not_found";

export interface QuotaLimitFailure {
  ok: false;
  status: 400 | 403 | 404 | 409 | 503;
  code: QuotaLimitFailureCode;
  message: string;
}

export type QuotaLimitResult<T> = ({ ok: true } & T) | QuotaLimitFailure;

function qfail<T>(
  status: QuotaLimitFailure["status"],
  code: QuotaLimitFailureCode,
  message: string,
): QuotaLimitResult<T> {
  return { ok: false, status, code, message };
}

function qreason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/**
 * 设定团队配额（分配／回收／设为不限），**只翻意图栏位**。
 *
 * 边界（纯函式 teamQuotaReclaim 裁决，此处只负责读数与写入）：
 *   - fixed 不得低于已分配给成员的部分（超卖保护）。
 *   - 改回 none ⇒ `reclaim` = 已分配给成员的全部额度（由呼叫端交既有转移通路执行）。
 *   - 回收不得超过团队剩余（reclaimWithinRemaining）。
 */
export async function setTeamQuotaLimit(
  input: { teamUserId: number; actorRole: TeamRole | null; mode: TeamQuotaMode; fixedQuota: number },
  deps: { sql?: GenerationSql; allocated?: number } = {},
): Promise<QuotaLimitResult<{ mode: TeamQuotaMode; fixedQuota: number; reclaim: number; unchanged: boolean }>> {
  if (!quotaLimitStoreEnabled()) {
    return qfail(503, "store_unavailable", "团队配额映射层不可用（控制面数据库未配置）。");
  }
  if (input.actorRole !== "owner") {
    return qfail(403, "forbidden", "只有团队主账号可以设置团队配额。");
  }
  if (!isTeamQuotaMode(input.mode)) {
    return qfail(400, "invalid_mode", TEAM_QUOTA_INVALID_MODE_MESSAGE);
  }
  if (!Number.isFinite(input.fixedQuota) || input.fixedQuota < 0) {
    return qfail(400, "invalid_quota", "配额必须是不小于 0 的数值。");
  }
  const sql = deps.sql ?? getGenerationSql();
  try {
    const current = await readTeamQuotaLimitRow(input.teamUserId, sql);
    // 已分配给成员的额度：读配额可视面（上游权威），不在本地记帐。
    const allocated = await readAllocatedToMembers(input.teamUserId, sql, deps.allocated);
    const decision = teamQuotaReclaim({
      nextMode: input.mode,
      nextFixedQuota: Math.floor(input.fixedQuota),
      allocatedToMembers: allocated,
    });
    if (!decision.ok) return qfail(409, decision.code as QuotaLimitFailureCode, decision.message ?? "");
    // 回收检查：回收额度不得超过团队剩余（本团队剩余＝fixed 上限 − 已分配）。
    const remaining = input.mode === "fixed" ? Math.max(0, Math.floor(input.fixedQuota) - allocated) : null;
    const reclaimCheck = reclaimWithinRemaining({ reclaimQuota: decision.reclaim, teamRemaining: remaining });
    if (!reclaimCheck.ok) {
      return qfail(409, reclaimCheck.code as QuotaLimitFailureCode, reclaimCheck.message ?? "");
    }
    const unchanged = current !== null && current.mode === input.mode && current.fixedQuota === Math.floor(input.fixedQuota);
    if (!unchanged) {
      await writeTeamQuotaLimitRow(input.teamUserId, input.mode, Math.floor(input.fixedQuota), sql);
    }
    return {
      ok: true,
      mode: input.mode,
      fixedQuota: Math.floor(input.fixedQuota),
      reclaim: decision.reclaim,
      unchanged,
    };
  } catch (error) {
    console.error(`[team-quota] setTeamQuotaLimit 失败 team=${input.teamUserId}: ${qreason(error)}`);
    return qfail(503, "store_unavailable", "团队配额暂不可用，请稍后重试。");
  }
}

/**
 * 设定成员配额（fixed／daily／unlimited），**只写意图与上限**。
 *
 * 边界：admin/owner 目标角色只接受 unlimited（Dramagic 逐字）；member 角色
 * 的配额不得超过团队剩余；呼叫方须为 owner 或 admin 且不得设定 admin 的配额。
 */
export async function setMemberQuotaLimit(
  input: {
    teamUserId: number;
    actorRole: TeamRole | null;
    targetMemberUserId: number;
    targetRole: TeamRole;
    mode: MemberQuotaMode;
    fixedQuota?: number;
    dailyQuota?: number;
    nowMs?: number;
  },
  deps: { sql?: GenerationSql; allocated?: number } = {},
): Promise<QuotaLimitResult<{ mode: MemberQuotaMode; fixedQuota: number; dailyQuota: number; unchanged: boolean }>> {
  if (!quotaLimitStoreEnabled()) {
    return qfail(503, "store_unavailable", "成员配额映射层不可用（控制面数据库未配置）。");
  }
  if (!isMemberQuotaMode(input.mode)) {
    return qfail(400, "invalid_mode", MEMBER_QUOTA_INVALID_MODE_MESSAGE);
  }
  const authority = canSetMemberQuota({
    actorRole: input.actorRole,
    targetRole: input.targetRole,
    mode: input.mode,
  });
  if (!authority.ok) {
    const status = authority.code === "admin_unlimited_locked" ? 409 : 403;
    return qfail(status, authority.code as QuotaLimitFailureCode, authority.message ?? "");
  }
  const fixedQuota = Math.floor(Number(input.fixedQuota ?? 0));
  const dailyQuota = Math.floor(Number(input.dailyQuota ?? 0));
  if (
    !Number.isFinite(fixedQuota) ||
    fixedQuota < 0 ||
    !Number.isFinite(dailyQuota) ||
    dailyQuota < 0
  ) {
    return qfail(400, "invalid_quota", "配额必须是不小于 0 的数值。");
  }
  const sql = deps.sql ?? getGenerationSql();
  try {
    const team = await readTeamQuotaLimitRow(input.teamUserId, sql);
    const allocated = await readAllocatedToMembers(input.teamUserId, sql, deps.allocated);
    // 团队剩余：none ⇒ null（不限，无上界）；fixed ⇒ 上限 − 已分配。
    const teamRemaining = team && team.mode === "fixed" ? Math.max(0, team.fixedQuota - allocated) : null;
    const within = memberQuotaWithinTeam({
      mode: input.mode,
      fixedQuota,
      dailyQuota,
      teamRemaining,
    });
    if (!within.ok) {
      return qfail(409, within.code as QuotaLimitFailureCode, within.message ?? "");
    }
    const current = await readMemberQuotaLimitRow(input.targetMemberUserId, sql);
    if (!current) {
      return qfail(404, "member_not_found", `未找到成员账号 ${input.targetMemberUserId} 的配额记录。`);
    }
    const today = quotaDayKey(input.nowMs ?? Date.now());
    const unchanged =
      current.mode === input.mode &&
      current.fixedQuota === fixedQuota &&
      current.dailyQuota === dailyQuota;
    if (!unchanged) {
      await writeMemberQuotaLimitRow(
        input.targetMemberUserId,
        {
          mode: input.mode,
          fixedQuota,
          dailyQuota,
          // 改模式 ⇒ 日计数起新的一天（避免残留旧模式的当日已用）。
          dailyDay: input.mode === "daily" ? today : null,
          dailyUsed: input.mode === "daily" ? effectiveDailyUsed({
            storedDay: current.dailyDay,
            storedUsed: current.dailyUsed,
            nowMs: input.nowMs ?? Date.now(),
          }) : 0,
        },
        sql,
      );
    }
    return { ok: true, mode: input.mode, fixedQuota, dailyQuota, unchanged };
  } catch (error) {
    console.error(`[team-quota] setMemberQuotaLimit 失败 team=${input.teamUserId}: ${qreason(error)}`);
    return qfail(503, "store_unavailable", "成员配额暂不可用，请稍后重试。");
  }
}

/**
 * 已分配给成员的额度合计。
 *
 * 这里刻意**不读本地表也不记帐**：语义上「已分配」是上游权威事实
 *（成员桶 granted 之和 ＝ member-quota.readTeamQuotaView().allocated）。
 * 读不到上游（new-api 不可达／映射层不在）⇒ 回 0，并由呼叫端从严处理上界；
 * 真正的超卖保护仍在 member-quota.ts 的转移通路（先扣后加 + 团队锁）。
 *
 * 测试注入点 `deps.allocated` 让上界判定可在无 DB 环境下逐格验证。
 */
async function readAllocatedToMembers(
  teamUserId: number,
  sql: GenerationSql | undefined,
  override?: number,
): Promise<number> {
  if (typeof override === "number" && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  if (!quotaLimitStoreEnabled()) return 0;
  try {
    const view = await readTeamQuotaView({ teamUserId }, { sql });
    return view ? Math.max(0, Math.floor(view.allocated)) : 0;
  } catch {
    return 0;
  }
}

/** 团队＋成员配额意图的可视面（纯读意图栏位，不含任何帐本资料）。 */
export interface TeamQuotaLimitsView {
  teamUserId: number;
  team: { mode: TeamQuotaMode; fixedQuota: number; dailyResetAt: string };
  members: {
    memberUserId: number;
    displayName: string;
    role: TeamRole;
    mode: MemberQuotaMode;
    fixedQuota: number;
    dailyQuota: number;
    dailyUsed: number;
    dailyRemaining: number | null;
  }[];
}

export async function readQuotaLimits(
  input: { teamUserId: number; roster: { memberUserId: number; displayName: string; role: TeamRole }[]; nowMs?: number },
  deps: { sql?: GenerationSql } = {},
): Promise<TeamQuotaLimitsView | null> {
  if (!quotaLimitStoreEnabled()) return null;
  const sql = deps.sql ?? getGenerationSql();
  const nowMs = input.nowMs ?? Date.now();
  try {
    const team = (await readTeamQuotaLimitRow(input.teamUserId, sql)) ?? { mode: "none" as const, fixedQuota: 0 };
    const members: TeamQuotaLimitsView["members"] = [];
    for (const member of input.roster) {
      const row = await readMemberQuotaLimitRow(member.memberUserId, sql);
      const mode = row?.mode ?? "unlimited";
      const dailyQuota = row?.dailyQuota ?? 0;
      const dailyUsed = row
        ? effectiveDailyUsed({ storedDay: row.dailyDay, storedUsed: row.dailyUsed, nowMs })
        : 0;
      members.push({
        memberUserId: member.memberUserId,
        displayName: member.displayName,
        role: member.role,
        mode,
        fixedQuota: row?.fixedQuota ?? 0,
        dailyQuota,
        dailyUsed,
        dailyRemaining: mode === "daily" ? Math.max(0, dailyQuota - dailyUsed) : null,
      });
    }
    return {
      teamUserId: input.teamUserId,
      team: {
        mode: team.mode,
        fixedQuota: team.fixedQuota,
        dailyResetAt: new Date(nextQuotaResetMs(nowMs)).toISOString(),
      },
      members,
    };
  } catch (error) {
    console.error(`[team-quota] readQuotaLimits 失败 team=${input.teamUserId}: ${qreason(error)}`);
    return null;
  }
}

