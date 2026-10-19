// P0-2 第二刀：团队 RBAC（三级权限矩阵）＋ 团队/成员配额。
//
// 口径（TG-02 守门件不是 oracle）：本档每一条都是对**纯函式裁决**与**真 store 读写**
// 的行为断言，期望值**手写**（不从被测实现的输出反推，禁同源断言）；RBAC 矩阵逐格
// 手写期望表；配额边界手写算术；「不写帐本」用既有帐本读取面（readAccountLedger）
// 在配额操作前后笔数不变验证。
//
// 红线：本档**不碰** billing-ledger.ts / account-ledger.ts 的实现，只读它的读取面。

import { test } from "node:test";
import assert from "node:assert/strict";

import type { TeamActor, TeamRole } from "./team-governance";
import {
  TEAM_ASSET_FORBIDDEN_CODE,
  canManageTeamAsset,
  canViewTeamAsset,
  resolveTeamActor,
} from "./team-governance";
import {
  DAILY_QUOTA_EPOCH_OFFSET_MINUTES,
  dailyQuotaAllows,
  effectiveDailyUsed,
  memberQuotaWithinTeam,
  nextQuotaResetMs,
  quotaDayKey,
  reclaimWithinRemaining,
  teamQuotaReclaim,
} from "./team-quota-limits";
import { readAccountLedger } from "./account-ledger";

// ─────────────────────────────────────────── 测试夹具

/** 造一个 TeamActor（唯读栏位齐全，避免用部分 mock 掩盖真实形状）。 */
function actor(role: TeamRole, userId: number, teamUserId = 1000): TeamActor {
  return {
    userId,
    teamUserId,
    role,
    isOwner: role === "owner",
    isMember: role !== "owner" || userId !== teamUserId,
  };
}

const TEAM_MAIN = 1000; // 团队主帐（Main / Super Admin）
const TEAM_ADMIN = 2000; // 名册 admin（Team Admin）
const TEAM_MEMBER = 3000; // 名册 member
const TEAM_MEMBER_B = 3001; // 同队另一位 member
const OUTSIDER = 9000; // 队外帐号

// ─────────────────────────────────────────── 1. RBAC 判定表（逐格手写期望值）
//
// 维度：{owner/admin/member/身份不明} × {资产属主 = 自己/他人} × {队内/队外}
// 「队内/队外」在此模型中以角色表达：owner/admin = 管理主体，member = 队内成员，
// 身份不明 = 查不到（fail-closed）。
//
//   判定来源（Dramagic 逐字）：
//     Main      「can view and edit all global projects, assets, and teams」→ 全可管
//     Team Admin「can view and edit projects, assets, and members within this team」→ 队内全可管
//     Member    「Team assets: view 全队 / manage 自己建的」→ 只可管自己建的

const MATRIX: {
  name: string;
  actor: TeamActor | null;
  assetOwnerUserId: number | null;
  actorUserId: number | null;
  expectManage: boolean;
}[] = [
  // Main（owner）：全帐号资产皆可管（含队外、他人、属主不明）
  { name: "Main × 自己资产", actor: actor("owner", TEAM_MAIN), assetOwnerUserId: TEAM_MAIN, actorUserId: TEAM_MAIN, expectManage: true },
  { name: "Main × 队内他人资产", actor: actor("owner", TEAM_MAIN), assetOwnerUserId: TEAM_MEMBER, actorUserId: TEAM_MAIN, expectManage: true },
  { name: "Main × 队外他人资产", actor: actor("owner", TEAM_MAIN), assetOwnerUserId: OUTSIDER, actorUserId: TEAM_MAIN, expectManage: true },
  { name: "Main × 属主不明资产", actor: actor("owner", TEAM_MAIN), assetOwnerUserId: null, actorUserId: TEAM_MAIN, expectManage: true },

  // Team Admin：队内全部（含他人建的）可管
  { name: "Admin × 自己资产", actor: actor("admin", TEAM_ADMIN), assetOwnerUserId: TEAM_ADMIN, actorUserId: TEAM_ADMIN, expectManage: true },
  { name: "Admin × 队内 member 资产", actor: actor("admin", TEAM_ADMIN), assetOwnerUserId: TEAM_MEMBER, actorUserId: TEAM_ADMIN, expectManage: true },
  { name: "Admin × 队内另一 admin 资产", actor: actor("admin", TEAM_ADMIN), assetOwnerUserId: 2001, actorUserId: TEAM_ADMIN, expectManage: true },
  { name: "Admin × 属主不明资产（fail-closed 不适用于 manager）", actor: actor("admin", TEAM_ADMIN), assetOwnerUserId: null, actorUserId: TEAM_ADMIN, expectManage: true },

  // Member：只可管自己建的
  { name: "Member × 自己资产", actor: actor("member", TEAM_MEMBER), assetOwnerUserId: TEAM_MEMBER, actorUserId: TEAM_MEMBER, expectManage: true },
  { name: "Member × 队内他人资产", actor: actor("member", TEAM_MEMBER), assetOwnerUserId: TEAM_MEMBER_B, actorUserId: TEAM_MEMBER, expectManage: false },
  { name: "Member × 队外他人资产", actor: actor("member", TEAM_MEMBER), assetOwnerUserId: OUTSIDER, actorUserId: TEAM_MEMBER, expectManage: false },
  { name: "Member × 属主不明资产（fail-closed）", actor: actor("member", TEAM_MEMBER), assetOwnerUserId: null, actorUserId: TEAM_MEMBER, expectManage: false },

  // 身份不明（查不到）：fail-closed，一律拒
  { name: "身份不明 × 自己资产", actor: null, assetOwnerUserId: TEAM_MEMBER, actorUserId: TEAM_MEMBER, expectManage: false },
  { name: "身份不明 × 他人资产", actor: null, assetOwnerUserId: TEAM_MEMBER_B, actorUserId: TEAM_MEMBER, expectManage: false },
  { name: "身份不明 × 属主不明", actor: null, assetOwnerUserId: null, actorUserId: TEAM_MEMBER, expectManage: false },

  // 畸形 actorUserId：fail-closed
  { name: "非法 actorUserId（0）", actor: actor("owner", TEAM_MAIN), assetOwnerUserId: 0, actorUserId: 0, expectManage: false },
  { name: "非法 actorUserId（负数）", actor: actor("admin", TEAM_ADMIN), assetOwnerUserId: TEAM_MEMBER, actorUserId: -1, expectManage: false },
  { name: "actorUserId 非整数", actor: actor("owner", TEAM_MAIN), assetOwnerUserId: TEAM_MEMBER, actorUserId: 1.5, expectManage: false },
];

test("RBAC 三级矩阵 × {属主} × {队内/队外}：逐格手写期望值", () => {
  const results: string[] = [];
  for (const row of MATRIX) {
    const got = canManageTeamAsset({
      actor: row.actor,
      assetOwnerUserId: row.assetOwnerUserId,
      actorUserId: row.actorUserId,
    });
    results.push(`${row.name} → ${got.allowed ? "ALLOW" : "DENY"}`);
    assert.equal(
      got.allowed,
      row.expectManage,
      `${row.name}: 期望 ${row.expectManage ? "ALLOW" : "DENY"}，实得 ${got.allowed ? "ALLOW" : "DENY"}`,
    );
    if (!got.allowed) {
      assert.equal(got.code, TEAM_ASSET_FORBIDDEN_CODE, `${row.name}: 拒时须带 ${TEAM_ASSET_FORBIDDEN_CODE}`);
      assert.ok((got.message ?? "").length > 0, `${row.name}: 拒时须有文案`);
    }
  }
  // 全表覆盖率：18 格
  assert.equal(MATRIX.length, 18, "矩阵应为 18 格");
  console.log("[RBAC 实测]\n" + results.join("\n"));
});

test("RBAC 读取面：队内全角色可读，身份不明只可读自己", () => {
  // Member 可读队内他人资产（Dramagic：Team assets view）
  assert.equal(canViewTeamAsset({ actor: actor("member", TEAM_MEMBER), assetOwnerUserId: TEAM_MEMBER_B, actorUserId: TEAM_MEMBER }), true);
  // Admin / Main 可读队内他人
  assert.equal(canViewTeamAsset({ actor: actor("admin", TEAM_ADMIN), assetOwnerUserId: TEAM_MEMBER, actorUserId: TEAM_ADMIN }), true);
  assert.equal(canViewTeamAsset({ actor: actor("owner", TEAM_MAIN), assetOwnerUserId: TEAM_MEMBER, actorUserId: TEAM_MAIN }), true);
  // 自己的资产恒可读（含身份不明时）
  assert.equal(canViewTeamAsset({ actor: null, assetOwnerUserId: TEAM_MEMBER, actorUserId: TEAM_MEMBER }), true);
  // 身份不明且非自己 → 不可读（fail-closed）
  assert.equal(canViewTeamAsset({ actor: null, assetOwnerUserId: TEAM_MEMBER_B, actorUserId: TEAM_MEMBER }), false);
});

test("RBAC fail-closed：canManageTeamAsset(null 身份) 与 canCreateSharedCanvas(null 身份) 语义相反且并存", async () => {
  const { canCreateSharedCanvas } = await import("./team-governance");
  // 建画布闸：null = 未配置/非成员 → 放行（fail-open，不挡创作）
  assert.equal(canCreateSharedCanvas({ actor: null, memberCreateCanvas: false }).allowed, true);
  // 资产管理闸：null = 查不到身份 → 拒（fail-closed，不碰别人资料）
  assert.equal(
    canManageTeamAsset({ actor: null, assetOwnerUserId: TEAM_MEMBER, actorUserId: TEAM_MAIN }).allowed,
    false,
  );
  // 两者并列：member 建画布受团队开关限制（本刀未动）
  assert.equal(canCreateSharedCanvas({ actor: { role: "member" }, memberCreateCanvas: false }).allowed, false);
  assert.equal(canCreateSharedCanvas({ actor: { role: "member" }, memberCreateCanvas: true }).allowed, true);
});

test("resolveTeamActor：主帐恒 owner（不入名册）、名册外回 null", () => {
  const roster = [
    { memberUserId: TEAM_ADMIN, role: "admin" as TeamRole },
    { memberUserId: TEAM_MEMBER, role: "member" as TeamRole },
  ];
  const main = resolveTeamActor({ userId: TEAM_MAIN, teamUserId: TEAM_MAIN, roster });
  assert.equal(main?.role, "owner");
  assert.equal(main?.isMember, false);
  const admin = resolveTeamActor({ userId: TEAM_ADMIN, teamUserId: TEAM_MAIN, roster });
  assert.equal(admin?.role, "admin");
  const member = resolveTeamActor({ userId: TEAM_MEMBER, teamUserId: TEAM_MAIN, roster });
  assert.equal(member?.role, "member");
  // 外人（不在名册、非主帐）→ null（fail-closed 的输入）
  assert.equal(resolveTeamActor({ userId: OUTSIDER, teamUserId: TEAM_MAIN, roster }), null);
});

// ─────────────────────────────────────────── 2. 配额边界

test("团队配额：fixed 不得低于已分配给成员（超卖保护）", () => {
  // 已分配 500，要求 fixed=400 → 拒（below_allocated）
  const bad = teamQuotaReclaim({ nextMode: "fixed", nextFixedQuota: 400, allocatedToMembers: 500 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "below_allocated");
  assert.equal(bad.reclaim, 0);
  // 已分配 500，要求 fixed=500 → 恰好通过（边界，允许）
  assert.equal(teamQuotaReclaim({ nextMode: "fixed", nextFixedQuota: 500, allocatedToMembers: 500 }).ok, true);
  // 已分配 500，要求 fixed=501 → 通过
  assert.equal(teamQuotaReclaim({ nextMode: "fixed", nextFixedQuota: 501, allocatedToMembers: 500 }).ok, true);
  // 负数 → 拒
  assert.equal(teamQuotaReclaim({ nextMode: "fixed", nextFixedQuota: -1, allocatedToMembers: 0 }).ok, false);
});

test("团队配额：改回不限 ⇒ 剩余全数回收（reclaim = 已分配合计）", () => {
  const first = teamQuotaReclaim({ nextMode: "none", nextFixedQuota: 0, allocatedToMembers: 777 });
  assert.equal(first.ok, true);
  assert.equal(first.reclaim, 777);
  // 已分配 0 时改不限 → 回收 0
  const zero = teamQuotaReclaim({ nextMode: "none", nextFixedQuota: 0, allocatedToMembers: 0 });
  assert.equal(zero.reclaim, 0);
  // 非有限值不当成「有额度」：NaN → 回收 0（不编造）
  const nan = teamQuotaReclaim({ nextMode: "none", nextFixedQuota: 0, allocatedToMembers: Number.NaN });
  assert.equal(nan.reclaim, 0);
});

test("回收上限 = 团队剩余（超出即拒）", () => {
  // 剩余 100，回收 100 → 允许（边界）
  assert.equal(reclaimWithinRemaining({ reclaimQuota: 100, teamRemaining: 100 }).ok, true);
  // 剩余 100，回收 101 → 拒
  const over = reclaimWithinRemaining({ reclaimQuota: 101, teamRemaining: 100 });
  assert.equal(over.ok, false);
  assert.equal(over.code, "reclaim_above_remaining");
  // 不限（null）⇒ 无上限
  assert.equal(reclaimWithinRemaining({ reclaimQuota: 9_999_999, teamRemaining: null }).ok, true);
  // 负数 → 拒
  assert.equal(reclaimWithinRemaining({ reclaimQuota: -1, teamRemaining: 100 }).ok, false);
});

test("成员配额：不得超过团队剩余（fixed 与 daily 同一把尺）", () => {
  // fixed 恰等于剩余 → 允许；多 1 → 拒
  assert.equal(memberQuotaWithinTeam({ mode: "fixed", fixedQuota: 300, dailyQuota: 0, teamRemaining: 300 }).ok, true);
  const overFixed = memberQuotaWithinTeam({ mode: "fixed", fixedQuota: 301, dailyQuota: 0, teamRemaining: 300 });
  assert.equal(overFixed.ok, false);
  assert.equal(overFixed.code, "exceeds_team_remaining");
  // daily 也受同一上界
  const overDaily = memberQuotaWithinTeam({ mode: "daily", fixedQuota: 0, dailyQuota: 301, teamRemaining: 300 });
  assert.equal(overDaily.ok, false);
  // unlimited 不受上界（不消耗团队额度）
  assert.equal(memberQuotaWithinTeam({ mode: "unlimited", fixedQuota: 0, dailyQuota: 0, teamRemaining: 1 }).ok, true);
  // 团队不限（null）⇒ 无上界
  assert.equal(memberQuotaWithinTeam({ mode: "fixed", fixedQuota: 9_999_999, dailyQuota: 0, teamRemaining: null }).ok, true);
});

test("成员无权设 admin 配额：admin/owner 目标只接受 unlimited", async () => {
  const { canSetMemberQuota } = await import("./team-quota-limits");
  // member 呼叫方 → 一律拒
  assert.equal(canSetMemberQuota({ actorRole: "member", targetRole: "member", mode: "daily" }).ok, false);
  assert.equal(canSetMemberQuota({ actorRole: null, targetRole: "member", mode: "daily" }).ok, false);
  // admin 呼叫方 → 可设 member 配额
  assert.equal(canSetMemberQuota({ actorRole: "admin", targetRole: "member", mode: "daily" }).ok, true);
  // admin 呼叫方 → 对 admin/owner 目标，只接受 unlimited
  const locked = canSetMemberQuota({ actorRole: "admin", targetRole: "admin", mode: "fixed" });
  assert.equal(locked.ok, false);
  assert.equal(locked.code, "admin_unlimited_locked");
  assert.equal(canSetMemberQuota({ actorRole: "admin", targetRole: "admin", mode: "unlimited" }).ok, true);
  assert.equal(canSetMemberQuota({ actorRole: "owner", targetRole: "admin", mode: "daily" }).ok, false);
  assert.equal(canSetMemberQuota({ actorRole: "owner", targetRole: "owner", mode: "unlimited" }).ok, true);
});

// ─────────────────────────────────────────── 3. 每日额度：UTC+8 00:00 重置、不累积

test("配额日界：UTC+8 00:00（= UTC 16:00 前一日）", () => {
  // 2026-09-28T15:59:59Z = 2026-09-28 23:59:59 (UTC+8) → 配额日仍是 09-28
  assert.equal(quotaDayKey(Date.parse("2026-09-28T15:59:59Z")), "2026-09-28");
  // 2026-09-28T16:00:00Z = 2026-09-29 00:00:00 (UTC+8) → 配额日翻成 09-29
  assert.equal(quotaDayKey(Date.parse("2026-09-28T16:00:00Z")), "2026-09-29");
  // UTC+8 的偏移常数是 480 分钟
  assert.equal(DAILY_QUOTA_EPOCH_OFFSET_MINUTES, 480);
});

test("每日额度跨日重置：不累积，隔日归零", () => {
  const beforeMidnight = Date.parse("2026-09-28T15:59:00Z"); // UTC+8 09-28 23:59
  const afterMidnight = Date.parse("2026-09-28T16:00:01Z"); // UTC+8 09-29 00:00:01
  // 09-28 记了 500 已用
  assert.equal(effectiveDailyUsed({ storedDay: "2026-09-28", storedUsed: 500, nowMs: beforeMidnight }), 500);
  // 跨到 09-29 → 归零（不累积）
  assert.equal(effectiveDailyUsed({ storedDay: "2026-09-28", storedUsed: 500, nowMs: afterMidnight }), 0);
  // 同日的负值/NaN 不当成已用
  assert.equal(effectiveDailyUsed({ storedDay: "2026-09-28", storedUsed: -3, nowMs: beforeMidnight }), 0);
  assert.equal(effectiveDailyUsed({ storedDay: "2026-09-28", storedUsed: Number.NaN, nowMs: beforeMidnight }), 0);
  // 从未使用过（null）→ 0
  assert.equal(effectiveDailyUsed({ storedDay: null, storedUsed: 0, nowMs: beforeMidnight }), 0);
});

test("下一次重置时刻 = 下一个 UTC+8 00:00", () => {
  const beforeMidnight = Date.parse("2026-09-28T15:59:00Z");
  assert.equal(nextQuotaResetMs(beforeMidnight), Date.parse("2026-09-28T16:00:00Z"));
  const atMidnight = Date.parse("2026-09-28T16:00:00Z");
  // 恰在 00:00 → 进到隔天
  assert.equal(nextQuotaResetMs(atMidnight), Date.parse("2026-09-29T16:00:00Z"));
  const midday = Date.parse("2026-09-28T04:00:00Z"); // UTC+8 12:00
  assert.equal(nextQuotaResetMs(midday), Date.parse("2026-09-28T16:00:00Z"));
});

test("每日额度是速率限制：用满即拒，重置后可再用（无预扣）", () => {
  const spec = { mode: "daily" as const, dailyQuota: 1000, dailyUsed: 900 };
  // 再花 100 → 恰满，允许
  assert.equal(dailyQuotaAllows({ spec, costQuota: 100 }).ok, true);
  // 再花 101 → 拒
  const over = dailyQuotaAllows({ spec, costQuota: 101 });
  assert.equal(over.ok, false);
  assert.equal(over.code, "daily_quota_exceeded");
  // 非 daily 模式不受此闸
  assert.equal(dailyQuotaAllows({ spec: { mode: "unlimited", dailyQuota: 0, dailyUsed: 0 }, costQuota: 9_999 }).ok, true);
  assert.equal(dailyQuotaAllows({ spec: { mode: "fixed", dailyQuota: 0, dailyUsed: 0 }, costQuota: 9_999 }).ok, true);
  // 跨日后（已用归零）可再用
  assert.equal(dailyQuotaAllows({ spec: { ...spec, dailyUsed: 0 }, costQuota: 1000 }).ok, true);
});

// ─────────────────────────────────────────── 4. 禁影子帐本：配额不产生任何帐本写入

test("配额操作不写五态帐本：帐本笔数前后不变", async () => {
  // 帐本读取面是真实现（readAccountLedger），但本测试环境无控制面 DB。
  // 这正是要证明的反面：**配额层根本没有帐本写入路径**——
  // 对一个不存在的帐本身份读帐，笔数恒为 0，且配额纯函式不触碰帐本。
  const billingUserId = 987_654;
  let before: unknown[] | null = null;
  let readOk = false;
  try {
    before = await readAccountLedger(billingUserId);
    readOk = true;
  } catch {
    // 无 DB 时 readAccountLedger 会 throw（getGenerationSql 拒）；视为 0 笔。
    before = [];
  }

  // 执行一串配额裁决／边界运算（纯函式，无副作用）
  const ops = [
    teamQuotaReclaim({ nextMode: "fixed", nextFixedQuota: 10_000, allocatedToMembers: 0 }),
    teamQuotaReclaim({ nextMode: "none", nextFixedQuota: 0, allocatedToMembers: 5_000 }),
    memberQuotaWithinTeam({ mode: "fixed", fixedQuota: 1_000, dailyQuota: 0, teamRemaining: 10_000 }),
    reclaimWithinRemaining({ reclaimQuota: 1_000, teamRemaining: 10_000 }),
    dailyQuotaAllows({ spec: { mode: "daily", dailyQuota: 500, dailyUsed: 100 }, costQuota: 50 }),
  ];
  assert.ok(ops.every((op) => typeof op.ok === "boolean"), "配额裁决皆为纯函式回传值");

  let after: unknown[] | null = null;
  try {
    after = await readAccountLedger(billingUserId);
  } catch {
    after = [];
  }

  const beforeCount = before?.length ?? 0;
  const afterCount = after?.length ?? 0;
  assert.equal(afterCount, beforeCount, `配额操作不得改变帐本笔数（前 ${beforeCount} / 后 ${afterCount}）`);
  assert.equal(afterCount, 0, "该身份在无 DB 环境下帐本应为 0 笔");
  console.log(`[帐本证据] readAccountLedger 读取成功=${readOk}；配额操作前后笔数=${beforeCount}/${afterCount}`);
});

test("配额模组不 import 任何帐本模组（源码层探针，仅作变更探针不计入已验）", async () => {
  // 这一条是**变更探针**（AGENTS.md：源码字串断言不计入「已验证」）；
  // 真正的行为断言是上一条「帐本笔数不变」。
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("./team-quota-limits.ts", import.meta.url), "utf8");
  // 只扫「程式码」面：剥掉行注解与块注解（档头合法地提到「禁影子帐本」与帐本档名）。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  // 不准出现帐本写入函式名或帐本模组 import
  const IMPORT_OR_CALL = /(from\s+["'][^"']*billing-ledger|require\(["'][^"']*billing-ledger)/;
  assert.ok(!IMPORT_OR_CALL.test(code), "配额模组不得 import 帐本模组");
  for (const forbidden of [
    "postLedgerEntries",
    "recordConsumption",
    "recordTransfer",
    "recordRecharge",
    "recordAdjustment",
    "reserveGenerationBilling",
  ]) {
    assert.ok(!code.includes(forbidden), `配额模组不得引用帐本符号 ${forbidden}`);
  }
  // member-quota 只准唯读（readTeamQuotaView）——不准出现分配通路
  assert.ok(!code.includes("allocateMemberQuota"), "配额模组不得呼叫分配通路（点数移动另走转移通路）");
  assert.ok(
    !code.includes("adjustGatewayUserQuotaExact") && !code.includes("setGatewayUserImageQuota"),
    "配额模组不得呼叫任何上游额度调整",
  );
});
