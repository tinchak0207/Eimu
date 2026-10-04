// 激活漏斗「按注册来源拆分」的具名验收（node:test）。
//
// 这一刀的核心不变式（缺了就是假报表）：**各来源的每一格加总恒等于总漏斗对应步骤的人数**。
// 另外钉住：没有归因事实 → 进 UNATTRIBUTED 桶（不猜成 direct）；不在 cohort 内的归因列
// 不许凭空造出一个来源；归因读取失败的旗标要原样透出。

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
  // 301：唯一一天出图成功（不回访）
  job(301, "j-301", "succeeded", "2026-09-11T01:00:00.000Z", "2026-09-11T01:05:00.000Z"),
  // 302：D1 回访 + 现金充值
  job(302, "j-302a", "succeeded", "2026-09-11T02:00:00.000Z", "2026-09-11T02:05:00.000Z"),
  job(302, "j-302b", "succeeded", "2026-09-12T02:00:00.000Z", "2026-09-12T02:05:00.000Z"),
  // 303：发起过但没成功（direct 来源）
  job(303, "j-303", "failed", "2026-09-11T03:00:00.000Z", "2026-09-11T03:10:00.000Z"),
  // 304：登入后从未发起 → 只在 registered 步骤
  // 305：回访但没付费（weixin 来源）
  job(305, "j-305a", "succeeded", "2026-09-11T05:00:00.000Z", "2026-09-11T05:05:00.000Z"),
  job(305, "j-305b", "succeeded", "2026-09-12T05:00:00.000Z", "2026-09-12T05:05:00.000Z"),
  // 306：回访 + 现金充值，但归因列存在而来源为 NULL（例如旧列）→ 未标记
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
  // 不在 cohort 内（例如本期窗口外注册）→ 不许造出一个来源桶。
  { userId: 999, source: "someone-else" },
];

function rowFor(rows: readonly FunnelSourceRow[], source: string): FunnelSourceRow {
  const found = rows.find((row) => row.source === source);
  assert.ok(found, `缺少来源桶 ${source}（现有：${rows.map((row) => row.source).join(", ")}）`);
  return found;
}

test("来源拆分：各来源每一格加总恒等于总漏斗对应步骤（registered/generated/succeeded/paid）", () => {
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

test("来源拆分：逐桶人数与夹具手算一致；无归因／来源 NULL 都进未标记桶，cohort 外归因列被忽略", () => {
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
  // 304（无归因列）＋ 306（列存在但来源 NULL）
  assert.deepEqual(rowFor(funnel.sources, UNATTRIBUTED_SOURCE), {
    source: UNATTRIBUTED_SOURCE,
    registered: 2,
    generated: 1,
    succeeded: 1,
    paid: 1,
  });
  assert.equal(funnel.sources.some((row) => row.source === "someone-else"), false);
  assert.equal(funnel.sources.length, 4);
  // 排序：注册人数多的在前；同数按分组键排序（稳定、可重放）。
  const counts = funnel.sources.map((row) => row.registered);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  assert.equal(funnel.sourceBreakdownUnavailable, false);
});

test("来源拆分：没有归因事实＝全部进未标记桶（不猜成 direct）；旗标原样透出", () => {
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

test("buildFunnelSourceRows：只以 registered 开桶，后续步骤必定落在既有桶内", () => {
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
  // 空 cohort → 空拆分（不是一个 0 人桶）。
  assert.deepEqual(buildFunnelSourceRows({ registered: [], generated: [], succeeded: [], paid: [] }), []);
});
