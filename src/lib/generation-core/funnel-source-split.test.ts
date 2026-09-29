// 激活漏斗「按註冊來源拆分」的具名驗收（node:test）。
//
// 這一刀的核心不變式（缺了就是假報表）：**各來源的每一格加總恆等於總漏斗對應步驟的人數**。
// 另外釘住：沒有歸因事實 → 進 UNATTRIBUTED 桶（不猜成 direct）；不在 cohort 內的歸因列
// 不許憑空造出一個來源；歸因讀取失敗的旗標要原樣透出。

import test from "node:test";
import assert from "node:assert/strict";
import { UNATTRIBUTED_SOURCE } from "@/lib/first-touch-attribution";
import {
  FUNNEL_STEP_ORDER,
  buildFunnelSourceRows,
  projectActivationFunnel,
  type FunnelAttribution,
  type FunnelJob,
  type FunnelRecharge,
  type FunnelRegistration,
  type FunnelSourceRow,
} from "./statistics-projection";

const NOW = new Date("2026-09-27T04:00:00.000Z");

function registration(userId: number, registeredAt = "2026-09-10T00:00:00.000Z"): FunnelRegistration {
  return { userId, registeredAt };
}

function job(userId: number, jobId: string, status: string, createdAt: string, finishedAt: string | null): FunnelJob {
  return { userId, jobId, status, createdAt, finishedAt };
}

const REGISTRATIONS: FunnelRegistration[] = [301, 302, 303, 304, 305, 306].map((id) => registration(id));

const JOBS: FunnelJob[] = [
  // 301：唯一一天出圖成功（不回訪）
  job(301, "j-301", "succeeded", "2026-09-11T01:00:00.000Z", "2026-09-11T01:05:00.000Z"),
  // 302：D1 回訪 + 現金充值
  job(302, "j-302a", "succeeded", "2026-09-11T02:00:00.000Z", "2026-09-11T02:05:00.000Z"),
  job(302, "j-302b", "succeeded", "2026-09-12T02:00:00.000Z", "2026-09-12T02:05:00.000Z"),
  // 303：發起過但沒成功（direct 來源）
  job(303, "j-303", "failed", "2026-09-11T03:00:00.000Z", "2026-09-11T03:10:00.000Z"),
  // 304：登入後從未發起 → 只在 registered 步驟
  // 305：回訪但沒付費（weixin 來源）
  job(305, "j-305a", "succeeded", "2026-09-11T05:00:00.000Z", "2026-09-11T05:05:00.000Z"),
  job(305, "j-305b", "succeeded", "2026-09-12T05:00:00.000Z", "2026-09-12T05:05:00.000Z"),
  // 306：回訪 + 現金充值，但歸因列存在而來源為 NULL（例如舊列）→ 未標記
  job(306, "j-306a", "succeeded", "2026-09-11T06:00:00.000Z", "2026-09-11T06:05:00.000Z"),
  job(306, "j-306b", "succeeded", "2026-09-12T06:00:00.000Z", "2026-09-12T06:05:00.000Z"),
];

const RECHARGES: FunnelRecharge[] = [
  { ledgerId: "l-302", userId: 302, source: "redemption-sync", createdAt: "2026-09-11T04:00:00.000Z" },
  { ledgerId: "l-306", userId: 306, source: "redemption-sync", createdAt: "2026-09-11T07:00:00.000Z" },
];

const ATTRIBUTION: FunnelAttribution[] = [
  { userId: 301, source: "bilibili" },
  { userId: 302, source: "bilibili" },
  { userId: 303, source: "direct" },
  { userId: 305, source: "weixin" },
  { userId: 306, source: null },
  // 不在 cohort 內（例如本期窗口外註冊）→ 不許造出一個來源桶。
  { userId: 999, source: "someone-else" },
];

function rowFor(rows: readonly FunnelSourceRow[], source: string): FunnelSourceRow {
  const found = rows.find((row) => row.source === source);
  assert.ok(found, `缺少來源桶 ${source}（現有：${rows.map((row) => row.source).join(", ")}）`);
  return found;
}

test("來源拆分：各來源每一格加總恆等於總漏斗對應步驟（registered/generated/succeeded/paid）", () => {
  const funnel = projectActivationFunnel({
    days: 30,
    now: NOW,
    registrations: REGISTRATIONS,
    jobs: JOBS,
    recharges: RECHARGES,
    internalUserIds: [],
    includeInternal: false,
    attribution: ATTRIBUTION,
  });

  const totals = Object.fromEntries(funnel.steps.map((step) => [step.key, step.count]));
  assert.deepEqual(funnel.steps.map((step) => step.key), [...FUNNEL_STEP_ORDER]);
  assert.equal(totals.registered, 6);
  assert.equal(totals.generated, 5);
  assert.equal(totals.succeeded, 4);
  assert.equal(totals.paid, 2);

  const sums = funnel.sources.reduce(
    (acc, row) => ({
      registered: acc.registered + row.registered,
      generated: acc.generated + row.generated,
      succeeded: acc.succeeded + row.succeeded,
      paid: acc.paid + row.paid,
    }),
    { registered: 0, generated: 0, succeeded: 0, paid: 0 },
  );
  assert.deepEqual(sums, {
    registered: totals.registered,
    generated: totals.generated,
    succeeded: totals.succeeded,
    paid: totals.paid,
  });
});

test("來源拆分：逐桶人數與夾具手算一致；無歸因／來源 NULL 都進未標記桶，cohort 外歸因列被忽略", () => {
  const funnel = projectActivationFunnel({
    days: 30,
    now: NOW,
    registrations: REGISTRATIONS,
    jobs: JOBS,
    recharges: RECHARGES,
    internalUserIds: [],
    includeInternal: false,
    attribution: ATTRIBUTION,
  });

  assert.deepEqual(rowFor(funnel.sources, "bilibili"), {
    source: "bilibili",
    registered: 2,
    generated: 2,
    succeeded: 2,
    paid: 1,
  });
  assert.deepEqual(rowFor(funnel.sources, "direct"), {
    source: "direct",
    registered: 1,
    generated: 1,
    succeeded: 0,
    paid: 0,
  });
  assert.deepEqual(rowFor(funnel.sources, "weixin"), {
    source: "weixin",
    registered: 1,
    generated: 1,
    succeeded: 1,
    paid: 0,
  });
  // 304（無歸因列）＋ 306（列存在但來源 NULL）
  assert.deepEqual(rowFor(funnel.sources, UNATTRIBUTED_SOURCE), {
    source: UNATTRIBUTED_SOURCE,
    registered: 2,
    generated: 1,
    succeeded: 1,
    paid: 1,
  });
  assert.equal(funnel.sources.some((row) => row.source === "someone-else"), false);
  assert.equal(funnel.sources.length, 4);
  // 排序：註冊人數多的在前；同數按分組鍵排序（穩定、可重放）。
  const counts = funnel.sources.map((row) => row.registered);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  assert.equal(funnel.sourceBreakdownUnavailable, false);
});

test("來源拆分：沒有歸因事實＝全部進未標記桶（不猜成 direct）；旗標原樣透出", () => {
  const funnel = projectActivationFunnel({
    days: 30,
    now: NOW,
    registrations: REGISTRATIONS,
    jobs: JOBS,
    recharges: RECHARGES,
    internalUserIds: [],
    includeInternal: false,
    sourceBreakdownUnavailable: true,
  });
  assert.equal(funnel.sources.length, 1);
  assert.deepEqual(funnel.sources[0], {
    source: UNATTRIBUTED_SOURCE,
    registered: 6,
    generated: 5,
    succeeded: 4,
    paid: 2,
  });
  assert.equal(funnel.sourceBreakdownUnavailable, true);
});

test("buildFunnelSourceRows：只以 registered 開桶，後續步驟必定落在既有桶內", () => {
  const rows = buildFunnelSourceRows({
    registered: [1, 2, 3],
    generated: [1, 2],
    succeeded: [2],
    paid: [2],
    attribution: [{ userId: 2, source: "b23" }],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rowFor(rows, "b23"), { source: "b23", registered: 1, generated: 1, succeeded: 1, paid: 1 });
  assert.deepEqual(rowFor(rows, UNATTRIBUTED_SOURCE), {
    source: UNATTRIBUTED_SOURCE,
    registered: 2,
    generated: 1,
    succeeded: 0,
    paid: 0,
  });
  // 空 cohort → 空拆分（不是一個 0 人桶）。
  assert.deepEqual(buildFunnelSourceRows({ registered: [], generated: [], succeeded: [], paid: [] }), []);
});
