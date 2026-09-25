// B1 成員點數配額（REQ-B1）：團隊-成員-配額的映射與分配層（user 層模型）。
//
// 分工（唯一權威源鐵律，見記憶 control-plane-billing-paradigm）：
//   - new-api 是配額唯一權威源：主帳 = 團隊主帳 user 的 users.quota，成員桶 =
//     成員 **user** 自己的 users.quota。**本模組不存任何點數數字**——本地表
//     team_member_quota（migration 019）只存歸屬（哪個成員 user 屬於哪個團隊
//     主帳）與意圖（enabled/label）。禁影子帳本。
//   - 成員 = new-api 另一個 user（子帳號）。配額桶在 user 層、由內核一律執法
//     （unlimited_quota 只是 token 層屬性；admin 憑證對他人 token 是 owner-scoped
//     讀不到，token 桶模型已被 09-23 只讀探針硬否定）。
//   - 分配 = **轉移**：主帳 user 扣 Δ、成員 user 加 Δ（setGatewayUserImageQuota /
//     adjustGatewayUserQuotaExact 的既有生產通路）。寫的是絕對目標值（不是 delta
//     疊加），所以重放同一請求天然冪等：目標與現值相同時連上游寫入都不發生。
//     「先扣後加」＋失敗回滾 ⇒ 兩條腿不平衡不會靜默留下（不憑空印額度）。
//   - 消耗 = new-api 內核自己扣成員 user 的 quota：成員扣費（內核）／主帳扣減
//     （分配那一刻轉出）／餘額顯示（主帳 + Σ成員桶）三處可逐筆對帳、總額守恆。
//   - 歸屬映射免新表：biz_api_key.user_id（migration 007）就是「成員 key ↔
//     new-api user」映射；012 的 biz_key_newapi_token 映射層已於 2026-09-23 拔除
//     （G1 裁定：預檢只按 user 額度閘），本模組從不依賴它。
//
// 不變量：
//   ① 成員 user_id ≠ team_user_id（成員是另一個 user，不是主帳自己）；
//      同一 user 的多把 key 共用同一桶。成員同時只能屬一個團隊（跨團隊 403）。
//   ② 本次劃出差額 ≤ 主帳手上餘額（轉移模型的不超賣條件）＋團隊鎖串行化；
//      消耗不比分配少：主帳 + Σ成員桶 = 剩餘總額，Σ已用 + 剩餘總額 = 常數。
//   ③ 分配/回收在同一團隊 advisory lock 內完成（多成員並發不超賣）。
//   ④ 目標值不得低於該成員已消耗（已消耗部分不可回收）。
//
// 分配/回收是同一個操作：target > 現值 = 劃額度，target < 現值 = 回收，
// 相等 = 幂等 no-op。全部金額單位是 new-api quota（1 幣 = QUOTA_PER_COIN）。

import { randomUUID } from "node:crypto";

import { adjustGatewayUserQuotaExact, fetchGatewayUser } from "@/lib/gateway-admin";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { ensureAccountBaselines, recordTransfer } from "./account-ledger";
import { generationControlPlaneEnabled, getGenerationSql, type GenerationSql } from "./database";

/** 消耗面 402 文案：必須與主帳不足（quota-precheck 的「余额不足，请先充值。」）區分。 */
export const MEMBER_QUOTA_INSUFFICIENT_MESSAGE = "成员额度不足，请联系团队主账号分配额度。";
/** 成員額度被停用（enabled=false）——同 402 契約，文案不同。 */
export const MEMBER_QUOTA_DISABLED_MESSAGE = "该成员额度已停用，请联系团队主账号。";

export interface TeamMemberRecord {
  id: string;
  teamUserId: number;
  /** 成員 new-api user（配額桶所在）。 */
  memberUserId: number;
  /** 登記時使用的成員 biz key（手柄；同一 user 可能有多把）。 */
  memberKeyId: string;
  displayName: string;
  enabled: boolean;
}

/** 成員 user 配額桶的權威讀數（new-api users.quota / used_quota）。 */
export interface MemberQuotaSnapshot {
  memberUserId: number;
  /** 該成員累計被授予的額度上限 = users.quota + users.used_quota。 */
  granted: number;
  /** 該帳號累計消耗 = users.used_quota。 */
  used: number;
  /** 真正的桶 = users.quota（可為負：真實狀態不夾到 0）。 */
  remaining: number;
  /**
   * user 層沒有 unlimited 概念——users.quota 由內核一律執法（unlimited_quota
   * 只是 token 層屬性）。此欄位保留為契約的一部分（預檢/可視面的第三態判定
   * 沿用舊形而語義恆 false），本模型不會產生 true。
   */
  unlimited: boolean;
}

type MemberRow = {
  id: string;
  team_user_id: number;
  member_user_id: number;
  member_key_id: string;
  display_name: string | null;
  enabled: boolean;
};

function mapMember(row: MemberRow): TeamMemberRecord {
  return {
    id: row.id,
    teamUserId: Number(row.team_user_id),
    memberUserId: Number(row.member_user_id),
    memberKeyId: row.member_key_id,
    displayName: row.display_name ?? "",
    enabled: row.enabled !== false,
  };
}

/** Postgres 可用作映射層嗎（C 端 Vercel 沒這個庫，必須走降級）。 */
export function memberQuotaStoreEnabled(): boolean {
  return generationControlPlaneEnabled();
}

export function toCoins(quota: number): number {
  return Math.round((quota / QUOTA_PER_COIN) * 1e6) / 1e6;
}

// ─────────────────────────────────────────── 映射層存取

/**
 * 預檢熱路徑：這個 user 是不是某團隊的成員（不是 → 完全不受成員配額執法）。
 * 成員判定按 **user_id**（配額桶在 user 層），不按 key 也不按 token。
 */
export async function findMemberByUserId(
  memberUserId: number,
  sql?: GenerationSql,
): Promise<TeamMemberRecord | null> {
  if (!memberQuotaStoreEnabled()) return null;
  const db = sql ?? getGenerationSql();
  const rows = await db<MemberRow[]>`
    SELECT id, team_user_id, member_user_id, member_key_id, display_name, enabled
    FROM team_member_quota
    WHERE member_user_id = ${memberUserId}
    LIMIT 1
  `;
  return rows[0] ? mapMember(rows[0]) : null;
}

export async function listTeamMembers(
  teamUserId: number,
  sql?: GenerationSql,
): Promise<TeamMemberRecord[]> {
  if (!memberQuotaStoreEnabled()) return [];
  const db = sql ?? getGenerationSql();
  const rows = await db<MemberRow[]>`
    SELECT id, team_user_id, member_user_id, member_key_id, display_name, enabled
    FROM team_member_quota
    WHERE team_user_id = ${teamUserId}
    ORDER BY created_at ASC
  `;
  return rows.map(mapMember);
}

/** 歸屬登記/更新。點數數字不入庫——只寫身份與意圖。 */
export async function upsertTeamMember(
  member: {
    id: string;
    teamUserId: number;
    memberUserId: number;
    memberKeyId: string;
    displayName?: string;
    enabled?: boolean;
  },
  sql?: GenerationSql,
): Promise<boolean> {
  if (!memberQuotaStoreEnabled()) return false;
  const db = sql ?? getGenerationSql();
  await db`
    INSERT INTO team_member_quota (id, team_user_id, member_user_id, member_key_id, display_name, enabled)
    VALUES (
      ${member.id}, ${member.teamUserId}, ${member.memberUserId}, ${member.memberKeyId},
      ${member.displayName ?? ""}, ${member.enabled ?? true}
    )
    ON CONFLICT (member_user_id) DO UPDATE SET
      team_user_id = EXCLUDED.team_user_id,
      display_name = EXCLUDED.display_name,
      enabled = EXCLUDED.enabled,
      updated_at = now()
  `;
  return true;
}

type BindingRow = {
  id: string;
  label: string | null;
  user_id: number;
};

export interface MemberBinding {
  memberKeyId: string;
  /** biz_api_key.user_id：成員 key 對應的 new-api user（= 成員的配額桶所在）。 */
  userId: number;
  label: string;
}

/** 成員 key 的歸屬鏈：biz_api_key.user_id（migration 007，免新表）。 */
export async function resolveMemberBinding(
  memberKeyId: string,
  sql?: GenerationSql,
): Promise<MemberBinding | null> {
  if (!memberQuotaStoreEnabled()) return null;
  const db = sql ?? getGenerationSql();
  const rows = await db<BindingRow[]>`
    SELECT id, label, user_id
    FROM biz_api_key
    WHERE id = ${memberKeyId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    memberKeyId: row.id,
    userId: Number(row.user_id),
    label: row.label ?? "",
  };
}

// ─────────────────────────────────────────── new-api 權威讀數

type GatewayUserReader = typeof fetchGatewayUser;

/**
 * 讀成員 user 的配額桶（new-api 權威源）。查不到/上游抽風返回 null——調用方
 * 自行決定 fail-closed 還是 fail-open（預檢一律 fail-closed）。
 */
export async function readMemberQuota(
  memberUserId: number,
  deps: { fetchUser?: GatewayUserReader } = {},
): Promise<MemberQuotaSnapshot | null> {
  if (!Number.isInteger(memberUserId) || memberUserId <= 0) return null;
  const fetchUser = deps.fetchUser ?? fetchGatewayUser;
  let user: Awaited<ReturnType<GatewayUserReader>>;
  try {
    user = await fetchUser(memberUserId);
  } catch {
    return null;
  }
  if (!user || !Number.isFinite(user.quota)) return null;
  const used = Number.isFinite(user.used_quota) ? Math.max(0, Number(user.used_quota)) : 0;
  const remaining = Number(user.quota);
  return { memberUserId, granted: remaining + used, used, remaining, unlimited: false };
}

// ─────────────────────────────────────────── 可視面

export interface TeamQuotaMemberView {
  memberKeyId: string;
  memberUserId: number;
  displayName: string;
  enabled: boolean;
  granted: number;
  used: number;
  remaining: number;
  unlimited: boolean;
  coins: { granted: number; used: number; remaining: number };
  /** 讀不到上游時的誠實第三態（不畫假數字）。 */
  unavailable: boolean;
}

export interface TeamQuotaView {
  teamUserId: number;
  /** 主帳手上餘額 = 團隊主帳 user 的 users.quota。 */
  master: { remaining: number; coins: number };
  /** 累計劃給成員的上限（= Σ 成員 granted）。 */
  allocated: number;
  allocatedCoins: number;
  /** Σ 成員已消耗。 */
  used: number;
  usedCoins: number;
  /** 還能再劃出去 = 主帳手上餘額（轉移模型：劃出的錢已在成員桶裡，不再佔主帳）。 */
  unallocated: number;
  unallocatedCoins: number;
  /** 團隊未消耗總額 = 主帳手上餘額 + Σ 成員桶剩餘（消耗後剩下的錢全在這兩處）。 */
  team: { remaining: number; coins: number };
  members: TeamQuotaMemberView[];
}

/** 主帳總額／已分配／各成員額度與消耗。全部數字當場讀 new-api，無本地帳本。 */
export async function readTeamQuotaView(
  input: { teamUserId: number },
  deps: { sql?: GenerationSql; fetchUser?: GatewayUserReader } = {},
): Promise<TeamQuotaView | null> {
  const fetchUser = deps.fetchUser ?? fetchGatewayUser;
  let masterQuota: number;
  try {
    const master = await fetchUser(input.teamUserId);
    if (!master || !Number.isFinite(master.quota)) return null;
    masterQuota = Number(master.quota);
  } catch {
    return null;
  }

  const members = await listTeamMembers(input.teamUserId, deps.sql);
  const views: TeamQuotaMemberView[] = [];
  let allocated = 0;
  let used = 0;
  let held = 0;

  for (const member of members) {
    const snapshot = await readMemberQuota(member.memberUserId, { fetchUser });
    if (!snapshot) {
      views.push({
        memberKeyId: member.memberKeyId,
        memberUserId: member.memberUserId,
        displayName: member.displayName,
        enabled: member.enabled,
        granted: 0,
        used: 0,
        remaining: 0,
        unlimited: false,
        coins: { granted: 0, used: 0, remaining: 0 },
        unavailable: true,
      });
      continue;
    }
    allocated += snapshot.granted;
    used += snapshot.used;
    held += snapshot.remaining;
    views.push({
      memberKeyId: member.memberKeyId,
      memberUserId: member.memberUserId,
      displayName: member.displayName,
      enabled: member.enabled,
      granted: snapshot.granted,
      used: snapshot.used,
      remaining: snapshot.remaining,
      unlimited: snapshot.unlimited,
      coins: {
        granted: toCoins(snapshot.granted),
        used: toCoins(snapshot.used),
        remaining: toCoins(snapshot.remaining),
      },
      unavailable: false,
    });
  }

  const teamRemaining = masterQuota + held;
  return {
    teamUserId: input.teamUserId,
    master: { remaining: masterQuota, coins: toCoins(masterQuota) },
    allocated,
    allocatedCoins: toCoins(allocated),
    used,
    usedCoins: toCoins(used),
    unallocated: masterQuota,
    unallocatedCoins: toCoins(masterQuota),
    team: { remaining: teamRemaining, coins: toCoins(teamRemaining) },
    members: views,
  };
}

// ─────────────────────────────────────────── 分配／回收

export type AllocationFailureCode =
  | "invalid_target"
  | "member_key_not_found"
  | "team_mismatch"
  | "target_below_used"
  | "insufficient_team_quota"
  | "member_quota_unavailable";

export type AllocationResult =
  | {
      ok: true;
      memberKeyId: string;
      memberUserId: number;
      granted: number;
      used: number;
      remaining: number;
      /** 本次實際轉移的 quota（正 = 劃出，負 = 回收，0 = 幂等 no-op）。 */
      transferred: number;
      /** true = 目標與現值相同，未動上游（幂等 no-op）。 */
      unchanged: boolean;
    }
  | { ok: false; status: 400 | 402 | 403 | 404 | 409 | 503; code: AllocationFailureCode; message: string };

function fail(
  status: 400 | 402 | 403 | 404 | 409 | 503,
  code: AllocationFailureCode,
  message: string,
): AllocationResult {
  return { ok: false, status, code, message };
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** 團隊級串行化：同一主帳的分配/回收不並發（多成員並發不超賣的實現點）。 */
export type TeamLock = <T>(teamUserId: number, fn: (tx: GenerationSql) => Promise<T>) => Promise<T>;

async function defaultTeamLock<T>(
  sql: GenerationSql,
  teamUserId: number,
  fn: (tx: GenerationSql) => Promise<T>,
): Promise<T> {
  // postgres.js 的事務返回值類型是 UnwrapPromiseArray<T>，這裡斷言回 T。
  return (await sql.begin(async (tx) => {
    // 事務級 advisory lock：同團隊的分配/回收排隊執行，事務結束自動釋放。
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`team-member-quota:${teamUserId}`}))`;
    // 事務句柄當查詢接口交下去（同一連接）：避免「等鎖佔著一條連接、拿到鎖
    // 又要第二條連接」在連接池（默認 max=5）上打成的自鎖死。
    return await fn(tx as unknown as GenerationSql);
  })) as T;
}

type UserQuotaAdjuster = typeof adjustGatewayUserQuotaExact;

/**
 * 主帳 → 成員的額度轉移（amount > 0）。
 *
 * 先扣後加：任何一步失敗都不會出現「憑空多出來的額度」。第二條腿失敗時回滾
 * 第一條腿；回滾也失敗（上游兩帳不平衡）→ 拋出的訊息講明需人工核對，不假裝沒事。
 */
async function transferQuota(
  fromUserId: number,
  toUserId: number,
  amount: number,
  adjust: UserQuotaAdjuster,
): Promise<void> {
  if (!Number.isFinite(amount) || amount <= 0) return;
  const rounded = Math.round(amount);
  if (rounded === 0) return;
  await adjust(fromUserId, -rounded);
  try {
    await adjust(toUserId, rounded);
  } catch (creditError) {
    try {
      await adjust(fromUserId, rounded);
    } catch (rollbackError) {
      throw new Error(
        `额度转移失败且回滚失败（账户 ${fromUserId} 已扣 ${rounded}，账户 ${toUserId} 未加），需人工核对：${reasonOf(creditError)} / ${reasonOf(rollbackError)}`,
      );
    }
    throw new Error(`额度转移失败（已回滚，两帐户额度未改变）：${reasonOf(creditError)}`);
  }
}

export interface AllocateMemberQuotaInput {
  /** 團隊主帳（出資方 = 呼叫方 B key 的 user_id）。 */
  teamUserId: number;
  memberKeyId: string;
  /** 目標額度上限（new-api quota，絕對值）。 */
  targetGranted: number;
}

export interface AllocateDeps {
  sql?: GenerationSql;
  fetchUser?: GatewayUserReader;
  adjustUserQuota?: UserQuotaAdjuster;
  /** 測試注入：默認走 Postgres 事務級 advisory lock。 */
  withTeamLock?: TeamLock;
  /** 歸屬登記 id 生成（默認 crypto.randomUUID）。 */
  newMemberId?: () => string;
  /** 轉移身分證 id 生成（默認 crypto.randomUUID）；同一 id 的帳本兩條腿共用。 */
  newTransferId?: () => string;
}

/**
 * 劃額度 / 回收 / 調整（同一操作，絕對目標值 ⇒ 幂等）。
 *
 * 順序：校驗目標 → 解析歸屬（key→user）→ 團隊鎖內 讀成員桶現值 → 判已消耗不可
 * 回收 → 讀主帳手上餘額 → 判本次差額是否劃得出來 → 轉移（先扣後加＋回滾）→
 * 登記歸屬。主帳不足時拒絕並給可執行錯誤（可先充值或回收其他成員額度）。
 */
export async function allocateMemberQuota(
  input: AllocateMemberQuotaInput,
  deps: AllocateDeps = {},
): Promise<AllocationResult> {
  const target = Math.round(Number(input.targetGranted));
  if (!Number.isFinite(target) || target < 0) {
    return fail(400, "invalid_target", "目标额度必须是不小于 0 的 quota 数值。");
  }
  if (!Number.isInteger(input.teamUserId) || input.teamUserId <= 0) {
    return fail(503, "member_quota_unavailable", "团队主账号不可用（缺少有效的计费用户）。");
  }
  // 映射層不在（C 端 Vercel 沒有控制面庫）→ 服務不可用，不是「成員不存在」。
  if (!memberQuotaStoreEnabled()) {
    return fail(503, "member_quota_unavailable", "成员额度映射层不可用（控制面数据库未配置）。");
  }

  const binding = await resolveMemberBinding(input.memberKeyId, deps.sql);
  if (!binding) {
    return fail(
      404,
      "member_key_not_found",
      `未找到成员密钥 ${input.memberKeyId}，或控制面数据库不可用。`,
    );
  }
  const memberLabel = binding.label || input.memberKeyId;
  // 成員必須是「另一個 user」：主帳自己的 key 當成員 = 自己給自己劃額度，禁止。
  if (binding.userId === input.teamUserId) {
    return fail(
      403,
      "team_mismatch",
      `密钥 ${memberLabel} 的计费账号就是团队主账号 ${input.teamUserId} 本身；主账号不能作为成员，请改用成员自己的密钥。`,
    );
  }
  // 一個成員 user 只屬一個團隊：已被別家團隊登記 ⇒ 不可跨團隊分配。
  const owner = await findMemberByUserId(binding.userId, deps.sql);
  if (owner && owner.teamUserId !== input.teamUserId) {
    return fail(
      403,
      "team_mismatch",
      `成员账号 ${binding.userId} 已归属团队主账号 ${owner.teamUserId}，不可跨团队分配。`,
    );
  }

  const sql = deps.sql ?? getGenerationSql();
  const withTeamLock: TeamLock =
    deps.withTeamLock ?? ((teamUserId, fn) => defaultTeamLock(sql, teamUserId, fn));

  try {
    return await withTeamLock(input.teamUserId, async (tx): Promise<AllocationResult> => {
      const members = await listTeamMembers(input.teamUserId, tx);
      const existing = members.find((member) => member.memberUserId === binding.userId) ?? null;
      const fetchUser = deps.fetchUser ?? fetchGatewayUser;
      const adjustUserQuota = deps.adjustUserQuota ?? adjustGatewayUserQuotaExact;

      // 一律讀現值（不論是否已登記）：成員桶可能早就帶著額度，按 0 起算會把
      // 主帳的錢多劃出去。讀不到就 fail-closed。
      const current = await readMemberQuota(binding.userId, { fetchUser });
      if (!current) {
        return fail(503, "member_quota_unavailable", "成员当前额度读不到（new-api 不可达），请稍后重试。");
      }

      if (target < current.used) {
        return fail(
          409,
          "target_below_used",
          `成员已消耗 ${toCoins(current.used)} 币，目标额度不能低于该值（已消耗部分不可回收）。`,
        );
      }

      let masterQuota: number;
      try {
        const master = await fetchUser(input.teamUserId);
        if (!master || !Number.isFinite(master.quota)) {
          return fail(503, "member_quota_unavailable", "团队主账号额度读不到（new-api 不可达），请稍后重试。");
        }
        masterQuota = Number(master.quota);
      } catch {
        return fail(503, "member_quota_unavailable", "团队主账号额度读不到（new-api 不可达），请稍后重试。");
      }

      const delta = target - current.granted;
      // 不變量②（user 層轉移模型）：劃出去的錢要從主帳手上真的拿得出來。
      // 成員桶是真錢不是上限貼紙，所以可分配餘額 = 主帳手上餘額（劃出去的已不在主帳）。
      if (delta > masterQuota) {
        return fail(
          402,
          "insufficient_team_quota",
          `团队主账号额度不足：本次需要 ${toCoins(delta)} 币，主账号可分配余额 ${toCoins(masterQuota)} 币。请先充值，或先回收其他成员的额度。`,
        );
      }

      const transferred = delta;
      let confirmed: MinimalUserState;
      if (delta === 0) {
        // 幂等 no-op：目標與現值相同，不動上游。
        confirmed = { remaining: current.remaining, used: current.used };
      } else {
        // 轉移身分證：一次真實的上游雙腿轉移配一個 id，帳本兩條腿共用（同一事務寫入）。
        // 重放的請求在 delta===0 分支就早退、根本不會產生新 id ⇒ 帳本天然不重複。
        const transferId = (deps.newTransferId ?? randomUUID)();
        // REQ-E1a 順序鐵律：先種基線（取的是「動上游之前」的 users.quota），再轉移，最後記帳。
        // 先轉移後種基線 = 基線已含這筆轉移 + 帳本再記一次 = 雙算。基線不可得則放棄記帳
        // （錢路照走），差額由對帳報告負責。
        const baselineReady = await ensureAccountBaselines([input.teamUserId, binding.userId], { sql: tx, fetchUser });
        try {
          // delta > 0：主帳 → 成員；delta < 0：成員 → 主帳（回收）。
          if (delta > 0) {
            await transferQuota(input.teamUserId, binding.userId, delta, adjustUserQuota);
          } else {
            await transferQuota(binding.userId, input.teamUserId, -delta, adjustUserQuota);
          }
        } catch (error) {
          console.error(
            `[member-quota] allocate failed team=${input.teamUserId} memberKey=${input.memberKeyId} memberUser=${binding.userId} target=${target}: ${reasonOf(error)}`,
          );
          return fail(503, "member_quota_unavailable", "上游调整成员额度失败，请稍后重试。");
        }
        // REQ-E1a 雙寫：上游兩腿都動了才記我方帳本（transfer_out/transfer_in 同一事務）。
        // 記帳失敗不擋路：差額由 E1b 對帳報告逐筆指出（不假裝兩層一致）。
        const ledger = baselineReady
          ? await recordTransfer({
              teamUserId: input.teamUserId,
              memberUserId: binding.userId,
              amountQuota: delta,
              transferId,
              source: "member-quota",
              memberKeyId: input.memberKeyId,
            }, { sql: tx, fetchUser })
          : { posted: false, reason: "基線不可得（未記帳）" };
        if (!ledger.posted) {
          console.error(
            `[member-quota] team=${input.teamUserId} memberUser=${binding.userId} 轉移帳本未落地（${ledger.reason}）——已由對帳報告負責`,
          );
        }
        // 上游寫入成功後覆核：拿不回權威讀數就不回報成功（不畫假數字）。
        const recheck = await readMemberQuota(binding.userId, { fetchUser });
        if (!recheck) {
          console.error(
            `[member-quota] allocate wrote team=${input.teamUserId} memberUser=${binding.userId} but recheck failed`,
          );
          return fail(503, "member_quota_unavailable", "额度已写入上游，但无法复核最终结果，请稍后重试或联系管理员。");
        }
        confirmed = { remaining: recheck.remaining, used: recheck.used };
      }

      if (!existing) {
        await upsertTeamMember(
          {
            id: (deps.newMemberId ?? randomUUID)(),
            teamUserId: input.teamUserId,
            memberUserId: binding.userId,
            memberKeyId: input.memberKeyId,
            displayName: binding.label,
            enabled: true,
          },
          tx,
        );
      }

      const remaining = confirmed.remaining;
      const used = Math.max(0, confirmed.used);
      return {
        ok: true,
        memberKeyId: input.memberKeyId,
        memberUserId: binding.userId,
        granted: remaining + used,
        used,
        remaining,
        transferred,
        unchanged: delta === 0,
      };
    });
  } catch (error) {
    const reason = reasonOf(error);
    console.error(`[member-quota] allocate aborted team=${input.teamUserId}: ${reason}`);
    return fail(503, "member_quota_unavailable", "成员额度分配暂不可用，请稍后重试。");
  }
}

interface MinimalUserState {
  remaining: number;
  used: number;
}
