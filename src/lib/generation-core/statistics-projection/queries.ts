import { readSupplierChannelHealth } from "@/lib/supplier-health-signal";
import { usageAssetKindForJobKind } from "../usage-asset-kind";
import { readFunnelAttribution } from "@/lib/user-attribution";
import { generationDatabaseConfigured, getGenerationSql, type GenerationSql } from "../database";
import { buildUsageNotes, projectConsumption, windowStartDay } from "./project-consumption";
import { projectChannelHealth, projectRemainingQuota } from "./project-revenue";
import { projectActivationFunnel } from "./project-activation";
import { DEFAULT_FUNNEL_DAYS, DEFAULT_INTERNAL_USER_IDS, DEFAULT_WINDOW_DAYS, FUNNEL_JOB_ROW_LIMIT, FUNNEL_WINDOW_OPTIONS, LEDGER_ROW_LIMIT, MAX_QUOTA_USERS, MAX_WINDOW_DAYS, STATISTICS_DAY_TIMEZONE, STATISTICS_SOURCES, quotaToCoins, type ActivationFunnelResult, type BillingIdentityCoverage, type ChannelHealthEntry, type FunnelJob, type FunnelRecharge, type FunnelRegistration, type LedgerConsumptionRow, type RegistrationLoader, type RemainingQuotaEntry, type StatisticsProjection } from "./types";

// ── 查询层（只读） ──────────────────────────────────────────────────────────

function mapConsumptionRow(row: Record<string, unknown>): LedgerConsumptionRow {
  return {
    operationId: String(row.operation_id),
    jobId: String(row.job_id),
    modelId: String(row.model_id ?? "未知"),
    billingUserId: row.billing_user_id === null || row.billing_user_id === undefined ? null : Number(row.billing_user_id),
    channelId: row.channel_id === null || row.channel_id === undefined ? null : String(row.channel_id),
    channelLabel: row.channel_label === null || row.channel_label === undefined ? null : String(row.channel_label),
    amountQuota: Number(row.amount ?? 0),
    // 只有明确的 refund 才是负向；其余（含旧查询缺栏位的情况）按扣费处理。
    kind: String(row.operation_kind) === "refund" ? "refund" : "commit",
    appliedAt: new Date(String(row.applied_at)).toISOString(),
    day: String(row.day),
    // 生成物类别（P2-2／D8b）：唯一的落盘事实是 `generation_job.kind`——
    // 影片 ⇒ 分镜影片，图片 ⇒ 一般静态图，其余 unclassified。判准集中在
    // usage-asset-kind.ts（本档不自己再写一份映射，避免两处漂移）。
    jobKind: row.job_kind === null || row.job_kind === undefined ? null : String(row.job_kind),
    assetKind: usageAssetKindForJobKind(row.job_kind),
  };
}

/**
 * 窗口内的帐本行（只读 SELECT）：commit（扣费）与 refund（退款）都在内——
 * 只取 commit 就是把已退的钱算成消耗（C2-1）。写入类 operation（writeoff 平台损失、
 * release 解除预留、reserve 预留）不是用户消耗，刻意排除。
 */
export async function readLedgerConsumption(
  input: { days: number; sql?: GenerationSql; excludeUserIds?: number[] } = { days: DEFAULT_WINDOW_DAYS },
): Promise<LedgerConsumptionRow[]> {
  const sql = input.sql ?? getGenerationSql();
  const days = Math.max(1, Math.min(Math.floor(input.days), MAX_WINDOW_DAYS));
  const excluded = userIdArrayLiteral(input.excludeUserIds ?? []);
  const rows = await sql<Record<string, unknown>[]>`
    SELECT operation.id AS operation_id,
           operation.job_id AS job_id,
           operation.operation AS operation_kind,
           job.model_id AS model_id,
           job.kind AS job_kind,
           job.billing_user_id AS billing_user_id,
           operation.amount AS amount,
           operation.applied_at AS applied_at,
           to_char(operation.applied_at AT TIME ZONE ${STATISTICS_DAY_TIMEZONE}, 'YYYY-MM-DD') AS day,
           attempt.supplier_id AS channel_id,
           supplier.label AS channel_label
    FROM billing_operation operation
    JOIN generation_job job ON job.id = operation.job_id
    LEFT JOIN LATERAL (
      SELECT candidate.supplier_id
      FROM generation_attempt candidate
      WHERE candidate.job_id = operation.job_id AND candidate.status = 'succeeded'
      ORDER BY candidate.attempt_no DESC
      LIMIT 1
    ) attempt ON true
    LEFT JOIN supplier ON supplier.id = attempt.supplier_id
    LEFT JOIN biz_api_key owner_key ON job.tenant_id = 'biz:' || owner_key.id
    WHERE operation.operation IN ('commit', 'refund')
      AND operation.status = 'applied'
      AND operation.applied_at IS NOT NULL
      AND operation.applied_at >= now() - (${String(days)}::text || ' days')::interval
      AND COALESCE(
        COALESCE(
          CASE WHEN job.tenant_id ~ '^web:[0-9]+$' THEN split_part(job.tenant_id, ':', 2)::bigint END,
          owner_key.user_id::bigint,
          job.billing_user_id
        ) = ANY(${excluded}::bigint[]),
        false
      ) = false
    ORDER BY operation.applied_at DESC
    LIMIT ${LEDGER_ROW_LIMIT}
  `;
  return rows.map(mapConsumptionRow);
}

/**
 * 窗口内有帐本行（commit/refund applied）的付费身份（billing_user_id），供剩余额度读取。
 *
 * 截断必须可见：用 `count(*) OVER ()` 一次拿到全量身份数，超过上限时 truncated=true——
 * 以前只回一组被 LIMIT 砍过的 id，展示层无从知道「合计只是前 25 个之和」。
 */
export async function readBillingIdentityCoverage(
  input: { days: number; sql?: GenerationSql; excludeUserIds?: number[] } = { days: DEFAULT_WINDOW_DAYS },
): Promise<BillingIdentityCoverage> {
  const sql = input.sql ?? getGenerationSql();
  const days = Math.max(1, Math.min(Math.floor(input.days), MAX_WINDOW_DAYS));
  const excluded = userIdArrayLiteral(input.excludeUserIds ?? []);
  const rows = await sql<{ billing_user_id: string | number; total_identities: string | number }[]>`
    SELECT identity.billing_user_id AS billing_user_id,
           count(*) OVER () AS total_identities
    FROM (
      SELECT DISTINCT job.billing_user_id AS billing_user_id
      FROM billing_operation operation
      JOIN generation_job job ON job.id = operation.job_id
      LEFT JOIN biz_api_key owner_key ON job.tenant_id = 'biz:' || owner_key.id
      WHERE operation.operation IN ('commit', 'refund')
        AND operation.status = 'applied'
        AND operation.applied_at IS NOT NULL
        AND operation.applied_at >= now() - (${String(days)}::text || ' days')::interval
        AND job.billing_user_id IS NOT NULL
        AND COALESCE(
          COALESCE(
            CASE WHEN job.tenant_id ~ '^web:[0-9]+$' THEN split_part(job.tenant_id, ':', 2)::bigint END,
            owner_key.user_id::bigint,
            job.billing_user_id
          ) = ANY(${excluded}::bigint[]),
          false
        ) = false
    ) identity
    ORDER BY identity.billing_user_id
    LIMIT ${MAX_QUOTA_USERS}
  `;
  const ids = rows.map((row) => Number(row.billing_user_id)).filter((id) => Number.isFinite(id));
  const counted = rows.length > 0 ? Number(rows[0].total_identities) : 0;
  const totalIdentities = Number.isFinite(counted) && counted >= ids.length ? counted : ids.length;
  return { ids, limit: MAX_QUOTA_USERS, totalIdentities, truncated: totalIdentities > ids.length };
}

/** 渠道判活（只读），走 supplier-health-signal 的同一把尺。 */
export async function readChannelHealth(sql?: GenerationSql): Promise<ChannelHealthEntry[]> {
  return projectChannelHealth(await readSupplierChannelHealth(sql));
}

/**
 * 统计页的唯一组装入口（只读）。控制面 DB 未配置时如实回 configured:false，
 * 不吐一个看起来正常的空报表（空报表比报错更会骗人）。
 */
export async function buildStatisticsProjection(input: {
  days?: number;
  sql?: GenerationSql;
  loadRemainingQuota?: (userIds: number[]) => Promise<RemainingQuotaEntry[]>;
  /** 注入时钟供测试（半天桶标记依赖「窗口起点落在哪一天」）。 */
  now?: Date;
  /** 是否计入内部流量（预设不计）。 */
  includeInternal?: boolean;
  /** 内部用户名单（预设读 env INTERNAL_USER_IDS）。 */
  internalUserIds?: number[];
  /** 激活漏斗时间窗（7 / 30，预设 30）。 */
  funnelDays?: number;
  loadRegistrations?: RegistrationLoader;
} = {}): Promise<StatisticsProjection> {
  const days = Math.max(1, Math.min(Math.floor(input.days ?? DEFAULT_WINDOW_DAYS), MAX_WINDOW_DAYS));
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const partialFromDay = windowStartDay({ days, now });
  const includeInternal = input.includeInternal === true;
  const internalUserIds = input.internalUserIds ?? resolveInternalUserIds();
  const traffic = { includeInternal, internalUserIds };
  const excludeUserIds = includeInternal ? [] : internalUserIds;
  const funnelDays = input.funnelDays ?? DEFAULT_FUNNEL_DAYS;
  if (!input.sql && !generationDatabaseConfigured()) {
    return {
      window: { days, generatedAt, dayTimezone: STATISTICS_DAY_TIMEZONE, partial: false, windowStartDay: partialFromDay },
      configured: false,
      consumption: null,
      channelHealth: [],
      remainingQuota: projectRemainingQuota([]),
      traffic,
      activationFunnel: { state: "unavailable", days: funnelDays, reason: "控制面资料库未配置" },
      sources: STATISTICS_SOURCES,
      notes: ["本实例没有控制面资料库连线（GENERATION_DATABASE_URL），统计不可用。"],
    };
  }

  const sql = input.sql ?? getGenerationSql();
  const [rows, channelHealth, identityCoverage, activationFunnel] = await Promise.all([
    readLedgerConsumption({ days, sql, excludeUserIds }),
    readChannelHealth(sql).catch((error) => {
      console.error("[statistics] channel health read failed (回空清单，不猜健康)", error);
      return [] as ChannelHealthEntry[];
    }),
    readBillingIdentityCoverage({ days, sql, excludeUserIds }).catch((error) => {
      console.error("[statistics] billing identity list failed", error);
      return { ids: [], limit: MAX_QUOTA_USERS, totalIdentities: 0, truncated: false } as BillingIdentityCoverage;
    }),
    buildActivationFunnel({
      days: funnelDays,
      now,
      sql,
      internalUserIds,
      includeInternal,
      loadRegistrations: input.loadRegistrations,
    }),
  ]);

  const loadRemainingQuota = input.loadRemainingQuota ?? defaultLoadRemainingQuota;
  const remainingQuota = projectRemainingQuota(await loadRemainingQuota(identityCoverage.ids), identityCoverage);

  const usageNotes = buildUsageNotes({
    days,
    rowCount: rows.length,
    generatedAt,
    // 边界一律申报：跳过的非有限值行、退款相减、半天桶、身份截断。
    skippedNonFiniteRows: rows.filter((row) => !Number.isFinite(row.amountQuota)).length,
    refundedOperations: rows.filter((row) => row.kind === "refund" && Number.isFinite(row.amountQuota)).length,
    refundedQuota: rows
      .filter((row) => row.kind === "refund" && Number.isFinite(row.amountQuota))
      .reduce((sum, row) => sum + row.amountQuota, 0),
    partialFromDay,
    quotaCoverage: remainingQuota.coverage,
  });
  if (!includeInternal && internalUserIds.length > 0) {
    usageNotes.notes.push(
      `已剔除内部流量（用户 ${internalUserIds.join(", ")}，env INTERNAL_USER_IDS）：消耗、剩余额度、激活漏斗均不含其任务；渠道判活计数器是供应商级累计值，无法按用户拆分，不受此开关影响。`,
    );
  }
  return {
    window: {
      days,
      generatedAt: usageNotes.generatedAt,
      dayTimezone: STATISTICS_DAY_TIMEZONE,
      partial: usageNotes.partial,
      windowStartDay: partialFromDay,
    },
    configured: true,
    consumption: projectConsumption(rows, { partialFromDay }),
    channelHealth,
    remainingQuota,
    traffic,
    activationFunnel,
    sources: STATISTICS_SOURCES,
    notes: usageNotes.notes,
  };
}

/**
 * 剩余额度预设读法：new-api users.quota（与 quota-precheck 同通路、同真源）。
 * 读不到就是 unknown——凭证未配置、上游 5xx、帐号被删都如实标因，不以 0 充数。
 * 上限只在这里节流（每个身份一次上游 GET）；截断事实由 readBillingIdentityCoverage 的
 * totalIdentities/truncated 对外申报，不在这里静默吞掉。
 */
async function defaultLoadRemainingQuota(userIds: number[]): Promise<RemainingQuotaEntry[]> {
  if (userIds.length === 0) return [];
  const targets = userIds.slice(0, MAX_QUOTA_USERS);
  if (targets.length < userIds.length) {
    console.warn(
      `[statistics] remaining quota read capped at ${MAX_QUOTA_USERS} identities (given ${userIds.length}); 覆盖数已随 truncated 申报`,
    );
  }
  const { fetchGatewayUser } = await import("@/lib/gateway-admin");
  return Promise.all(
    targets.map(async (billingUserId): Promise<RemainingQuotaEntry> => {
      try {
        const user = await fetchGatewayUser(billingUserId);
        if (!user || !Number.isFinite(user.quota)) {
          return { billingUserId, state: "unknown", quota: null, coins: null, reason: "new-api 未回该用户额度" };
        }
        return {
          billingUserId,
          state: "known",
          quota: user.quota,
          coins: quotaToCoins(user.quota),
        };
      } catch (error) {
        return {
          billingUserId,
          state: "unknown",
          quota: null,
          coins: null,
          reason: error instanceof Error ? error.message : "new-api 读取失败",
        };
      }
    }),
  );
}

// ── 内部流量剔除 ─────────────────────────────────────────────────────────────
// 站长自测（117）与测试 key（82）占近 30 天绝大多数生成——混进统计就是「看起来有量」的假象。
// 内部名单唯一来源：env INTERNAL_USER_IDS（逗号分隔 new-api 用户 id）；未设置用预设名单，
// 明确设为空字串 = 没有内部用户（不剔除）。「用户」一律指任务拥有者：web:<uid> 直接取 uid，
// biz:<keyid> 取 biz_api_key.user_id（站长的 key 有记到别的计费身份上，只看 billing_user_id 会漏剔）。

export function resolveInternalUserIds(raw: string | undefined = process.env.INTERNAL_USER_IDS): number[] {
  if (raw === undefined) return [...DEFAULT_INTERNAL_USER_IDS];
  const ids = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => isPositiveUserId(id));
  return [...new Set(ids)].sort((a, b) => a - b);
}

function isPositiveUserId(id: number): boolean {
  return Number.isInteger(id) && id > 0;
}

/**
 * DB 时间 → ISO。postgres.js 回的是 Date：`String(date)` 会丢掉毫秒，同秒内建立的批次任务
 * 因此排不出先后（首单会被 id 字典序决定）——必须直接取 Date 的毫秒值。
 */
function dbTimeToIso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

/** 整数 id → postgres 阵列字面量（只收正整数，作为绑定参数传入，不拼 SQL）。 */
function userIdArrayLiteral(ids: readonly number[]): string {
  return `{${ids.filter(isPositiveUserId).join(",")}}`;
}

/**
 * 漏斗的任务事实（只读）：拥有者 = web:<uid> 的 uid，或 biz key 的 user_id。
 * 只读给定用户、给定起点之后的任务。
 */
export async function readFunnelJobs(input: {
  userIds: number[];
  since: Date;
  sql?: GenerationSql;
}): Promise<{ jobs: FunnelJob[]; truncated: boolean }> {
  if (input.userIds.length === 0) return { jobs: [], truncated: false };
  const sql = input.sql ?? getGenerationSql();
  const ids = userIdArrayLiteral(input.userIds);
  const rows = await sql<Record<string, unknown>[]>`
    SELECT scoped.owner_user_id AS owner_user_id,
           scoped.job_id AS job_id,
           scoped.status AS status,
           scoped.created_at AS created_at,
           scoped.finished_at AS finished_at
    FROM (
      SELECT COALESCE(
               CASE WHEN job.tenant_id ~ '^web:[0-9]+$' THEN split_part(job.tenant_id, ':', 2)::bigint END,
               owner_key.user_id::bigint
             ) AS owner_user_id,
             job.id AS job_id,
             job.status AS status,
             job.created_at AS created_at,
             job.finished_at AS finished_at
      FROM generation_job job
      LEFT JOIN biz_api_key owner_key ON job.tenant_id = 'biz:' || owner_key.id
      WHERE job.created_at >= ${input.since.toISOString()}::timestamptz
    ) scoped
    WHERE scoped.owner_user_id = ANY(${ids}::bigint[])
    ORDER BY scoped.created_at
    LIMIT ${FUNNEL_JOB_ROW_LIMIT}
  `;
  return {
    jobs: rows.map((row) => ({
      userId: Number(row.owner_user_id),
      jobId: String(row.job_id),
      status: String(row.status),
      createdAt: dbTimeToIso(row.created_at),
      finishedAt: row.finished_at ? dbTimeToIso(row.finished_at) : null,
    })),
    truncated: rows.length >= FUNNEL_JOB_ROW_LIMIT,
  };
}

/** 漏斗的充值事实（只读）：account_ledger entry_type='recharge'，现金判定在投影层做。 */
export async function readFunnelRecharges(input: {
  userIds: number[];
  since: Date;
  sql?: GenerationSql;
}): Promise<FunnelRecharge[]> {
  if (input.userIds.length === 0) return [];
  const sql = input.sql ?? getGenerationSql();
  const ids = userIdArrayLiteral(input.userIds);
  const rows = await sql<Record<string, unknown>[]>`
    SELECT ledger.id AS ledger_id,
           ledger.billing_user_id AS ledger_user_id,
           ledger.source AS ledger_source,
           ledger.created_at AS ledger_created_at
    FROM account_ledger ledger
    WHERE ledger.entry_type = 'recharge'
      AND ledger.amount > 0
      AND ledger.billing_user_id = ANY(${ids}::bigint[])
      AND ledger.created_at >= ${input.since.toISOString()}::timestamptz
  `;
  return rows.map((row) => ({
    ledgerId: String(row.ledger_id),
    userId: Number(row.ledger_user_id),
    source: String(row.ledger_source ?? ""),
    createdAt: dbTimeToIso(row.ledger_created_at),
  }));
}

/** 注册预设读法：new-api 管理 API（不直连 sqlite）。 */
async function defaultLoadRegistrations(since: Date): Promise<{ registrations: FunnelRegistration[]; truncated: boolean }> {
  const { listGatewayUsersRegisteredSince } = await import("@/lib/gateway-admin");
  const { users, truncated } = await listGatewayUsersRegisteredSince(Math.floor(since.getTime() / 1000));
  return {
    registrations: users.map((user) => ({
      userId: user.id,
      registeredAt: new Date(user.created_at * 1000).toISOString(),
    })),
    truncated,
  };
}

/** 漏斗组装：任何一段读不到就整卡 unavailable 并说原因——不画半截漏斗。 */
export async function buildActivationFunnel(input: {
  days: number;
  now: Date;
  sql: GenerationSql;
  internalUserIds: number[];
  includeInternal: boolean;
  loadRegistrations?: RegistrationLoader;
}): Promise<ActivationFunnelResult> {
  const days = (FUNNEL_WINDOW_OPTIONS as readonly number[]).includes(input.days) ? input.days : DEFAULT_FUNNEL_DAYS;
  const since = new Date(input.now.getTime() - days * 86_400_000);
  try {
    const loaded = await (input.loadRegistrations ?? defaultLoadRegistrations)(since);
    const internal = new Set(input.internalUserIds);
    const cohortIds = loaded.registrations
      .map((registration) => registration.userId)
      .filter((id) => input.includeInternal || !internal.has(id));
    const [jobResult, recharges, attribution] = await Promise.all([
      readFunnelJobs({ userIds: cohortIds, since, sql: input.sql }),
      readFunnelRecharges({ userIds: cohortIds, since, sql: input.sql }),
      readFunnelAttribution({ userIds: cohortIds, sql: input.sql }),
    ]);
    return projectActivationFunnel({
      days,
      now: input.now,
      registrations: loaded.registrations,
      jobs: jobResult.jobs,
      recharges,
      internalUserIds: input.internalUserIds,
      includeInternal: input.includeInternal,
      truncated: loaded.truncated || jobResult.truncated,
      attribution: attribution.rows,
      sourceBreakdownUnavailable: !attribution.ok,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[statistics] activation funnel unavailable", reason);
    return { state: "unavailable", days, reason };
  }
}
