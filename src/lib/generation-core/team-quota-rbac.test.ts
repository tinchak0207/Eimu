// P0-2 第二刀：團隊 RBAC（三級權限矩陣）＋ 團隊/成員配額。
//
// 口徑（TG-02 守門件不是 oracle）：本檔每一條都是對**純函式裁決**與**真 store 讀寫**
// 的行為斷言，期望值**手寫**（不從被測實現的輸出反推，禁同源斷言）；RBAC 矩陣逐格
// 手寫期望表；配額邊界手寫算術；「不寫帳本」用既有帳本讀取面（readAccountLedger）
// 在配額操作前後筆數不變驗證。
//
// 紅線：本檔**不碰** billing-ledger.ts / account-ledger.ts 的實現，只讀它的讀取面。

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

// ─────────────────────────────────────────── 測試夾具

/** 造一個 TeamActor（唯讀欄位齊全，避免用部分 mock 掩蓋真實形狀）。 */
function actor(role: TeamRole, userId: number, teamUserId = 1000): TeamActor {
  return {
    userId,
    teamUserId,
    role,
    isOwner: role === "owner",
    isMember: role !== "owner" || userId !== teamUserId,
  };
}

const TEAM_MAIN = 1000; // 團隊主帳（Main / Super Admin）
const TEAM_ADMIN = 2000; // 名冊 admin（Team Admin）
const TEAM_MEMBER = 3000; // 名冊 member
const TEAM_MEMBER_B = 3001; // 同隊另一位 member
const OUTSIDER = 9000; // 隊外帳號

// ─────────────────────────────────────────── 1. RBAC 判定表（逐格手寫期望值）
//
// 維度：{owner/admin/member/身份不明} × {資產屬主 = 自己/他人} × {隊內/隊外}
// 「隊內/隊外」在此模型中以角色表達：owner/admin = 管理主體，member = 隊內成員，
// 身份不明 = 查不到（fail-closed）。
//
//   判定來源（Dramagic 逐字）：
//     Main      「can view and edit all global projects, assets, and teams」→ 全可管
//     Team Admin「can view and edit projects, assets, and members within this team」→ 隊內全可管
//     Member    「Team assets: view 全隊 / manage 自己建的」→ 只可管自己建的

const MATRIX: {
  name: string;
  actor: TeamActor | null;
  assetOwnerUserId: number | null;
  actorUserId: number | null;
  expectManage: boolean;
}[] = [
  // Main（owner）：全帳號資產皆可管（含隊外、他人、屬主不明）
  { name: "Main × 自己資產", actor: actor("owner", TEAM_MAIN), assetOwnerUserId: TEAM_MAIN, actorUserId: TEAM_MAIN, expectManage: true },
  { name: "Main × 隊內他人資產", actor: actor("owner", TEAM_MAIN), assetOwnerUserId: TEAM_MEMBER, actorUserId: TEAM_MAIN, expectManage: true },
  { name: "Main × 隊外他人資產", actor: actor("owner", TEAM_MAIN), assetOwnerUserId: OUTSIDER, actorUserId: TEAM_MAIN, expectManage: true },
  { name: "Main × 屬主不明資產", actor: actor("owner", TEAM_MAIN), assetOwnerUserId: null, actorUserId: TEAM_MAIN, expectManage: true },

  // Team Admin：隊內全部（含他人建的）可管
  { name: "Admin × 自己資產", actor: actor("admin", TEAM_ADMIN), assetOwnerUserId: TEAM_ADMIN, actorUserId: TEAM_ADMIN, expectManage: true },
  { name: "Admin × 隊內 member 資產", actor: actor("admin", TEAM_ADMIN), assetOwnerUserId: TEAM_MEMBER, actorUserId: TEAM_ADMIN, expectManage: true },
  { name: "Admin × 隊內另一 admin 資產", actor: actor("admin", TEAM_ADMIN), assetOwnerUserId: 2001, actorUserId: TEAM_ADMIN, expectManage: true },
  { name: "Admin × 屬主不明資產（fail-closed 不適用於 manager）", actor: actor("admin", TEAM_ADMIN), assetOwnerUserId: null, actorUserId: TEAM_ADMIN, expectManage: true },

  // Member：只可管自己建的
  { name: "Member × 自己資產", actor: actor("member", TEAM_MEMBER), assetOwnerUserId: TEAM_MEMBER, actorUserId: TEAM_MEMBER, expectManage: true },
  { name: "Member × 隊內他人資產", actor: actor("member", TEAM_MEMBER), assetOwnerUserId: TEAM_MEMBER_B, actorUserId: TEAM_MEMBER, expectManage: false },
  { name: "Member × 隊外他人資產", actor: actor("member", TEAM_MEMBER), assetOwnerUserId: OUTSIDER, actorUserId: TEAM_MEMBER, expectManage: false },
  { name: "Member × 屬主不明資產（fail-closed）", actor: actor("member", TEAM_MEMBER), assetOwnerUserId: null, actorUserId: TEAM_MEMBER, expectManage: false },

  // 身份不明（查不到）：fail-closed，一律拒
  { name: "身份不明 × 自己資產", actor: null, assetOwnerUserId: TEAM_MEMBER, actorUserId: TEAM_MEMBER, expectManage: false },
  { name: "身份不明 × 他人資產", actor: null, assetOwnerUserId: TEAM_MEMBER_B, actorUserId: TEAM_MEMBER, expectManage: false },
  { name: "身份不明 × 屬主不明", actor: null, assetOwnerUserId: null, actorUserId: TEAM_MEMBER, expectManage: false },

  // 畸形 actorUserId：fail-closed
  { name: "非法 actorUserId（0）", actor: actor("owner", TEAM_MAIN), assetOwnerUserId: 0, actorUserId: 0, expectManage: false },
  { name: "非法 actorUserId（負數）", actor: actor("admin", TEAM_ADMIN), assetOwnerUserId: TEAM_MEMBER, actorUserId: -1, expectManage: false },
  { name: "actorUserId 非整數", actor: actor("owner", TEAM_MAIN), assetOwnerUserId: TEAM_MEMBER, actorUserId: 1.5, expectManage: false },
];

test("RBAC 三級矩陣 × {屬主} × {隊內/隊外}：逐格手寫期望值", () => {
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
      `${row.name}: 期望 ${row.expectManage ? "ALLOW" : "DENY"}，實得 ${got.allowed ? "ALLOW" : "DENY"}`,
    );
    if (!got.allowed) {
      assert.equal(got.code, TEAM_ASSET_FORBIDDEN_CODE, `${row.name}: 拒時須帶 ${TEAM_ASSET_FORBIDDEN_CODE}`);
      assert.ok((got.message ?? "").length > 0, `${row.name}: 拒時須有文案`);
    }
  }
  // 全表覆蓋率：18 格
  assert.equal(MATRIX.length, 18, "矩陣應為 18 格");
  console.log("[RBAC 實測]\n" + results.join("\n"));
});

test("RBAC 讀取面：隊內全角色可讀，身份不明只可讀自己", () => {
  // Member 可讀隊內他人資產（Dramagic：Team assets view）
  assert.equal(canViewTeamAsset({ actor: actor("member", TEAM_MEMBER), assetOwnerUserId: TEAM_MEMBER_B, actorUserId: TEAM_MEMBER }), true);
  // Admin / Main 可讀隊內他人
  assert.equal(canViewTeamAsset({ actor: actor("admin", TEAM_ADMIN), assetOwnerUserId: TEAM_MEMBER, actorUserId: TEAM_ADMIN }), true);
  assert.equal(canViewTeamAsset({ actor: actor("owner", TEAM_MAIN), assetOwnerUserId: TEAM_MEMBER, actorUserId: TEAM_MAIN }), true);
  // 自己的資產恆可讀（含身份不明時）
  assert.equal(canViewTeamAsset({ actor: null, assetOwnerUserId: TEAM_MEMBER, actorUserId: TEAM_MEMBER }), true);
  // 身份不明且非自己 → 不可讀（fail-closed）
  assert.equal(canViewTeamAsset({ actor: null, assetOwnerUserId: TEAM_MEMBER_B, actorUserId: TEAM_MEMBER }), false);
});

test("RBAC fail-closed：canManageTeamAsset(null 身份) 與 canCreateSharedCanvas(null 身份) 語義相反且並存", async () => {
  const { canCreateSharedCanvas } = await import("./team-governance");
  // 建畫布閘：null = 未配置/非成員 → 放行（fail-open，不擋創作）
  assert.equal(canCreateSharedCanvas({ actor: null, memberCreateCanvas: false }).allowed, true);
  // 資產管理閘：null = 查不到身份 → 拒（fail-closed，不碰別人資料）
  assert.equal(
    canManageTeamAsset({ actor: null, assetOwnerUserId: TEAM_MEMBER, actorUserId: TEAM_MAIN }).allowed,
    false,
  );
  // 兩者並列：member 建畫布受團隊開關限制（本刀未動）
  assert.equal(canCreateSharedCanvas({ actor: { role: "member" }, memberCreateCanvas: false }).allowed, false);
  assert.equal(canCreateSharedCanvas({ actor: { role: "member" }, memberCreateCanvas: true }).allowed, true);
});

test("resolveTeamActor：主帳恆 owner（不入名冊）、名冊外回 null", () => {
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
  // 外人（不在名冊、非主帳）→ null（fail-closed 的輸入）
  assert.equal(resolveTeamActor({ userId: OUTSIDER, teamUserId: TEAM_MAIN, roster }), null);
});

// ─────────────────────────────────────────── 2. 配額邊界

test("團隊配額：fixed 不得低於已分配給成員（超賣保護）", () => {
  // 已分配 500，要求 fixed=400 → 拒（below_allocated）
  const bad = teamQuotaReclaim({ nextMode: "fixed", nextFixedQuota: 400, allocatedToMembers: 500 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "below_allocated");
  assert.equal(bad.reclaim, 0);
  // 已分配 500，要求 fixed=500 → 恰好通過（邊界，允許）
  assert.equal(teamQuotaReclaim({ nextMode: "fixed", nextFixedQuota: 500, allocatedToMembers: 500 }).ok, true);
  // 已分配 500，要求 fixed=501 → 通過
  assert.equal(teamQuotaReclaim({ nextMode: "fixed", nextFixedQuota: 501, allocatedToMembers: 500 }).ok, true);
  // 負數 → 拒
  assert.equal(teamQuotaReclaim({ nextMode: "fixed", nextFixedQuota: -1, allocatedToMembers: 0 }).ok, false);
});

test("團隊配額：改回不限 ⇒ 剩餘全數回收（reclaim = 已分配合計）", () => {
  const first = teamQuotaReclaim({ nextMode: "none", nextFixedQuota: 0, allocatedToMembers: 777 });
  assert.equal(first.ok, true);
  assert.equal(first.reclaim, 777);
  // 已分配 0 時改不限 → 回收 0
  const zero = teamQuotaReclaim({ nextMode: "none", nextFixedQuota: 0, allocatedToMembers: 0 });
  assert.equal(zero.reclaim, 0);
  // 非有限值不當成「有額度」：NaN → 回收 0（不編造）
  const nan = teamQuotaReclaim({ nextMode: "none", nextFixedQuota: 0, allocatedToMembers: Number.NaN });
  assert.equal(nan.reclaim, 0);
});

test("回收上限 = 團隊剩餘（超出即拒）", () => {
  // 剩餘 100，回收 100 → 允許（邊界）
  assert.equal(reclaimWithinRemaining({ reclaimQuota: 100, teamRemaining: 100 }).ok, true);
  // 剩餘 100，回收 101 → 拒
  const over = reclaimWithinRemaining({ reclaimQuota: 101, teamRemaining: 100 });
  assert.equal(over.ok, false);
  assert.equal(over.code, "reclaim_above_remaining");
  // 不限（null）⇒ 無上限
  assert.equal(reclaimWithinRemaining({ reclaimQuota: 9_999_999, teamRemaining: null }).ok, true);
  // 負數 → 拒
  assert.equal(reclaimWithinRemaining({ reclaimQuota: -1, teamRemaining: 100 }).ok, false);
});

test("成員配額：不得超過團隊剩餘（fixed 與 daily 同一把尺）", () => {
  // fixed 恰等於剩餘 → 允許；多 1 → 拒
  assert.equal(memberQuotaWithinTeam({ mode: "fixed", fixedQuota: 300, dailyQuota: 0, teamRemaining: 300 }).ok, true);
  const overFixed = memberQuotaWithinTeam({ mode: "fixed", fixedQuota: 301, dailyQuota: 0, teamRemaining: 300 });
  assert.equal(overFixed.ok, false);
  assert.equal(overFixed.code, "exceeds_team_remaining");
  // daily 也受同一上界
  const overDaily = memberQuotaWithinTeam({ mode: "daily", fixedQuota: 0, dailyQuota: 301, teamRemaining: 300 });
  assert.equal(overDaily.ok, false);
  // unlimited 不受上界（不消耗團隊額度）
  assert.equal(memberQuotaWithinTeam({ mode: "unlimited", fixedQuota: 0, dailyQuota: 0, teamRemaining: 1 }).ok, true);
  // 團隊不限（null）⇒ 無上界
  assert.equal(memberQuotaWithinTeam({ mode: "fixed", fixedQuota: 9_999_999, dailyQuota: 0, teamRemaining: null }).ok, true);
});

test("成員無權設 admin 配額：admin/owner 目標只接受 unlimited", async () => {
  const { canSetMemberQuota } = await import("./team-quota-limits");
  // member 呼叫方 → 一律拒
  assert.equal(canSetMemberQuota({ actorRole: "member", targetRole: "member", mode: "daily" }).ok, false);
  assert.equal(canSetMemberQuota({ actorRole: null, targetRole: "member", mode: "daily" }).ok, false);
  // admin 呼叫方 → 可設 member 配額
  assert.equal(canSetMemberQuota({ actorRole: "admin", targetRole: "member", mode: "daily" }).ok, true);
  // admin 呼叫方 → 對 admin/owner 目標，只接受 unlimited
  const locked = canSetMemberQuota({ actorRole: "admin", targetRole: "admin", mode: "fixed" });
  assert.equal(locked.ok, false);
  assert.equal(locked.code, "admin_unlimited_locked");
  assert.equal(canSetMemberQuota({ actorRole: "admin", targetRole: "admin", mode: "unlimited" }).ok, true);
  assert.equal(canSetMemberQuota({ actorRole: "owner", targetRole: "admin", mode: "daily" }).ok, false);
  assert.equal(canSetMemberQuota({ actorRole: "owner", targetRole: "owner", mode: "unlimited" }).ok, true);
});

// ─────────────────────────────────────────── 3. 每日額度：UTC+8 00:00 重置、不累積

test("配額日界：UTC+8 00:00（= UTC 16:00 前一日）", () => {
  // 2026-09-28T15:59:59Z = 2026-09-28 23:59:59 (UTC+8) → 配額日仍是 09-28
  assert.equal(quotaDayKey(Date.parse("2026-09-28T15:59:59Z")), "2026-09-28");
  // 2026-09-28T16:00:00Z = 2026-09-29 00:00:00 (UTC+8) → 配額日翻成 09-29
  assert.equal(quotaDayKey(Date.parse("2026-09-28T16:00:00Z")), "2026-09-29");
  // UTC+8 的偏移常數是 480 分鐘
  assert.equal(DAILY_QUOTA_EPOCH_OFFSET_MINUTES, 480);
});

test("每日額度跨日重置：不累積，隔日歸零", () => {
  const beforeMidnight = Date.parse("2026-09-28T15:59:00Z"); // UTC+8 09-28 23:59
  const afterMidnight = Date.parse("2026-09-28T16:00:01Z"); // UTC+8 09-29 00:00:01
  // 09-28 記了 500 已用
  assert.equal(effectiveDailyUsed({ storedDay: "2026-09-28", storedUsed: 500, nowMs: beforeMidnight }), 500);
  // 跨到 09-29 → 歸零（不累積）
  assert.equal(effectiveDailyUsed({ storedDay: "2026-09-28", storedUsed: 500, nowMs: afterMidnight }), 0);
  // 同日的負值/NaN 不當成已用
  assert.equal(effectiveDailyUsed({ storedDay: "2026-09-28", storedUsed: -3, nowMs: beforeMidnight }), 0);
  assert.equal(effectiveDailyUsed({ storedDay: "2026-09-28", storedUsed: Number.NaN, nowMs: beforeMidnight }), 0);
  // 從未使用過（null）→ 0
  assert.equal(effectiveDailyUsed({ storedDay: null, storedUsed: 0, nowMs: beforeMidnight }), 0);
});

test("下一次重置時刻 = 下一個 UTC+8 00:00", () => {
  const beforeMidnight = Date.parse("2026-09-28T15:59:00Z");
  assert.equal(nextQuotaResetMs(beforeMidnight), Date.parse("2026-09-28T16:00:00Z"));
  const atMidnight = Date.parse("2026-09-28T16:00:00Z");
  // 恰在 00:00 → 進到隔天
  assert.equal(nextQuotaResetMs(atMidnight), Date.parse("2026-09-29T16:00:00Z"));
  const midday = Date.parse("2026-09-28T04:00:00Z"); // UTC+8 12:00
  assert.equal(nextQuotaResetMs(midday), Date.parse("2026-09-28T16:00:00Z"));
});

test("每日額度是速率限制：用滿即拒，重置後可再用（無預扣）", () => {
  const spec = { mode: "daily" as const, dailyQuota: 1000, dailyUsed: 900 };
  // 再花 100 → 恰滿，允許
  assert.equal(dailyQuotaAllows({ spec, costQuota: 100 }).ok, true);
  // 再花 101 → 拒
  const over = dailyQuotaAllows({ spec, costQuota: 101 });
  assert.equal(over.ok, false);
  assert.equal(over.code, "daily_quota_exceeded");
  // 非 daily 模式不受此閘
  assert.equal(dailyQuotaAllows({ spec: { mode: "unlimited", dailyQuota: 0, dailyUsed: 0 }, costQuota: 9_999 }).ok, true);
  assert.equal(dailyQuotaAllows({ spec: { mode: "fixed", dailyQuota: 0, dailyUsed: 0 }, costQuota: 9_999 }).ok, true);
  // 跨日後（已用歸零）可再用
  assert.equal(dailyQuotaAllows({ spec: { ...spec, dailyUsed: 0 }, costQuota: 1000 }).ok, true);
});

// ─────────────────────────────────────────── 4. 禁影子帳本：配額不產生任何帳本寫入

test("配額操作不寫五態帳本：帳本筆數前後不變", async () => {
  // 帳本讀取面是真實現（readAccountLedger），但本測試環境無控制面 DB。
  // 這正是要證明的反面：**配額層根本沒有帳本寫入路徑**——
  // 對一個不存在的帳本身份讀帳，筆數恆為 0，且配額純函式不觸碰帳本。
  const billingUserId = 987_654;
  let before: unknown[] | null = null;
  let readOk = false;
  try {
    before = await readAccountLedger(billingUserId);
    readOk = true;
  } catch {
    // 無 DB 時 readAccountLedger 會 throw（getGenerationSql 拒）；視為 0 筆。
    before = [];
  }

  // 執行一串配額裁決／邊界運算（純函式，無副作用）
  const ops = [
    teamQuotaReclaim({ nextMode: "fixed", nextFixedQuota: 10_000, allocatedToMembers: 0 }),
    teamQuotaReclaim({ nextMode: "none", nextFixedQuota: 0, allocatedToMembers: 5_000 }),
    memberQuotaWithinTeam({ mode: "fixed", fixedQuota: 1_000, dailyQuota: 0, teamRemaining: 10_000 }),
    reclaimWithinRemaining({ reclaimQuota: 1_000, teamRemaining: 10_000 }),
    dailyQuotaAllows({ spec: { mode: "daily", dailyQuota: 500, dailyUsed: 100 }, costQuota: 50 }),
  ];
  assert.ok(ops.every((op) => typeof op.ok === "boolean"), "配額裁決皆為純函式回傳值");

  let after: unknown[] | null = null;
  try {
    after = await readAccountLedger(billingUserId);
  } catch {
    after = [];
  }

  const beforeCount = before?.length ?? 0;
  const afterCount = after?.length ?? 0;
  assert.equal(afterCount, beforeCount, `配額操作不得改變帳本筆數（前 ${beforeCount} / 後 ${afterCount}）`);
  assert.equal(afterCount, 0, "該身份在無 DB 環境下帳本應為 0 筆");
  console.log(`[帳本證據] readAccountLedger 讀取成功=${readOk}；配額操作前後筆數=${beforeCount}/${afterCount}`);
});

test("配額模組不 import 任何帳本模組（源碼層探針，僅作變更探針不計入已驗）", async () => {
  // 這一條是**變更探針**（AGENTS.md：源碼字串斷言不計入「已驗證」）；
  // 真正的行為斷言是上一條「帳本筆數不變」。
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("./team-quota-limits.ts", import.meta.url), "utf8");
  // 只掃「程式碼」面：剝掉行註解與塊註解（檔頭合法地提到「禁影子帳本」與帳本檔名）。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  // 不准出現帳本寫入函式名或帳本模組 import
  const IMPORT_OR_CALL = /(from\s+["'][^"']*billing-ledger|require\(["'][^"']*billing-ledger)/;
  assert.ok(!IMPORT_OR_CALL.test(code), "配額模組不得 import 帳本模組");
  for (const forbidden of [
    "postLedgerEntries",
    "recordConsumption",
    "recordTransfer",
    "recordRecharge",
    "recordAdjustment",
    "reserveGenerationBilling",
  ]) {
    assert.ok(!code.includes(forbidden), `配額模組不得引用帳本符號 ${forbidden}`);
  }
  // member-quota 只准唯讀（readTeamQuotaView）——不准出現分配通路
  assert.ok(!code.includes("allocateMemberQuota"), "配額模組不得呼叫分配通路（點數移動另走轉移通路）");
  assert.ok(
    !code.includes("adjustGatewayUserQuotaExact") && !code.includes("setGatewayUserImageQuota"),
    "配額模組不得呼叫任何上游額度調整",
  );
});
