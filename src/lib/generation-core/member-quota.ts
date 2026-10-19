// B1 成员点数配额（REQ-B1）：团队-成员-配额的映射与分配层（user 层模型）。
//
// 分工（唯一权威源铁律，见记忆 control-plane-billing-paradigm）：
//   - new-api 是配额唯一权威源：主帐 = 团队主帐 user 的 users.quota，成员桶 =
//     成员 **user** 自己的 users.quota。**本模组不存任何点数数字**——本地表
//     team_member_quota（migration 019）只存归属（哪个成员 user 属于哪个团队
//     主帐）与意图（enabled/label）。禁影子帐本。
//   - 成员 = new-api 另一个 user（子帐号）。配额桶在 user 层、由内核一律执法
//     （unlimited_quota 只是 token 层属性；admin 凭证对他人 token 是 owner-scoped
//     读不到，token 桶模型已被 09-23 只读探针硬否定）。
//   - 分配 = **转移**：主帐 user 扣 Δ、成员 user 加 Δ（setGatewayUserImageQuota /
//     adjustGatewayUserQuotaExact 的既有生产通路）。写的是绝对目标值（不是 delta
//     叠加），所以重放同一请求天然幂等：目标与现值相同时连上游写入都不发生。
//     「先扣后加」＋失败回滚 ⇒ 两条腿不平衡不会静默留下（不凭空印额度）。
//   - 消耗 = new-api 内核自己扣成员 user 的 quota：成员扣费（内核）／主帐扣减
//     （分配那一刻转出）／余额显示（主帐 + Σ成员桶）三处可逐笔对帐、总额守恒。
//   - 归属映射免新表：biz_api_key.user_id（migration 007）就是「成员 key ↔
//     new-api user」映射；012 的 biz_key_newapi_token 映射层已于 2026-09-23 拔除
//     （G1 裁定：预检只按 user 额度闸），本模组从不依赖它。
//
// 不变量：
//   ① 成员 user_id ≠ team_user_id（成员是另一个 user，不是主帐自己）；
//      同一 user 的多把 key 共用同一桶。成员同时只能属一个团队（跨团队 403）。
//   ② 本次划出差额 ≤ 主帐手上余额（转移模型的不超卖条件）＋团队锁串行化；
//      消耗不比分配少：主帐 + Σ成员桶 = 剩余总额，Σ已用 + 剩余总额 = 常数。
//   ③ 分配/回收在同一团队 advisory lock 内完成（多成员并发不超卖）。
//   ④ 目标值不得低于该成员已消耗（已消耗部分不可回收）。
//
// 分配/回收是同一个操作：target > 现值 = 划额度，target < 现值 = 回收，
// 相等 = 幂等 no-op。全部金额单位是 new-api quota（1 币 = QUOTA_PER_COIN）。

import { randomUUID } from "node:crypto";

import { adjustGatewayUserQuotaExact, fetchGatewayUser } from "@/lib/gateway-admin";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { ensureAccountBaselines, recordTransfer } from "./account-ledger";
import { generationControlPlaneEnabled, getGenerationSql, type GenerationSql } from "./database";

/** 消耗面 402 文案：必须与主帐不足（quota-precheck 的「余额不足，请先充值。」）区分。 */
export const MEMBER_QUOTA_INSUFFICIENT_MESSAGE = "成员额度不足，请联系团队主账号分配额度。";
/** 成员额度被停用（enabled=false）——同 402 契约，文案不同。 */
export const MEMBER_QUOTA_DISABLED_MESSAGE = "该成员额度已停用，请联系团队主账号。";

export interface TeamMemberRecord {
  id: string;
  teamUserId: number;
  /** 成员 new-api user（配额桶所在）。 */
  memberUserId: number;
  /** 登记时使用的成员 biz key（手柄；同一 user 可能有多把）。 */
  memberKeyId: string;
  displayName: string;
  enabled: boolean;
}

/** 成员 user 配额桶的权威读数（new-api users.quota / used_quota）。 */
export interface MemberQuotaSnapshot {
  memberUserId: number;
  /** 该成员累计被授予的额度上限 = users.quota + users.used_quota。 */
  granted: number;
  /** 该帐号累计消耗 = users.used_quota。 */
  used: number;
  /** 真正的桶 = users.quota（可为负：真实状态不夹到 0）。 */
  remaining: number;
  /**
   * user 层没有 unlimited 概念——users.quota 由内核一律执法（unlimited_quota
   * 只是 token 层属性）。此栏位保留为契约的一部分（预检/可视面的第三态判定
   * 沿用旧形而语义恒 false），本模型不会产生 true。
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

/** Postgres 可用作映射层吗（C 端 Vercel 没这个库，必须走降级）。 */
export function memberQuotaStoreEnabled(): boolean {
  return generationControlPlaneEnabled();
}

export function toCoins(quota: number): number {
  return Math.round((quota / QUOTA_PER_COIN) * 1e6) / 1e6;
}

// ─────────────────────────────────────────── 映射层存取

/**
 * 预检热路径：这个 user 是不是某团队的成员（不是 → 完全不受成员配额执法）。
 * 成员判定按 **user_id**（配额桶在 user 层），不按 key 也不按 token。
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

/** 归属登记/更新。点数数字不入库——只写身份与意图。 */
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
  /** biz_api_key.user_id：成员 key 对应的 new-api user（= 成员的配额桶所在）。 */
  userId: number;
  label: string;
}

/** 成员 key 的归属链：biz_api_key.user_id（migration 007，免新表）。 */
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

// ─────────────────────────────────────────── new-api 权威读数

type GatewayUserReader = typeof fetchGatewayUser;

/**
 * 读成员 user 的配额桶（new-api 权威源）。查不到/上游抽风返回 null——调用方
 * 自行决定 fail-closed 还是 fail-open（预检一律 fail-closed）。
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

// ─────────────────────────────────────────── 可视面

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
  /** 读不到上游时的诚实第三态（不画假数字）。 */
  unavailable: boolean;
}

export interface TeamQuotaView {
  teamUserId: number;
  /** 主帐手上余额 = 团队主帐 user 的 users.quota。 */
  master: { remaining: number; coins: number };
  /** 累计划给成员的上限（= Σ 成员 granted）。 */
  allocated: number;
  allocatedCoins: number;
  /** Σ 成员已消耗。 */
  used: number;
  usedCoins: number;
  /** 还能再划出去 = 主帐手上余额（转移模型：划出的钱已在成员桶里，不再占主帐）。 */
  unallocated: number;
  unallocatedCoins: number;
  /** 团队未消耗总额 = 主帐手上余额 + Σ 成员桶剩余（消耗后剩下的钱全在这两处）。 */
  team: { remaining: number; coins: number };
  members: TeamQuotaMemberView[];
}

/** 主帐总额／已分配／各成员额度与消耗。全部数字当场读 new-api，无本地帐本。 */
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
      /** 本次实际转移的 quota（正 = 划出，负 = 回收，0 = 幂等 no-op）。 */
      transferred: number;
      /** true = 目标与现值相同，未动上游（幂等 no-op）。 */
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

/** 团队级串行化：同一主帐的分配/回收不并发（多成员并发不超卖的实现点）。 */
export type TeamLock = <T>(teamUserId: number, fn: (tx: GenerationSql) => Promise<T>) => Promise<T>;

async function defaultTeamLock<T>(
  sql: GenerationSql,
  teamUserId: number,
  fn: (tx: GenerationSql) => Promise<T>,
): Promise<T> {
  // postgres.js 的事务返回值类型是 UnwrapPromiseArray<T>，这里断言回 T。
  return (await sql.begin(async (tx) => {
    // 事务级 advisory lock：同团队的分配/回收排队执行，事务结束自动释放。
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`team-member-quota:${teamUserId}`}))`;
    // 事务句柄当查询接口交下去（同一连接）：避免「等锁占著一条连接、拿到锁
    // 又要第二条连接」在连接池（默认 max=5）上打成的自锁死。
    return await fn(tx as unknown as GenerationSql);
  })) as T;
}

type UserQuotaAdjuster = typeof adjustGatewayUserQuotaExact;

/**
 * 主帐 → 成员的额度转移（amount > 0）。
 *
 * 先扣后加：任何一步失败都不会出现「凭空多出来的额度」。第二条腿失败时回滚
 * 第一条腿；回滚也失败（上游两帐不平衡）→ 抛出的讯息讲明需人工核对，不假装没事。
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
  /** 团队主帐（出资方 = 呼叫方 B key 的 user_id）。 */
  teamUserId: number;
  memberKeyId: string;
  /** 目标额度上限（new-api quota，绝对值）。 */
  targetGranted: number;
}

export interface AllocateDeps {
  sql?: GenerationSql;
  fetchUser?: GatewayUserReader;
  adjustUserQuota?: UserQuotaAdjuster;
  /** 测试注入：默认走 Postgres 事务级 advisory lock。 */
  withTeamLock?: TeamLock;
  /** 归属登记 id 生成（默认 crypto.randomUUID）。 */
  newMemberId?: () => string;
  /** 转移身分证 id 生成（默认 crypto.randomUUID）；同一 id 的帐本两条腿共用。 */
  newTransferId?: () => string;
}

/**
 * 划额度 / 回收 / 调整（同一操作，绝对目标值 ⇒ 幂等）。
 *
 * 顺序：校验目标 → 解析归属（key→user）→ 团队锁内 读成员桶现值 → 判已消耗不可
 * 回收 → 读主帐手上余额 → 判本次差额是否划得出来 → 转移（先扣后加＋回滚）→
 * 登记归属。主帐不足时拒绝并给可执行错误（可先充值或回收其他成员额度）。
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
  // 映射层不在（C 端 Vercel 没有控制面库）→ 服务不可用，不是「成员不存在」。
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
  // 成员必须是「另一个 user」：主帐自己的 key 当成员 = 自己给自己划额度，禁止。
  if (binding.userId === input.teamUserId) {
    return fail(
      403,
      "team_mismatch",
      `密钥 ${memberLabel} 的计费账号就是团队主账号 ${input.teamUserId} 本身；主账号不能作为成员，请改用成员自己的密钥。`,
    );
  }
  // 一个成员 user 只属一个团队：已被别家团队登记 ⇒ 不可跨团队分配。
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

      // 一律读现值（不论是否已登记）：成员桶可能早就带著额度，按 0 起算会把
      // 主帐的钱多划出去。读不到就 fail-closed。
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
      // 不变量②（user 层转移模型）：划出去的钱要从主帐手上真的拿得出来。
      // 成员桶是真钱不是上限贴纸，所以可分配余额 = 主帐手上余额（划出去的已不在主帐）。
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
        // 幂等 no-op：目标与现值相同，不动上游。
        confirmed = { remaining: current.remaining, used: current.used };
      } else {
        // 转移身分证：一次真实的上游双腿转移配一个 id，帐本两条腿共用（同一事务写入）。
        // 重放的请求在 delta===0 分支就早退、根本不会产生新 id ⇒ 帐本天然不重复。
        const transferId = (deps.newTransferId ?? randomUUID)();
        // REQ-E1a 顺序铁律：先种基线（取的是「动上游之前」的 users.quota），再转移，最后记帐。
        // 先转移后种基线 = 基线已含这笔转移 + 帐本再记一次 = 双算。基线不可得则放弃记帐
        // （钱路照走），差额由对帐报告负责。
        const baselineReady = await ensureAccountBaselines([input.teamUserId, binding.userId], { sql: tx, fetchUser });
        try {
          // delta > 0：主帐 → 成员；delta < 0：成员 → 主帐（回收）。
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
        // REQ-E1a 双写：上游两腿都动了才记我方帐本（transfer_out/transfer_in 同一事务）。
        // 记帐失败不挡路：差额由 E1b 对帐报告逐笔指出（不假装两层一致）。
        const ledger = baselineReady
          ? await recordTransfer({
              teamUserId: input.teamUserId,
              memberUserId: binding.userId,
              amountQuota: delta,
              transferId,
              source: "member-quota",
              memberKeyId: input.memberKeyId,
            }, { sql: tx, fetchUser })
          : { posted: false, reason: "基线不可得（未记帐）" };
        if (!ledger.posted) {
          console.error(
            `[member-quota] team=${input.teamUserId} memberUser=${binding.userId} 转移帐本未落地（${ledger.reason}）——已由对帐报告负责`,
          );
        }
        // 上游写入成功后覆核：拿不回权威读数就不回报成功（不画假数字）。
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
