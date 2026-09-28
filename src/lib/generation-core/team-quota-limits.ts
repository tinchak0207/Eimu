// 團隊／成員配額（Dramagic 對照面）：**速率／上界限制層**，不是帳本。
//
// 鐵律（禁影子帳本，見 019/023 檔頭與 control-plane-billing-paradigm）：
//   本模組只存「意圖上限」與「當日已用計數」，**不存任何餘額**。
//   真實扣費仍走既有五態帳本（billing-ledger.ts / account-ledger.ts），
//   本模組**不呼叫、不讀寫**任何帳本表，也不呼叫任何上游額度調整。
//
// 為什麼是「速率限制不是預扣」（Dramagic Team 頁逐字）：
//   「this only limits the maximum points consumption」——每日額度只是**當日消耗上界**，
//   到點重置、不累積、不先扣一筆。因此本模組的日計數是**觀察值**（每次成功消耗後 +Δ），
//   差額可事後對帳，卻不參與任何餘額計算。
//
// 三種上限（與 Dramagic 逐字對照）：
//   團隊層：`none`（= no points limit，預設；消耗主帳號可分配餘額）／`fixed`（allocated fixed team points）
//          主帳可「分配／回收／設為不限」；改回不限 ⇒ 剩餘全數回收（本模組只翻狀態與上限，
//          實際點數移動仍由 member-quota 的轉移通路決定，本模組不碰數字）。
//   成員層：`fixed`（固定點數分配）／`daily`（每日額度；UTC+8 00:00 重置且不累積）／`unlimited`。
//          Team Admin **預設 unlimited 且不得被設配額**（見 setMemberQuotaLimit）。
//
// 儲存：team_settings 加兩欄（團隊層）＋ team_member_quota 加三欄（成員層）
//       ——在既有團隊真源上長，不新建平行表（與 023 同口徑）。

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

export const TEAM_QUOTA_INVALID_MODE_MESSAGE = "团队配額模式必须是 none（不限）或 fixed（固定额度）。";
export const MEMBER_QUOTA_INVALID_MODE_MESSAGE = "成员配額模式必须是 unlimited / fixed / daily 之一。";
export const MEMBER_QUOTA_ADMIN_LOCKED_MESSAGE =
  "团队管理员（admin）默认不限额度，且不可被设置配額。";
export const MEMBER_QUOTA_ABOVE_TEAM_REMAINING_MESSAGE =
  "成员配額不得超过团队剩余可用额度。";
export const TEAM_QUOTA_RECLAIM_ABOVE_REMAINING_MESSAGE =
  "回收额度不得超过团队剩余额度。";

/** UTC+8 的日界：每日 00:00（UTC+8）重置，且**不累積**。 */
export const DAILY_QUOTA_EPOCH_OFFSET_MINUTES = 8 * 60;

/**
 * 當前所屬的「配額日」字串（`YYYY-MM-DD`，UTC+8 日界）。
 * 純函式，吃毫秒時戳 → 便於測試跨日重置。
 */
export function quotaDayKey(nowMs: number, offsetMinutes = DAILY_QUOTA_EPOCH_OFFSET_MINUTES): string {
  const shifted = new Date(nowMs + offsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 下一次重置時刻（UTC+8 00:00，毫秒時戳）。 */
export function nextQuotaResetMs(nowMs: number, offsetMinutes = DAILY_QUOTA_EPOCH_OFFSET_MINUTES): number {
  const step = 24 * 60 * 60 * 1000;
  const shifted = nowMs + offsetMinutes * 60_000;
  const nextShifted = Math.floor(shifted / step) * step + step;
  return nextShifted - offsetMinutes * 60_000;
}

/** 每日已用計數的有效值：跨日 ⇒ 歸零（**不累積**）。純函式。 */
export function effectiveDailyUsed(input: {
  /** 盤上記的日界（`YYYY-MM-DD`）。 */
  storedDay: string | null;
  storedUsed: number;
  nowMs: number;
  offsetMinutes?: number;
}): number {
  const today = quotaDayKey(input.nowMs, input.offsetMinutes);
  if (input.storedDay !== today) return 0;
  return Number.isFinite(input.storedUsed) && input.storedUsed > 0 ? Math.floor(input.storedUsed) : 0;
}

// ─────────────────────────────────────────── 資料結構

/** 團隊層配額（意圖層；不含任何餘額數字）。 */
export interface TeamQuotaLimit {
  teamUserId: number;
  /** none = no points limit（預設，消耗主帳號可分配餘額）；fixed = allocated fixed team points。 */
  mode: TeamQuotaMode;
  /** mode==="fixed" 時的團隊總額上限（new-api quota 單位）。 */
  fixedQuota: number;
  /** 該團隊**已分配給成員**的額度合計（讀自配額可視面，非本地帳本）。 */
  allocatedToMembers: number;
  /**
   * 團隊可再分配餘量 = fixedQuota − allocatedToMembers（mode==="none" ⇒ 主帳手上餘額）。
   * 呼叫端拿它當「回收上限」與「成員固定額上限」的執法依據。
   */
  remaining: number;
}

/** 成員層配額設定（意圖層；dailyUsed 是**速率觀察值**，不是餘額）。 */
export interface MemberQuotaLimit {
  memberUserId: number;
  mode: MemberQuotaMode;
  /** mode==="fixed" 時的固定額度（new-api quota 單位）。 */
  fixedQuota: number;
  /** mode==="daily" 時的每日額度（new-api quota 單位）。 */
  dailyQuota: number;
  /** 當日已用（已按日界歸零）。 */
  dailyUsed: number;
  /** 剩餘可消耗 = 每日額度 − 當日已用（daily 模式）或 fixedQuota（fixed 模式）；unlimited ⇒ null。 */
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

// ─────────────────────────────────────────── 純函式：判定與邊界

export interface QuotaDecision {
  ok: boolean;
  code?: string;
  message?: string;
}

/**
 * 成員配額設定授權（純函式，fail-closed）：
 *   - 呼叫方必須是 owner（Main）或 admin（Team Admin）；member → 拒。
 *   - **Team Admin 預設 unlimited 且不可被設配額**（Dramagic 逐字：
 *     「team Admin is set to unlimited by default and cannot have a quota set」）
 *     ⇒ 目標角色是 admin/owner 時，只接受 unlimited；要設 fixed/daily 一律拒。
 */
export function canSetMemberQuota(input: {
  actorRole: TeamRole | null;
  targetRole: TeamRole;
  mode: MemberQuotaMode;
}): QuotaDecision {
  if (input.actorRole === null) {
    return { ok: false, code: "forbidden", message: "无权设置成员配額。" };
  }
  if (input.actorRole !== "owner" && input.actorRole !== "admin") {
    return { ok: false, code: "forbidden", message: "只有团队创建者或管理员可以设置成员配額。" };
  }
  if ((input.targetRole === "admin" || input.targetRole === "owner") && input.mode !== "unlimited") {
    return { ok: false, code: "admin_unlimited_locked", message: MEMBER_QUOTA_ADMIN_LOCKED_MESSAGE };
  }
  return { ok: true };
}

/**
 * 成員固定額上界判定（純函式）：不得超過團隊剩餘（Dramagic 逐字
 * 「上限不得超過團隊剩餘」）。`teamRemaining === null` = 不限 ⇒ 無上界。
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
    return { ok: false, code: "invalid_quota", message: "配額必须是不小于 0 的数值。" };
  }
  if (asked > input.teamRemaining) {
    return { ok: false, code: "exceeds_team_remaining", message: MEMBER_QUOTA_ABOVE_TEAM_REMAINING_MESSAGE };
  }
  return { ok: true };
}

/**
 * 團隊固定額設定判定（純函式）：
 *   - fixed 的額度不得低於**已分配給成員**的部分（否則等於超賣）。
 *   - 改回 `none`（不限）⇒ 剩餘全數回收：回傳 `reclaim` = 已分配給成員的全部額度，
 *     由呼叫端交既有轉移通路執行（本模組不碰數字）。
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
    return { ok: false, code: "invalid_quota", message: "配額必须是不小于 0 的数值。", reclaim: 0 };
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
 * 回收額度判定（純函式）：**回收上限 = 團隊剩餘**。
 * `teamRemaining === null`（不限）⇒ 無上限。
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

/** 每日額度是否仍可消耗（**速率**判定，不預扣、不寫任何帳本）。 */
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

// ─────────────────────────────────────────── 映射層存取（意圖欄位）

/** 治理/配額映射層可用性（C 端 Vercel 無控制面庫 ⇒ 不可用）。 */
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

/** 寫入團隊配額意圖（**只寫意圖欄位，不寫任何餘額**）。 */
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

/** 寫入成員配額意圖（**只寫意圖與速率計數，不寫任何餘額**）。 */
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

// ─────────────────────────────────────────── 服務層（裁決 + 意圖寫入）
//
// 這一層**只寫意圖欄位**：不呼叫 member-quota 的轉移通路、不呼叫上游、
// 不寫任何帳本。實際點數移動由呼叫端（管理面）另行交 member-quota 執行。

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
 * 設定團隊配額（分配／回收／設為不限），**只翻意圖欄位**。
 *
 * 邊界（純函式 teamQuotaReclaim 裁決，此處只負責讀數與寫入）：
 *   - fixed 不得低於已分配給成員的部分（超賣保護）。
 *   - 改回 none ⇒ `reclaim` = 已分配給成員的全部額度（由呼叫端交既有轉移通路執行）。
 *   - 回收不得超過團隊剩餘（reclaimWithinRemaining）。
 */
export async function setTeamQuotaLimit(
  input: { teamUserId: number; actorRole: TeamRole | null; mode: TeamQuotaMode; fixedQuota: number },
  deps: { sql?: GenerationSql; allocated?: number } = {},
): Promise<QuotaLimitResult<{ mode: TeamQuotaMode; fixedQuota: number; reclaim: number; unchanged: boolean }>> {
  if (!quotaLimitStoreEnabled()) {
    return qfail(503, "store_unavailable", "团队配額映射层不可用（控制面数据库未配置）。");
  }
  if (input.actorRole !== "owner") {
    return qfail(403, "forbidden", "只有团队主账号可以设置团队配額。");
  }
  if (!isTeamQuotaMode(input.mode)) {
    return qfail(400, "invalid_mode", TEAM_QUOTA_INVALID_MODE_MESSAGE);
  }
  if (!Number.isFinite(input.fixedQuota) || input.fixedQuota < 0) {
    return qfail(400, "invalid_quota", "配額必须是不小于 0 的数值。");
  }
  const sql = deps.sql ?? getGenerationSql();
  try {
    const current = await readTeamQuotaLimitRow(input.teamUserId, sql);
    // 已分配給成員的額度：讀配額可視面（上游權威），不在本地記帳。
    const allocated = await readAllocatedToMembers(input.teamUserId, sql, deps.allocated);
    const decision = teamQuotaReclaim({
      nextMode: input.mode,
      nextFixedQuota: Math.floor(input.fixedQuota),
      allocatedToMembers: allocated,
    });
    if (!decision.ok) return qfail(409, decision.code as QuotaLimitFailureCode, decision.message ?? "");
    // 回收檢查：回收額度不得超過團隊剩餘（本團隊剩餘＝fixed 上限 − 已分配）。
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
    return qfail(503, "store_unavailable", "团队配額暂不可用，请稍后重试。");
  }
}

/**
 * 設定成員配額（fixed／daily／unlimited），**只寫意圖與上限**。
 *
 * 邊界：admin/owner 目標角色只接受 unlimited（Dramagic 逐字）；member 角色
 * 的配額不得超過團隊剩餘；呼叫方須為 owner 或 admin 且不得設定 admin 的配額。
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
    return qfail(503, "store_unavailable", "成员配額映射层不可用（控制面数据库未配置）。");
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
    return qfail(400, "invalid_quota", "配額必须是不小于 0 的数值。");
  }
  const sql = deps.sql ?? getGenerationSql();
  try {
    const team = await readTeamQuotaLimitRow(input.teamUserId, sql);
    const allocated = await readAllocatedToMembers(input.teamUserId, sql, deps.allocated);
    // 團隊剩餘：none ⇒ null（不限，無上界）；fixed ⇒ 上限 − 已分配。
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
      return qfail(404, "member_not_found", `未找到成员账号 ${input.targetMemberUserId} 的配額记录。`);
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
          // 改模式 ⇒ 日計數起新的一天（避免殘留舊模式的當日已用）。
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
    return qfail(503, "store_unavailable", "成员配額暂不可用，请稍后重试。");
  }
}

/**
 * 已分配給成員的額度合計。
 *
 * 這裡刻意**不讀本地表也不記帳**：語義上「已分配」是上游權威事實
 *（成員桶 granted 之和 ＝ member-quota.readTeamQuotaView().allocated）。
 * 讀不到上游（new-api 不可達／映射層不在）⇒ 回 0，並由呼叫端從嚴處理上界；
 * 真正的超賣保護仍在 member-quota.ts 的轉移通路（先扣後加 + 團隊鎖）。
 *
 * 測試注入點 `deps.allocated` 讓上界判定可在無 DB 環境下逐格驗證。
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

/** 團隊＋成員配額意圖的可視面（純讀意圖欄位，不含任何帳本資料）。 */
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

