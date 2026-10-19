// REQ-C2「Statistics 统计视图」具名验收测试。
//
// 验的是本刀的三条纪律，不是覆盖率：
// 1. 聚合口径与帐本逐条吻合——每个桶的分币数必须等于它所引用的帐本行加总（逐桶重算）；
// 2. 样本不足画「资料不足」而不是 0——比率、剩余额度、空窗口三处都验；
// 3. unknown 不被折叠——渠道判活第三态、模型活性第三态都验。
// 外加两条守门件：统计层只读（原始码层面没有写语句）、渠道判活与 scheduler 同源。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHANNEL_LIVENESS_LABEL,
  DEFAULT_INTERNAL_USER_IDS,
  FUNNEL_STEP_ORDER,
  MAX_QUOTA_USERS,
  MIN_RATE_SAMPLES,
  buildStatisticsProjection,
  buildUsageNotes,
  calendarDayOf,
  channelLivenessOf,
  isCashRechargeSource,
  nearestRankPercentile,
  projectActivationFunnel,
  resolveInternalUserIds,
  returnedWithin,
  projectChannelHealth,
  projectConsumption,
  projectRemainingQuota,
  quotaToCoins,
  readBillingIdentityCoverage,
  sampleRate,
  windowStartDay,
  type FunnelJob,
  type FunnelRecharge,
  type FunnelRegistration,
  type LedgerConsumptionRow,
  type RemainingQuotaEntry,
} from "./statistics-projection";
import { generationDatabaseConfigured, type GenerationSql } from "./database";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

/** 去注解后才做负向断言：解释禁令的注解不该误触守门件。 */
function readCode(relPath: string) {
  return read(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * 帐本样本（每行都是「production 会拿到的一条 billing_operation 投影」）。
 * 刻意留一行没有成功尝试（op-3）——它必须进「未归因」，不许摊派给任何渠道。
 * 本组全是 commit（扣费）；退款的净额口径另有三组专门样本（见下方 REFUND_* 常数）。
 */
const LEDGER: LedgerConsumptionRow[] = [
  {
    operationId: "op-0001",
    jobId: "job-0001",
    modelId: "gpt-image-2",
    billingUserId: 11,
    channelId: "sub2api",
    channelLabel: "Sub2API",
    amountQuota: 250_000,
    kind: "commit",
    appliedAt: "2026-09-20T02:00:00.000Z",
    day: "2026-09-20",
  },
  {
    operationId: "op-0002",
    jobId: "job-0002",
    modelId: "gpt-image-2",
    billingUserId: 11,
    channelId: "sub2api",
    channelLabel: "Sub2API",
    amountQuota: 500_000,
    kind: "commit",
    appliedAt: "2026-09-20T09:30:00.000Z",
    day: "2026-09-20",
  },
  {
    operationId: "op-0003",
    jobId: "job-0003",
    modelId: "pixai-kotone",
    billingUserId: 12,
    channelId: null,
    channelLabel: null,
    amountQuota: 125_000,
    kind: "commit",
    appliedAt: "2026-09-21T01:00:00.000Z",
    day: "2026-09-21",
  },
  {
    operationId: "op-0004",
    jobId: "job-0004",
    modelId: "pixai-kotone",
    billingUserId: 12,
    channelId: "adobe2api",
    channelLabel: "Adobe2API",
    amountQuota: 750_000,
    kind: "commit",
    appliedAt: "2026-09-21T11:00:00.000Z",
    day: "2026-09-21",
  },
];

const LEDGER_TOTAL_QUOTA = 1_625_000;

/** 全额退款：同一 job 一笔 commit 一笔 refund，两笔都是帐本上真实存在的行。 */
const FULL_REFUND_LEDGER: LedgerConsumptionRow[] = [
  {
    operationId: "op-charge-full",
    jobId: "job-refunded",
    modelId: "gpt-image-2",
    billingUserId: 11,
    channelId: null,
    channelLabel: null,
    amountQuota: 1_000_000,
    kind: "commit",
    appliedAt: "2026-09-20T02:00:00.000Z",
    day: "2026-09-20",
  },
  {
    operationId: "op-refund-full",
    jobId: "job-refunded",
    modelId: "gpt-image-2",
    billingUserId: 11,
    channelId: null,
    channelLabel: null,
    amountQuota: 1_000_000,
    kind: "refund",
    appliedAt: "2026-09-20T03:00:00.000Z",
    day: "2026-09-20",
  },
];

test("聚合口径与账本逐条吻合：每个桶的 quota 重新加总后与账本行分毫不差", () => {
  const projection = projectConsumption(LEDGER);

  assert.equal(projection.totalQuota, LEDGER_TOTAL_QUOTA);
  assert.equal(projection.operations, LEDGER.length);
  assert.equal(projection.totalCoins, quotaToCoins(LEDGER_TOTAL_QUOTA));

  // 逐桶重算：桶内的 recordIds 只是样本，所以按 key 重新从帐本行过滤加总。
  const quotaOf = (predicate: (row: LedgerConsumptionRow) => boolean) =>
    LEDGER.filter(predicate).reduce((sum, row) => sum + row.amountQuota, 0);

  for (const bucket of projection.byDay) {
    assert.equal(bucket.quota, quotaOf((row) => row.day === bucket.key), `day ${bucket.key} 分币数不等于账本行加总`);
  }
  for (const bucket of projection.byModel) {
    assert.equal(bucket.quota, quotaOf((row) => row.modelId === bucket.key), `model ${bucket.key} 分币数不等于账本行加总`);
  }
  for (const bucket of projection.byChannel) {
    assert.equal(bucket.quota, quotaOf((row) => row.channelId === bucket.key), `channel ${bucket.key} 分币数不等于账本行加总`);
  }

  // 三个切面 + 未归因必须与总数三方闭合（少一分钱就是报表在撒谎）。
  const sumByDay = projection.byDay.reduce((sum, bucket) => sum + bucket.quota, 0);
  const sumByModel = projection.byModel.reduce((sum, bucket) => sum + bucket.quota, 0);
  const sumByChannel = projection.byChannel.reduce((sum, bucket) => sum + bucket.quota, 0);
  assert.equal(sumByDay, projection.totalQuota);
  assert.equal(sumByModel, projection.totalQuota);
  assert.equal(sumByChannel + projection.unattributed.quota, projection.totalQuota);
});

test("数字→记录对照：每个聚合数字都能指回真实存在的账本行 id（含未归因单列）", () => {
  const projection = projectConsumption(LEDGER);
  const byId = new Map(LEDGER.map((row) => [row.operationId, row]));
  const table: Array<{ 数字: string; 值: string; 记录: string }> = [];

  const assertTraceable = (label: string, value: number, recordIds: string[]) => {
    assert.ok(recordIds.length > 0, `${label} 没有任何可回溯的账本行 id`);
    for (const id of recordIds) {
      const row = byId.get(id);
      assert.ok(row, `${label} 引用了不存在的账本行 ${id}`);
      assert.ok(Number.isFinite(row!.amountQuota) && row!.amountQuota > 0, `${label} 引用的 ${id} 不是一条有效扣费行`);
    }
    table.push({ 数字: label, 值: String(value), 记录: recordIds.join(", ") });
  };

  assertTraceable(`窗口内消耗 quota=${projection.totalQuota}`, projection.totalQuota, [
    projection.byDay[0].recordIds[0],
    projection.byDay[1].recordIds[0],
  ]);
  for (const bucket of projection.byModel) assertTraceable(`模型 ${bucket.label}`, bucket.quota, bucket.recordIds);
  for (const bucket of projection.byChannel) assertTraceable(`渠道 ${bucket.label}`, bucket.quota, bucket.recordIds);
  assertTraceable("未归因消耗", projection.unattributed.quota, projection.unattributed.recordIds);

  // 未归因只能来自「没有成功尝试」的行，绝不摊派给任何渠道。
  assert.deepEqual(projection.unattributed.recordIds, ["op-0003"]);
  assert.equal(projection.unattributed.quota, 125_000);
  assert.equal(
    projection.byChannel.reduce((sum, bucket) => sum + bucket.operations, 0) + projection.unattributed.operations,
    LEDGER.length,
  );

  console.log("\n[数字→记录对照]\n" + table.map((row) => `  ${row.数字} = ${row.值}  ← ${row.记录}`).join("\n"));
});

test("样本不足显示「资料不足」而不是 0：比率、剩余额度、空窗口三处都如实标注", () => {
  // ① 比率：2 个样本（< MIN_RATE_SAMPLES=3，与 routing-telemetry latencyP80 同门槛）
  const thin = sampleRate(1, 2);
  assert.equal(thin.state, "insufficient");
  assert.equal("value" in thin, false, "样本不足时不得给出 0 冒充比率");
  assert.equal(thin.minimum, MIN_RATE_SAMPLES);
  const rich = sampleRate(7, 9);
  assert.equal(rich.state, "ok");
  assert.equal(rich.state === "ok" ? rich.value : 0, 7 / 9);

  // ② 剩余额度：读不到就是 unknown，不计入合计、不显示 0
  const entries: RemainingQuotaEntry[] = [
    { billingUserId: 11, state: "known", quota: 2_500_000, coins: 5 },
    { billingUserId: 12, state: "unknown", quota: null, coins: null, reason: "new-api 未回该用户额度" },
  ];
  const quota = projectRemainingQuota(entries);
  assert.equal(quota.knownQuota, 2_500_000);
  assert.equal(quota.knownCount, 1);
  assert.equal(quota.unknownCount, 1);
  assert.equal(quota.entries[1].quota, null, "未知额度不得回落成 0");
  assert.equal(quota.entries[1].coins, null);

  // ③ 空窗口：不画 0 曲线，明写「没有任何已落帐记录」
  const emptyNotes = buildUsageNotes({ days: 7, rowCount: 0, generatedAt: "2026-09-22T00:00:00.000Z" });
  assert.equal(emptyNotes.partial, false);
  assert.ok(
    emptyNotes.notes.some((note) => note.includes("没有任何已落帐的扣费记录")),
    "空窗口必须明写没有记录，而不是给 0",
  );
  const empty = projectConsumption([]);
  assert.equal(empty.totalQuota, 0);
  assert.deepEqual(empty.byDay, [], "没有账本行的日子不得出现在按日桶里（不补 0）");
  assert.deepEqual(empty.byModel, []);
  assert.deepEqual(empty.byChannel, []);
  assert.equal(empty.unattributed.operations, 0);
});

test("unknown 不被折叠成 0 / success：渠道三态第三态原样保留", () => {
  const entries = projectChannelHealth([
    {
      channel_id: "sub2api",
      label: "Sub2API",
      capabilities: 3,
      schedulable_capabilities: 3,
      reason: "执行侧账户冷却或禁用",
      success_count: "12",
      failure_count: "2",
      last_success_at: "2026-09-21T10:00:00.000Z",
      last_failure_at: null,
    },
    {
      channel_id: "adobe2api",
      label: "Adobe2API",
      capabilities: 2,
      schedulable_capabilities: 0,
      reason: "执行侧供应商冷却或禁用",
      success_count: "0",
      failure_count: "0",
      last_success_at: null,
      last_failure_at: null,
    },
    {
      channel_id: "pixai-pool",
      label: "PixAI 池",
      capabilities: 0,
      schedulable_capabilities: 0,
      reason: "渠道无当前生效能力记录，账本无据可判",
      success_count: "0",
      failure_count: "0",
      last_success_at: null,
      last_failure_at: null,
    },
  ]);

  const byId = new Map(entries.map((entry) => [entry.channelId, entry]));
  assert.equal(byId.get("sub2api")!.liveness, "available");
  assert.equal(byId.get("adobe2api")!.liveness, "unavailable");
  // 第三态：无能力记录 → unknown，既不是 available 也不是 unavailable
  assert.equal(byId.get("pixai-pool")!.liveness, "unknown");
  assert.notEqual(byId.get("pixai-pool")!.liveness, "unavailable");
  assert.notEqual(byId.get("pixai-pool")!.liveness, "available");
  assert.equal(byId.get("pixai-pool")!.capabilities, 0);
  assert.match(byId.get("pixai-pool")!.reason, /无据可判/);

  // 0 样本渠道：比率是「资料不足」，不是 0%（把没有样本说成 0% 成功率 = 假数字）
  assert.equal(byId.get("adobe2api")!.successRate.state, "insufficient");
  assert.equal(byId.get("sub2api")!.successRate.state, "ok");
  assert.equal(byId.get("pixai-pool")!.successRate.state, "insufficient");

  // 三态字典恰好三个键（多一个少一个都说明有人加了第四态或折了一态）
  assert.deepEqual(Object.keys(CHANNEL_LIVENESS_LABEL).sort(), ["available", "unavailable", "unknown"]);
  assert.equal(channelLivenessOf({ capabilities: 1, schedulableCapabilities: 0 }), "unavailable");
  assert.equal(channelLivenessOf({ capabilities: 1, schedulableCapabilities: 1 }), "available");
  assert.equal(channelLivenessOf({ capabilities: 0, schedulableCapabilities: 0 }), "unknown");
});

test("渠道判活与执行侧同一把尺：判据只在 supplier-health-signal 一处定义，统计层不自造健康度", () => {
  const signal = read("src/lib/supplier-health-signal.ts");
  const projection = read("src/lib/generation-core/statistics-projection.ts");

  assert.match(signal, /export async function readSupplierHealthSignal/);
  assert.match(signal, /export async function readSupplierChannelHealth/);
  // 判据逐字同源（supplier / capability / account 三者与冷却窗口）
  assert.match(signal, /supplier\.health_status <> 'disabled'/);
  assert.match(signal, /supplier\.cooldown_until IS NULL OR supplier\.cooldown_until <= now\(\)/);
  assert.match(signal, /account\.cooldown_until IS NULL OR account\.cooldown_until <= now\(\)/);
  assert.match(signal, /capability\.is_current AND capability\.enabled/);
  // 统计层只调用轮子，不自己写 supplier_capability 查询、也不造健康分
  assert.match(projection, /readSupplierChannelHealth/);
  assert.doesNotMatch(readCode("src/lib/generation-core/statistics-projection.ts"), /FROM\s+supplier_capability/);
  assert.doesNotMatch(readCode("src/lib/generation-core/statistics-projection.ts"), /health_score/);
});

test("统计层只读：投影层/路由/管理组件三层都没有任何写语句，路由必须验管理员 session", () => {
  const files = [
    "src/lib/generation-core/statistics-projection.ts",
    "src/app/api/admin/statistics/route.ts",
    "src/components/admin/AdminStatistics.tsx",
  ];
  for (const file of files) {
    const code = readCode(file);
    assert.doesNotMatch(code, /INSERT\s+INTO/i, `${file} 不得包含 INSERT`);
    assert.doesNotMatch(code, /DELETE\s+FROM/i, `${file} 不得包含 DELETE`);
    assert.doesNotMatch(code, /\bUPDATE\b/i, `${file} 不得包含 UPDATE`);
  }

  const route = read("src/app/api/admin/statistics/route.ts");
  assert.match(route, /requireAdminSession/);
  assert.match(route, /no-store/);
  assert.doesNotMatch(route, /getGenerationSql|postgres/, "路由不得自己持有 SQL 客户端");

  // 判活三类文案都在展示层（话术只许存在于展示层）；文案收进展示层单一来源后，
  // 元件只引用键——投影层照样不得出现这几句话术。
  const ui = read("src/components/admin/AdminStatistics.tsx");
  const copy = read("src/lib/ui-strings.ts");
  assert.match(copy, /资料不足/);
  assert.match(copy, /无法判定/);
  assert.match(copy, /billing_operation/);
  assert.match(ui, /stats\.rate\.insufficient/);
  assert.match(ui, /stats\.liveness\.unknown/);
  assert.match(ui, /stats\.card\.ledgerSource/);
  assert.doesNotMatch(ui, /dangerouslySetInnerHTML/);
});

test("统计分页接入既有 admin 外壳：走既有外壳与既有路由约定，不新造框架", () => {
  const shell = read("src/components/admin/AdminPoolManager.tsx");
  assert.match(shell, /AdminStatistics/);
  assert.match(shell, /"statistics"/);
  assert.match(shell, /用量统计/);
  // 既有外壳结构未被改写（导航仍是 NAV_ITEMS 驱动，仍保留原有分页）
  assert.match(shell, /NAV_ITEMS/);
  assert.match(shell, /AdminHome/);
  assert.match(shell, /AdminRoutingPanel/);

  const ui = read("src/components/admin/AdminStatistics.tsx");
  // 管理面跟既有 admin 扁平 token，不引入第二套材料
  assert.match(ui, /bg-\[#20242c\]/);
  assert.doesNotMatch(ui, /lg-glass|lg-card|paper-card/);
});

test("端到端组装：buildStatisticsProjection 从账本行到投影的链路（stub SQL，无写库）", async () => {
  const consumptionRows = LEDGER.map((row) => ({
    operation_id: row.operationId,
    job_id: row.jobId,
    model_id: row.modelId,
    billing_user_id: row.billingUserId,
    amount: row.amountQuota,
    operation_kind: row.kind,
    applied_at: row.appliedAt,
    day: row.day,
    channel_id: row.channelId,
    channel_label: row.channelLabel,
  }));

  // 只读 stub：依 SQL 文字分流回传既有表内容，证明组装层逐栏映射正确。
  const stub = ((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("DISTINCT job.billing_user_id")) {
      return Promise.resolve([{ billing_user_id: "11" }, { billing_user_id: "12" }]);
    }
    if (text.includes("count(DISTINCT capability.id)")) {
      return Promise.resolve([
        {
          channel_id: "sub2api",
          label: "Sub2API",
          capabilities: 3,
          schedulable_capabilities: 3,
          reason: "执行侧账户冷却或禁用",
          success_count: "12",
          failure_count: "2",
          last_success_at: "2026-09-21T10:00:00.000Z",
          last_failure_at: null,
        },
      ]);
    }
    return Promise.resolve(consumptionRows);
  }) as unknown as GenerationSql;

  const projection = await buildStatisticsProjection({
    days: 7,
    sql: stub,
    loadRemainingQuota: async (userIds) => {
      assert.deepEqual(userIds, [11, 12]);
      return [
        { billingUserId: 11, state: "known", quota: 2_500_000, coins: quotaToCoins(2_500_000) },
        { billingUserId: 12, state: "unknown", quota: null, coins: null, reason: "new-api 不可达" },
      ];
    },
  });

  assert.equal(projection.configured, true);
  assert.equal(projection.window.dayTimezone, "Asia/Shanghai");
  assert.equal(projection.window.partial, false);
  assert.equal(projection.consumption!.totalQuota, LEDGER_TOTAL_QUOTA);
  assert.equal(projection.consumption!.operations, 4);
  assert.equal(projection.consumption!.unattributed.quota, 125_000);
  assert.equal(projection.channelHealth.length, 1);
  assert.equal(projection.channelHealth[0].liveness, "available");
  assert.equal(projection.remainingQuota.knownQuota, 2_500_000);
  assert.equal(projection.remainingQuota.unknownCount, 1);
  // 没被截断就要说没被截断（截断标记不能是恒真）
  assert.equal(projection.remainingQuota.coverage.truncated, false);
  assert.equal(projection.remainingQuota.coverage.totalIdentities, 2);
  // 半天桶标记与 windowStartDay 同源（同一颗时钟算出，不可能是两个数字）
  assert.equal(projection.window.windowStartDay, windowStartDay({ days: 7, now: new Date(projection.window.generatedAt) }));
  // 每个指标都签名了自己的数据源（页面「数据来源对照」直接渲染它）
  assert.ok(projection.sources.some((source) => source.source.includes("billing_operation")));
  assert.ok(projection.sources.some((source) => source.source.includes("users.quota")));
});

test("控制面 DB 未配置时不吐正常空报表，如实标 configured:false", async (t) => {
  if (generationDatabaseConfigured()) {
    t.skip("本环境已配置 GENERATION_DATABASE_URL，跳过未配置分支");
    return;
  }
  const projection = await buildStatisticsProjection({ days: 7 });
  assert.equal(projection.configured, false);
  assert.equal(projection.consumption, null);
  assert.deepEqual(projection.channelHealth, []);
  assert.ok(projection.notes.some((note) => note.includes("GENERATION_DATABASE_URL")));
});

// ── C2-1 净额口径：退款必须相减（全额／部分／纯退款三个边界） ─────────────────

test("C2-1 全额退款：消耗净额归零、不落「未归因」，退款单列「已退款」桶且逐笔可回溯", () => {
  const projection = projectConsumption(FULL_REFUND_LEDGER);

  // 口径：消耗 = Σcommit − Σrefund（同一 job 同窗口相抵）
  assert.equal(projection.chargedQuota, 1_000_000);
  assert.equal(projection.refundedQuota, 1_000_000);
  assert.equal(projection.totalQuota, 0, "全额退款后消耗必须归零——把已退的钱算成消耗就是假报表");
  assert.equal(projection.totalCoins, 0);
  // 帐本行照样存在（operations 是「帐本有几行」的事实，不因相抵而消失）
  assert.equal(projection.operations, 2);
  assert.equal(projection.chargedOperations, 1);
  assert.equal(projection.refundedOperations, 1);

  // 不落「未归因」：该 job 无成功尝试（本会落进未归因），相抵后不再占任何消耗位
  assert.equal(projection.unattributed.quota, 0);
  assert.equal(projection.unattributed.operations, 0, "全额退款不得再冒充一笔未归因消耗");
  assert.deepEqual(projection.unattributed.recordIds, []);
  assert.deepEqual(projection.byChannel, []);
  assert.deepEqual(projection.byDay, [], "净额为 0 的 job 不画成任何一天的消耗");
  assert.deepEqual(projection.byModel, []);

  // 单列「已退款」桶：退款自己的数字与账本行 id 都在
  assert.equal(projection.refunded.quota, 1_000_000);
  assert.equal(projection.refunded.coins, quotaToCoins(1_000_000));
  assert.equal(projection.refunded.operations, 1);
  assert.equal(projection.refunded.jobs, 1);
  assert.equal(projection.refunded.fullyRefundedJobs, 1);
  assert.equal(projection.refunded.netZeroRows, 2);
  assert.deepEqual(projection.refunded.recordIds, ["op-refund-full"]);

  // 数字→记录对照（含全额退款这一笔）
  const table = [
    `消耗净额 = ${projection.totalQuota}  ← op-charge-full(+1000000) − op-refund-full(−1000000)`,
    `已退款 = ${projection.refunded.quota}  ← ${projection.refunded.recordIds.join(", ")}`,
    `未归因 = ${projection.unattributed.quota}  ← （无）`,
  ];
  console.log("\n[C2-1 全额退款 · 数字→记录对照]\n" + table.map((row) => `  ${row}`).join("\n"));
});

test("C2-1 部分退款：净额正确、仍归属原渠道，退款金额单列", () => {
  const partial: LedgerConsumptionRow[] = [
    {
      operationId: "op-charge-partial",
      jobId: "job-partial",
      modelId: "gpt-image-2",
      billingUserId: 11,
      channelId: "sub2api",
      channelLabel: "Sub2API",
      amountQuota: 1_000_000,
      kind: "commit",
      appliedAt: "2026-09-20T02:00:00.000Z",
      day: "2026-09-20",
    },
    {
      operationId: "op-refund-partial",
      jobId: "job-partial",
      modelId: "gpt-image-2",
      billingUserId: 11,
      channelId: "sub2api",
      channelLabel: "Sub2API",
      amountQuota: 300_000,
      kind: "refund",
      appliedAt: "2026-09-21T02:00:00.000Z",
      day: "2026-09-21",
    },
  ];
  const projection = projectConsumption(partial);

  assert.equal(projection.totalQuota, 700_000);
  assert.equal(projection.totalCoins, quotaToCoins(700_000));
  assert.equal(projection.chargedQuota, 1_000_000);
  assert.equal(projection.refundedQuota, 300_000);
  assert.equal(projection.refunded.operations, 1);
  assert.equal(projection.refunded.fullyRefundedJobs, 0);
  assert.equal(projection.refunded.netZeroRows, 0);

  // 净额仍归属原渠道（净消耗挂在扣费行的日／渠道上，不因退款漂移）
  assert.equal(projection.byChannel.length, 1);
  assert.equal(projection.byChannel[0].key, "sub2api");
  assert.equal(projection.byChannel[0].quota, 700_000);
  assert.equal(projection.unattributed.quota, 0);

  // 三个切面 + 未归因与净额闭合
  assert.equal(projection.byDay.reduce((sum, bucket) => sum + bucket.quota, 0), projection.totalQuota);
  assert.equal(projection.byModel.reduce((sum, bucket) => sum + bucket.quota, 0), projection.totalQuota);
  assert.equal(
    projection.byChannel.reduce((sum, bucket) => sum + bucket.quota, 0) + projection.unattributed.quota,
    projection.totalQuota,
  );
});

test("C2-1 纯退款无 commit（边界）：净额为负且如实画负，不夹到 0、不冒充 0 消耗", () => {
  const pureRefund: LedgerConsumptionRow[] = [
    {
      operationId: "op-refund-only",
      jobId: "job-refund-only",
      modelId: "pixai-kotone",
      billingUserId: 12,
      channelId: null,
      channelLabel: null,
      amountQuota: 500_000,
      kind: "refund",
      appliedAt: "2026-09-21T04:00:00.000Z",
      day: "2026-09-21",
    },
  ];
  const projection = projectConsumption(pureRefund);

  assert.equal(projection.chargedQuota, 0);
  assert.equal(projection.refundedQuota, 500_000);
  assert.equal(projection.totalQuota, -500_000, "窗口内退款超过扣费时净额为负——如实画负，不夹到 0");
  assert.equal(projection.totalCoins, quotaToCoins(-500_000));
  assert.equal(projection.operations, 1);
  assert.equal(projection.refunded.operations, 1);
  // 该 job 没有成功尝试 → 净额（负数）如实进未归因，而不是被藏起来
  assert.equal(projection.unattributed.quota, -500_000);
  assert.deepEqual(projection.unattributed.recordIds, ["op-refund-only"]);
  assert.equal(projection.byDay.length, 1, "净额非 0 的组要画出来——哪怕是负值，也不许藏");
  assert.equal(projection.byDay[0].quota, -500_000);
  assert.equal(projection.byModel[0].quota, -500_000);
});

test("C2-1 取数面覆盖退款行：净额口径的 SQL 必须同时读 commit 与 refund（源级守门）", () => {
  const code = readCode("src/lib/generation-core/statistics-projection.ts");
  assert.match(code, /operation\.operation IN \('commit', 'refund'\)/, "读法漏 refund = 退款仍算消耗");
  assert.match(code, /operation_kind/, "没有 operation 栏位就无从区分扣费与退款");
  // 未归因桶不得再接退款（全额退款必须离开未归因）：锚点仍只在非零净额组里选
  assert.match(code, /netQuota === 0/);
});

// ── C2-3 低级别：半天桶标注 + 非有限金额跳过 ────────────────────────────────

test("C2-3 首柱半天桶：窗口起点落在当日中时标记 partial，不画成完整一天", () => {
  // 日界固定，窗口起点落在哪一天必须可复算（含跨午夜的时区对齐）
  assert.equal(windowStartDay({ days: 7, now: new Date("2026-09-22T10:00:00.000Z") }), "2026-09-15");
  assert.equal(
    windowStartDay({ days: 7, now: new Date("2026-09-22T17:00:00.000Z") }),
    "2026-09-16",
    "UTC 17:00 已是上海次日 01:00——日界必须按 Asia/Shanghai 算",
  );

  const projection = projectConsumption(LEDGER, { partialFromDay: "2026-09-20" });
  const byDay = new Map(projection.byDay.map((bucket) => [bucket.key, bucket]));
  assert.equal(byDay.get("2026-09-20")!.partial, true, "最旧一天是半天桶，必须标记");
  assert.equal(byDay.get("2026-09-21")!.partial, false, "完整日不得被标成部分");

  const notes = buildUsageNotes({ days: 7, rowCount: LEDGER.length, partialFromDay: "2026-09-20" });
  assert.ok(notes.notes.some((note) => note.includes("半天桶")), "半天桶必须在 notes 里明说");
});

test("C2-3 非有限金额：整行跳过、不当 0 计、不冒充一笔 operation，并记 note", () => {
  const withBadRow: LedgerConsumptionRow[] = [
    ...LEDGER.slice(0, 2),
    {
      operationId: "op-nan",
      jobId: "job-nan",
      modelId: "gpt-image-2",
      billingUserId: 13,
      channelId: "sub2api",
      channelLabel: "Sub2API",
      amountQuota: Number.NaN,
      kind: "commit",
      appliedAt: "2026-09-21T05:00:00.000Z",
      day: "2026-09-21",
    },
    {
      operationId: "op-infinity",
      jobId: "job-infinity",
      modelId: "gpt-image-2",
      billingUserId: 13,
      channelId: null,
      channelLabel: null,
      amountQuota: Number.POSITIVE_INFINITY,
      kind: "refund",
      appliedAt: "2026-09-21T06:00:00.000Z",
      day: "2026-09-21",
    },
  ];
  const projection = projectConsumption(withBadRow);

  assert.equal(projection.skippedNonFiniteRows, 2, "非有限金额的行数必须如实报出");
  assert.equal(projection.operations, 2, "被跳过的行不得冒充一笔 operation");
  assert.equal(projection.totalQuota, 750_000, "被跳过的行不得当 0 计入任何一笔");
  assert.equal(projection.chargedOperations, 2);
  assert.equal(projection.refundedOperations, 0, "Infinity 的退款行也不得被当 0 退款计入");
  assert.equal(projection.refunded.operations, 0);
  const recordIds = [
    ...projection.byDay.flatMap((bucket) => bucket.recordIds),
    ...projection.byModel.flatMap((bucket) => bucket.recordIds),
    ...projection.byChannel.flatMap((bucket) => bucket.recordIds),
    ...projection.unattributed.recordIds,
    ...projection.refunded.recordIds,
  ];
  assert.ok(!recordIds.includes("op-nan"), "无金额的行不得作为可回溯记录被引用");
  assert.ok(!recordIds.includes("op-infinity"));

  const notes = buildUsageNotes({ days: 7, rowCount: withBadRow.length, skippedNonFiniteRows: 2 });
  assert.ok(notes.notes.some((note) => note.includes("金额非有限值")), "跳过的行必须在 notes 里留痕");
});

// ── C2-2 截断必须可见 ──────────────────────────────────────────────────────

test("C2-2 剩余额度截断可见：>MAX_QUOTA_USERS 个付费身份时标 truncated 并给覆盖数", async () => {
  const totalIdentities = MAX_QUOTA_USERS + 1; // 26 个身份
  const allIdentities = Array.from({ length: totalIdentities }, (_, index) => ({
    billing_user_id: String(100 + index),
    total_identities: totalIdentities,
  }));
  // 只读 stub：照 SQL 的 LIMIT 语义切样本，并回 count(*) OVER () 的全量数
  const stub = ((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("DISTINCT job.billing_user_id")) {
      return Promise.resolve(allIdentities.slice(0, MAX_QUOTA_USERS));
    }
    return Promise.resolve([]);
  }) as unknown as GenerationSql;

  const coverage = await readBillingIdentityCoverage({ days: 7, sql: stub });
  assert.equal(coverage.ids.length, MAX_QUOTA_USERS);
  assert.equal(coverage.limit, MAX_QUOTA_USERS);
  assert.equal(coverage.totalIdentities, totalIdentities, "全量身份数来自 count(*) OVER ()，不是样本长度");
  assert.equal(coverage.truncated, true);

  // 投影层：覆盖数如实 + 截断标记 + 合计只是部分身份之和
  const entries: RemainingQuotaEntry[] = coverage.ids.map((billingUserId) => ({
    billingUserId,
    state: "known",
    quota: 100_000,
    coins: quotaToCoins(100_000),
  }));
  const quota = projectRemainingQuota(entries, coverage);
  assert.equal(quota.coverage.truncated, true);
  assert.equal(quota.coverage.coveredCount, MAX_QUOTA_USERS);
  assert.equal(quota.coverage.totalIdentities, totalIdentities);
  assert.equal(quota.knownQuota, MAX_QUOTA_USERS * 100_000, "合计仍是可回读身份之和（覆盖数已申明）");

  const notes = buildUsageNotes({ days: 7, rowCount: 3, quotaCoverage: quota.coverage });
  assert.ok(
    notes.notes.some((note) => note.includes(`只覆盖前 ${MAX_QUOTA_USERS} 个身份`)),
    "截断必须在 notes 里明说覆盖了多少个身份",
  );

  // 展示层：截断标记必须上屏（卡片 + 明细表头两处文案键都在元件里）
  const ui = readCode("src/components/admin/AdminStatistics.tsx");
  assert.match(ui, /stats\.card\.quotaTruncated/);
  assert.match(ui, /stats\.quota\.coverage/);
});

test("C2-2 组装层：身份数超上限时 remainingQuota 标 truncated 且 notes 明说覆盖数（stub SQL）", async () => {
  const totalIdentities = MAX_QUOTA_USERS + 11;
  const allIdentities = Array.from({ length: totalIdentities }, (_, index) => ({
    billing_user_id: String(200 + index),
    total_identities: totalIdentities,
  }));
  const stub = ((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("DISTINCT job.billing_user_id")) return Promise.resolve(allIdentities.slice(0, MAX_QUOTA_USERS));
    if (text.includes("count(DISTINCT capability.id)")) return Promise.resolve([]);
    return Promise.resolve([]);
  }) as unknown as GenerationSql;

  const seen: number[] = [];
  const projection = await buildStatisticsProjection({
    days: 7,
    now: new Date("2026-09-22T10:00:00.000Z"),
    sql: stub,
    loadRemainingQuota: async (userIds) => {
      seen.push(...userIds);
      return userIds.map((billingUserId) => ({
        billingUserId,
        state: "known" as const,
        quota: 100_000,
        coins: quotaToCoins(100_000),
      }));
    },
  });

  assert.equal(seen.length, MAX_QUOTA_USERS, "上游读取必须节流在上限内");
  assert.equal(projection.remainingQuota.coverage.truncated, true);
  assert.equal(projection.remainingQuota.coverage.totalIdentities, totalIdentities);
  assert.equal(projection.remainingQuota.coverage.coveredCount, MAX_QUOTA_USERS);
  assert.ok(
    projection.notes.some(
      (note) => note.includes(`共 ${totalIdentities} 个`) && note.includes(`上限 ${MAX_QUOTA_USERS} 个`),
    ),
    "notes 必须同时给出全量与上限，不能只给一个被截断的和",
  );
  assert.equal(projection.window.windowStartDay, "2026-09-15");
  assert.equal(projection.consumption!.skippedNonFiniteRows, 0);
  assert.equal(projection.consumption!.refunded.operations, 0);
});

// ── 激活漏斗 + 内部流量剔除 ──────────────────────────────────────────────────

const FUNNEL_NOW = new Date("2026-09-27T12:00:00.000Z");

function funnelFixture(): {
  registrations: FunnelRegistration[];
  jobs: FunnelJob[];
  recharges: FunnelRecharge[];
} {
  const registrations: FunnelRegistration[] = [
    { userId: 117, registeredAt: "2026-09-20T00:00:00.000Z" }, // 内部（假设窗口内注册，验证剔除）
    { userId: 201, registeredAt: "2026-09-10T00:00:00.000Z" }, // 生成→成功→D1 回访→现金充值
    { userId: 202, registeredAt: "2026-09-11T00:00:00.000Z" }, // 生成→成功，同日两单（不算回访）
    { userId: 203, registeredAt: "2026-09-12T00:00:00.000Z" }, // 生成但全失败
    { userId: 204, registeredAt: "2026-09-13T00:00:00.000Z" }, // 只注册
    { userId: 205, registeredAt: "2026-09-14T00:00:00.000Z" }, // 成功、未回访但现金充值（不进漏斗付费步）
    { userId: 206, registeredAt: "2026-09-15T00:00:00.000Z" }, // 成功、第 8 天才回来（不算回访）；只有签到入帐
    { userId: 150, registeredAt: "2026-08-01T00:00:00.000Z" }, // 窗口外注册
  ];
  const job = (userId: number, jobId: string, status: string, createdAt: string, finishedAt: string | null): FunnelJob => ({
    userId,
    jobId,
    status,
    createdAt,
    finishedAt,
  });
  const jobs: FunnelJob[] = [
    job(117, "j-117", "succeeded", "2026-09-20T01:00:00.000Z", "2026-09-20T01:02:00.000Z"),
    job(201, "j-201a", "succeeded", "2026-09-10T02:00:00.000Z", "2026-09-10T02:02:00.000Z"),
    job(201, "j-201b", "succeeded", "2026-09-11T02:00:00.000Z", "2026-09-11T02:01:00.000Z"),
    job(202, "j-202a", "failed", "2026-09-11T01:00:00.000Z", "2026-09-11T01:10:00.000Z"),
    job(202, "j-202b", "succeeded", "2026-09-11T03:00:00.000Z", "2026-09-11T03:05:00.000Z"),
    job(203, "j-203", "failed", "2026-09-12T01:00:00.000Z", "2026-09-12T01:20:00.000Z"),
    job(205, "j-205", "succeeded", "2026-09-14T01:00:00.000Z", "2026-09-14T01:03:00.000Z"),
    job(206, "j-206a", "succeeded", "2026-09-15T01:00:00.000Z", "2026-09-15T01:04:00.000Z"),
    job(206, "j-206b", "succeeded", "2026-09-23T01:00:00.000Z", "2026-09-23T01:04:00.000Z"),
    job(150, "j-150", "succeeded", "2026-09-15T01:00:00.000Z", "2026-09-15T01:04:00.000Z"),
  ];
  const recharges: FunnelRecharge[] = [
    { ledgerId: "l-201", userId: 201, source: "redemption-sync", createdAt: "2026-09-12T00:00:00.000Z" },
    { ledgerId: "l-205", userId: 205, source: "redemption-sync", createdAt: "2026-09-15T00:00:00.000Z" },
    { ledgerId: "l-206", userId: 206, source: "checkin", createdAt: "2026-09-16T00:00:00.000Z" },
    { ledgerId: "l-117", userId: 117, source: "redemption-sync", createdAt: "2026-09-21T00:00:00.000Z" },
  ];
  return { registrations, jobs, recharges };
}

test("内部名单：env 未设用预设 117,82；设值按逗号解析；空字串 = 不剔除", () => {
  assert.deepEqual(resolveInternalUserIds(undefined), [...DEFAULT_INTERNAL_USER_IDS]);
  assert.deepEqual(DEFAULT_INTERNAL_USER_IDS, [117, 82]);
  assert.deepEqual(resolveInternalUserIds(" 117, 82 ,253,abc,-1,117"), [82, 117, 253]);
  assert.deepEqual(resolveInternalUserIds(""), []);
});

test("激活漏斗：预设剔除内部用户，切到「含内部」才计入", () => {
  const fixture = funnelFixture();
  const excluded = projectActivationFunnel({
    ...fixture,
    days: 30,
    now: FUNNEL_NOW,
    internalUserIds: [117, 82],
    includeInternal: false,
  });
  assert.equal(excluded.excludedInternalRegistrations, 1);
  for (const step of excluded.steps) assert.ok(!step.userIds.includes(117), `${step.key} 混入内部用户`);
  assert.equal(excluded.steps[0].count, 6);

  const included = projectActivationFunnel({
    ...fixture,
    days: 30,
    now: FUNNEL_NOW,
    internalUserIds: [117, 82],
    includeInternal: true,
  });
  assert.equal(included.excludedInternalRegistrations, 0);
  assert.equal(included.steps[0].count, 7);
  assert.ok(included.steps[2].userIds.includes(117));
});

test("激活漏斗：每一步人数单调不增、且是上一步的子集；逐步人数与夹具手算一致", () => {
  const funnel = projectActivationFunnel({
    ...funnelFixture(),
    days: 30,
    now: FUNNEL_NOW,
    internalUserIds: [117, 82],
    includeInternal: false,
  });
  assert.deepEqual(
    funnel.steps.map((step) => step.key),
    [...FUNNEL_STEP_ORDER],
  );
  for (let index = 1; index < funnel.steps.length; index += 1) {
    const previous = funnel.steps[index - 1];
    const current = funnel.steps[index];
    assert.ok(current.count <= previous.count, `${current.key} > ${previous.key}`);
    for (const id of current.userIds) assert.ok(previous.userIds.includes(id), `${current.key} 的 ${id} 不在 ${previous.key}`);
  }
  assert.deepEqual(
    funnel.steps.map((step) => step.userIds),
    [[201, 202, 203, 204, 205, 206], [201, 202, 203, 205, 206], [201, 202, 205, 206], [201], [201]],
  );
  // 不在漏斗链上的事实单列：205 没回访就付费，206 只有签到入帐（非现金）
  assert.equal(funnel.paidAnyStage, 2);
  assert.equal(funnel.nonCashRechargesSkipped, 1);
  assert.equal(funnel.d1Returned, 1);
  // 转化率：注册 6 → 生成 5
  const generated = funnel.steps[1].fromPrevious;
  assert.ok(generated && generated.state === "ok");
  assert.equal(generated.value, 5 / 6);
  // 分母 < MIN_RATE_SAMPLES 时是「资料不足」而不是 0%
  assert.equal(funnel.steps[4].fromPrevious?.state, "insufficient");
  // 首图耗时：注册→首成功 = 201:2h2m, 202:3h5m, 205:1h3m, 206:1h4m（秒）
  const first = funnel.timeToFirstImage.registerToFirstSuccess;
  assert.equal(first.samples, 4);
  assert.equal(first.p50Seconds, 3840);
  assert.equal(first.p90Seconds, 11100);
  // 首单 created→finished：201:120, 202:600, 203:1200, 205:180, 206:240
  const firstJob = funnel.timeToFirstImage.firstJobCreatedToFinished;
  assert.equal(firstJob.samples, 5);
  assert.equal(firstJob.p50Seconds, 240);
  assert.equal(firstJob.p90Seconds, 1200);
  assert.equal(firstJob.firstJobNotSucceeded, 2);
});

test("D1 回访判定：同日多次不算、次日算 D1、第 7 天算回访、第 8 天不算；日界按 Asia/Shanghai", () => {
  assert.deepEqual(returnedWithin(["2026-09-10", "2026-09-10"]), { returned: false, d1: false, firstDay: "2026-09-10" });
  assert.deepEqual(returnedWithin(["2026-09-10", "2026-09-11"]), { returned: true, d1: true, firstDay: "2026-09-10" });
  assert.deepEqual(returnedWithin(["2026-09-10", "2026-09-17"]), { returned: true, d1: false, firstDay: "2026-09-10" });
  assert.deepEqual(returnedWithin(["2026-09-10", "2026-09-18"]), { returned: false, d1: false, firstDay: "2026-09-10" });
  assert.deepEqual(returnedWithin([]), { returned: false, d1: false, firstDay: null });
  // 跨月
  assert.equal(returnedWithin(["2026-08-31", "2026-09-01"]).d1, true);
  // UTC 同一天、CST 跨日（15:30Z = 23:30 CST，16:30Z = 次日 00:30 CST）→ 是 D1
  const days = ["2026-09-10T15:30:00.000Z", "2026-09-10T16:30:00.000Z"].map((iso) => calendarDayOf(iso));
  assert.deepEqual(days, ["2026-09-10", "2026-09-11"]);
  assert.equal(returnedWithin(days).d1, true);
});

test("现金判定与分位数口径：开户基线/签到/新人礼不算付费；分位数同 percentile_disc", () => {
  assert.equal(isCashRechargeSource("redemption-sync"), true);
  assert.equal(isCashRechargeSource("subscription-redemption"), true);
  for (const source of ["seed", "checkin", "daily-checkin", "welcome-grant", "gift", "newbie-bonus"]) {
    assert.equal(isCashRechargeSource(source), false, source);
  }
  assert.equal(nearestRankPercentile([], 0.5), null);
  assert.equal(nearestRankPercentile([5], 0.9), 5);
  assert.equal(nearestRankPercentile([4, 1, 3, 2], 0.5), 2);
  assert.equal(nearestRankPercentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
});

test("组装层：内部名单以绑定参数传进帐本与漏斗查询，漏斗从 stub 事实算出（无写库）", async () => {
  const seen: { text: string; values: unknown[] }[] = [];
  const fixture = funnelFixture();
  const stub = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    seen.push({ text, values });
    if (text.includes("scoped.owner_user_id")) {
      return Promise.resolve(
        fixture.jobs.map((job) => ({
          owner_user_id: String(job.userId),
          job_id: job.jobId,
          status: job.status,
          created_at: job.createdAt,
          finished_at: job.finishedAt,
        })),
      );
    }
    if (text.includes("FROM account_ledger ledger")) {
      return Promise.resolve(
        fixture.recharges.map((row) => ({
          ledger_id: row.ledgerId,
          ledger_user_id: row.userId,
          ledger_source: row.source,
          ledger_created_at: row.createdAt,
        })),
      );
    }
    return Promise.resolve([]);
  }) as unknown as GenerationSql;

  const projection = await buildStatisticsProjection({
    days: 7,
    funnelDays: 30,
    sql: stub,
    now: FUNNEL_NOW,
    internalUserIds: [82, 117],
    loadRegistrations: async () => ({ registrations: fixture.registrations, truncated: false }),
    loadRemainingQuota: async () => [],
  });

  assert.deepEqual(projection.traffic, { includeInternal: false, internalUserIds: [82, 117] });
  const ledgerQuery = seen.find((entry) => entry.text.includes("FROM billing_operation operation") && entry.text.includes("operation_kind"));
  assert.ok(ledgerQuery?.values.includes("{82,117}"), "帐本查询未带内部名单");
  const jobQuery = seen.find((entry) => entry.text.includes("scoped.owner_user_id"));
  assert.ok(jobQuery && !String(jobQuery.values.find((value) => typeof value === "string" && value.startsWith("{"))).includes("117"));
  assert.equal(projection.activationFunnel.state, "ok");
  if (projection.activationFunnel.state === "ok") {
    assert.deepEqual(
      projection.activationFunnel.steps.map((step) => step.count),
      [6, 5, 4, 1, 1],
    );
  }
  assert.ok(projection.notes.some((note) => note.includes("INTERNAL_USER_IDS")));

  const withInternal = await buildStatisticsProjection({
    days: 7,
    sql: stub,
    now: FUNNEL_NOW,
    internalUserIds: [82, 117],
    includeInternal: true,
    loadRegistrations: async () => ({ registrations: fixture.registrations, truncated: false }),
    loadRemainingQuota: async () => [],
  });
  const lastLedger = [...seen].reverse().find((entry) => entry.text.includes("operation_kind"));
  assert.ok(lastLedger?.values.includes("{}"), "含内部时不应剔除任何人");
  assert.equal(withInternal.activationFunnel.state === "ok" && withInternal.activationFunnel.steps[0].count, 7);
});

test("漏斗读不到注册时整卡 unavailable 并说原因，不画半截漏斗", async () => {
  const stub = (() => Promise.resolve([])) as unknown as GenerationSql;
  const projection = await buildStatisticsProjection({
    days: 7,
    sql: stub,
    now: FUNNEL_NOW,
    loadRegistrations: async () => {
      throw new Error("上游管理凭证未配置");
    },
    loadRemainingQuota: async () => [],
  });
  assert.equal(projection.activationFunnel.state, "unavailable");
  if (projection.activationFunnel.state === "unavailable") {
    assert.match(projection.activationFunnel.reason, /凭证未配置/);
  }
});

test("首单取数保留毫秒：同一秒内建立的多单按真实先后取首单（postgres.js 回 Date 物件）", async () => {
  const stub = ((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("scoped.owner_user_id")) {
      return Promise.resolve([
        {
          owner_user_id: "246",
          job_id: "z-first",
          status: "succeeded",
          created_at: new Date("2026-09-24T02:11:56.147Z"),
          finished_at: new Date("2026-09-24T02:14:51.181Z"),
        },
        {
          owner_user_id: "246",
          job_id: "a-second",
          status: "succeeded",
          created_at: new Date("2026-09-24T02:11:56.333Z"),
          finished_at: new Date("2026-09-24T02:13:48.477Z"),
        },
      ]);
    }
    return Promise.resolve([]);
  }) as unknown as GenerationSql;
  const projection = await buildStatisticsProjection({
    days: 7,
    funnelDays: 7,
    sql: stub,
    now: FUNNEL_NOW,
    internalUserIds: [],
    loadRegistrations: async () => ({
      registrations: [{ userId: 246, registeredAt: "2026-09-21T04:14:48.000Z" }],
      truncated: false,
    }),
    loadRemainingQuota: async () => [],
  });
  assert.equal(projection.activationFunnel.state, "ok");
  if (projection.activationFunnel.state === "ok") {
    const firstJob = projection.activationFunnel.timeToFirstImage.firstJobCreatedToFinished;
    assert.equal(firstJob.p50Seconds, 175.034);
  }
});
