// 席位 → 成员额度分配（刀 3）：席位语义与既有配额转移通路的唯一接点。
//
// 语义：该成员获配 seats 个席位、每席位 perSeatCoins 币 ⇒ **目标额度上限** =
// seats × perSeatCoins（币）→ round(× QUOTA_PER_COIN) quota。目标是**绝对值**，
// 不是增量：这正是 member-quota.ts 既有 allocateMemberQuota 的模型（重放天然幂等）。
//
// 唯一通路（禁另开第二条分配路径）：本档不自己动任何帐号额度，全部委派
// allocateMemberQuota；主帐扣 Δ／成员加 Δ、「先扣后加」＋失败回滚、团队
// advisory lock 串行化、已消耗不可回收、禁影子帐本（不写本地点数）都是它的既有行为，
// 本档**一行不改**（禁碰其不变量语义）。member_user_id → member_key_id 的解析走
// 既有 findMemberByUserId（019 的归属表本就只存身份与意图）。
//
// 与 /v1/team/quota 的差别只在「目标怎么来」：那条路由吃呼叫方给的 target_coins；
// 本档吃「席位数 × 每席位币数」。两者最终都落到同一个 allocateMemberQuota。
//
// 不变量（由 allocateMemberQuota 保证，本档测试逐条断言）：
//   ① 分配 = 转移（主帐扣 Δ、成员加 Δ），全团队总额守恒；
//   ② 重放同请求不重复扣（目标与现值相同 = 幂等 no-op，不写上游）；
//   ③ 目标不得低于该成员已消耗（已消耗不可回收）；
//   ④ 失败回滚不留半边（先扣后加；第二条腿失败即回滚，不凭空印额度、不登记归属）。

import {
  allocateMemberQuota,
  findMemberByUserId,
  memberQuotaStoreEnabled,
  toCoins,
  type AllocationFailureCode,
  type AllocationResult,
  type AllocateDeps,
  type TeamMemberRecord,
} from "./member-quota";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import type { GenerationSql } from "./database";

export type SeatAllocationFailureCode =
  | AllocationFailureCode
  | "invalid_seats"
  | "invalid_per_seat_coins"
  | "invalid_team"
  | "member_not_registered"
  | "allocation_unavailable";

export interface ApplySeatAllocationInput {
  /** 出资方 = 团队主帐（new-api user）。 */
  teamUserId: number;
  /** 成员 new-api user（配额桶所在，019 的 user 层模型）。 */
  memberUserId: number;
  /** 分配给该成员的席位数（正整数）。 */
  seats: number;
  /** 每席位币数（正数；与团队席位单价同口径的「币」）。 */
  perSeatCoins: number;
}

export interface ApplySeatAllocationDeps extends AllocateDeps {
  /** 测试注入：席位成员查表（默认 member-quota.ts 的 findMemberByUserId）。 */
  findMember?: (memberUserId: number, sql?: GenerationSql) => Promise<TeamMemberRecord | null>;
}

export type SeatAllocationResult =
  | {
      ok: true;
      memberKeyId: string;
      memberUserId: number;
      seats: number;
      perSeatCoins: number;
      /** 本次目标 = seats × perSeatCoins（币）。 */
      targetCoins: number;
      /** 同一目标的 quota 表示（绝对目标值）。 */
      targetQuota: number;
      granted: number;
      used: number;
      remaining: number;
      /** 本次实际转移 quota（正 = 划出，负 = 回收，0 = 幂等 no-op）。 */
      transferred: number;
      transferredCoins: number;
      unchanged: boolean;
    }
  | {
      ok: false;
      status: 400 | 402 | 403 | 404 | 409 | 503;
      code: SeatAllocationFailureCode;
      message: string;
    };

function fail(
  status: 400 | 402 | 403 | 404 | 409 | 503,
  code: SeatAllocationFailureCode,
  message: string,
): SeatAllocationResult {
  return { ok: false, status, code, message };
}

/**
 * 按席位把额度分配给成员（目标绝对值 ⇒ 幂等）。全部校验先于任何上游写入。
 */
export async function applySeatAllocation(
  input: ApplySeatAllocationInput,
  deps: ApplySeatAllocationDeps = {},
): Promise<SeatAllocationResult> {
  // 严格判型（钱路不做隐式转换）。
  if (typeof input.seats !== "number" || !Number.isInteger(input.seats) || input.seats <= 0) {
    return fail(400, "invalid_seats", "席位数必须是不小于 1 的整数。");
  }
  if (
    typeof input.perSeatCoins !== "number" ||
    !Number.isFinite(input.perSeatCoins) ||
    input.perSeatCoins <= 0
  ) {
    return fail(400, "invalid_per_seat_coins", "每席位币数必须是大于 0 的数值。");
  }
  if (!Number.isInteger(input.teamUserId) || input.teamUserId <= 0) {
    return fail(503, "invalid_team", "团队主账号不可用（缺少有效的计费用户）。");
  }
  if (!Number.isInteger(input.memberUserId) || input.memberUserId <= 0) {
    return fail(400, "member_not_registered", "member_user_id 必须是有效的成员账号 id。");
  }
  // 成员是另一个 user（019 的 CHECK 同一语义）：主帐不能给自己划席位额度。
  if (input.memberUserId === input.teamUserId) {
    return fail(403, "team_mismatch", "团队主账号本身不是成员席位，不能给自己分配席位额度。");
  }
  if (!memberQuotaStoreEnabled()) {
    return fail(503, "allocation_unavailable", "成员额度映射层不可用（控制面数据库未配置）。");
  }

  const lookup = deps.findMember ?? findMemberByUserId;
  let member: TeamMemberRecord | null;
  try {
    member = await lookup(input.memberUserId, deps.sql);
  } catch {
    return fail(503, "allocation_unavailable", "成员归属查询暂不可用，请稍后重试。");
  }
  if (!member) {
    return fail(
      404,
      "member_not_registered",
      `成员账号 ${input.memberUserId} 不在团队名册中（请先让该成员用其密钥加入团队）。`,
    );
  }
  // 一个成员 user 只属一个团队：归属不符即拒（与 allocateMemberQuota 的跨团队 403 同语义）。
  if (member.teamUserId !== input.teamUserId) {
    return fail(
      403,
      "team_mismatch",
      `成员账号 ${input.memberUserId} 归属团队主账号 ${member.teamUserId}，不是本团队。`,
    );
  }

  const targetCoins = input.seats * input.perSeatCoins;
  const targetQuota = Math.round(targetCoins * QUOTA_PER_COIN);

  const result: AllocationResult = await allocateMemberQuota(
    { teamUserId: input.teamUserId, memberKeyId: member.memberKeyId, targetGranted: targetQuota },
    deps,
  );
  if (!result.ok) {
    return { ok: false, status: result.status, code: result.code, message: result.message };
  }

  return {
    ok: true,
    memberKeyId: result.memberKeyId,
    memberUserId: result.memberUserId,
    seats: input.seats,
    perSeatCoins: input.perSeatCoins,
    targetCoins: toCoins(targetQuota),
    targetQuota,
    granted: result.granted,
    used: result.used,
    remaining: result.remaining,
    transferred: result.transferred,
    transferredCoins: toCoins(result.transferred),
    unchanged: result.unchanged,
  };
}
