// 席位 → 成員額度分配（刀 3）：席位語義與既有配額轉移通路的唯一接點。
//
// 語義：該成員獲配 seats 個席位、每席位 perSeatCoins 幣 ⇒ **目標額度上限** =
// seats × perSeatCoins（幣）→ round(× QUOTA_PER_COIN) quota。目標是**絕對值**，
// 不是增量：這正是 member-quota.ts 既有 allocateMemberQuota 的模型（重放天然冪等）。
//
// 唯一通路（禁另開第二條分配路徑）：本檔不自己動任何帳號額度，全部委派
// allocateMemberQuota；主帳扣 Δ／成員加 Δ、「先扣後加」＋失敗回滾、團隊
// advisory lock 串行化、已消耗不可回收、禁影子帳本（不寫本地點數）都是它的既有行為，
// 本檔**一行不改**（禁碰其不變量語義）。member_user_id → member_key_id 的解析走
// 既有 findMemberByUserId（019 的歸屬表本就只存身份與意圖）。
//
// 與 /v1/team/quota 的差別只在「目標怎麼來」：那條路由吃呼叫方給的 target_coins；
// 本檔吃「席位数 × 每席位幣數」。兩者最終都落到同一個 allocateMemberQuota。
//
// 不變量（由 allocateMemberQuota 保證，本檔測試逐條斷言）：
//   ① 分配 = 轉移（主帳扣 Δ、成員加 Δ），全團隊總額守恆；
//   ② 重放同請求不重複扣（目標與現值相同 = 幂等 no-op，不寫上游）；
//   ③ 目標不得低於該成員已消耗（已消耗不可回收）；
//   ④ 失敗回滾不留半邊（先扣後加；第二條腿失敗即回滾，不憑空印額度、不登記歸屬）。

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
  /** 出資方 = 團隊主帳（new-api user）。 */
  teamUserId: number;
  /** 成員 new-api user（配額桶所在，019 的 user 層模型）。 */
  memberUserId: number;
  /** 分配給該成員的席位数（正整數）。 */
  seats: number;
  /** 每席位幣數（正數；與團隊席位單價同口徑的「幣」）。 */
  perSeatCoins: number;
}

export interface ApplySeatAllocationDeps extends AllocateDeps {
  /** 測試注入：席位成員查表（默認 member-quota.ts 的 findMemberByUserId）。 */
  findMember?: (memberUserId: number, sql?: GenerationSql) => Promise<TeamMemberRecord | null>;
}

export type SeatAllocationResult =
  | {
      ok: true;
      memberKeyId: string;
      memberUserId: number;
      seats: number;
      perSeatCoins: number;
      /** 本次目標 = seats × perSeatCoins（幣）。 */
      targetCoins: number;
      /** 同一目標的 quota 表示（絕對目標值）。 */
      targetQuota: number;
      granted: number;
      used: number;
      remaining: number;
      /** 本次實際轉移 quota（正 = 劃出，負 = 回收，0 = 幂等 no-op）。 */
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
 * 按席位把額度分配給成員（目標絕對值 ⇒ 冪等）。全部校驗先於任何上游寫入。
 */
export async function applySeatAllocation(
  input: ApplySeatAllocationInput,
  deps: ApplySeatAllocationDeps = {},
): Promise<SeatAllocationResult> {
  // 嚴格判型（錢路不做隱式轉換）。
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
  // 成員是另一個 user（019 的 CHECK 同一語義）：主帳不能給自己劃席位額度。
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
  // 一個成員 user 只屬一個團隊：歸屬不符即拒（與 allocateMemberQuota 的跨團隊 403 同語義）。
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
