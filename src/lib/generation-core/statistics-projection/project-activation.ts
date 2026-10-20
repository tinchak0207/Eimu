import { UNATTRIBUTED_SOURCE } from "@/lib/first-touch-attribution";
import { FUNNEL_STEP_ORDER, NON_CASH_RECHARGE_SOURCE, RETURN_WINDOW_DAYS, STATISTICS_DAY_TIMEZONE, sampleRate, type ActivationFunnelProjection, type DurationSummary, type FunnelAttribution, type FunnelJob, type FunnelRecharge, type FunnelRegistration, type FunnelSourceRow, type FunnelStep, type FunnelStepKey } from "./types";

// ── 激活漏斗 ────────────────────────────────────────────────────────────────
// 注册（new-api users.created_at）→ 发起过生成 → 至少一单成功 → 7 日内回访 → 现金充值。
// 每一步都是上一步的子集（严格漏斗，人数单调不增）；不在漏斗链上的事实（没回访就付费的人、
// D1 回访数）单列，不塞进漏斗改变语义。

export function isCashRechargeSource(source: string): boolean {
  return !NON_CASH_RECHARGE_SOURCE.test(source);
}

/** 一个来源桶：分组键 + 该来源在各步骤的人数。 */
export function buildFunnelSourceRows(input: {
  registered: readonly number[];
  generated: readonly number[];
  succeeded: readonly number[];
  paid: readonly number[];
  attribution?: readonly FunnelAttribution[];
}): FunnelSourceRow[] {
  const sourceOf = new Map<number, string>();
  for (const row of input.attribution ?? []) {
    const source = typeof row.source === "string" && row.source.trim() ? row.source.trim() : UNATTRIBUTED_SOURCE;
    sourceOf.set(row.userId, source);
  }
  const sourceFor = (userId: number) => sourceOf.get(userId) ?? UNATTRIBUTED_SOURCE;

  const buckets = new Map<string, FunnelSourceRow>();
  const bucketFor = (source: string): FunnelSourceRow => {
    const existing = buckets.get(source);
    if (existing) return existing;
    const created: FunnelSourceRow = { source, registered: 0, generated: 0, succeeded: 0, paid: 0 };
    buckets.set(source, created);
    return created;
  };

  // 只以 registered 开桶（后续步骤都是 registered 的子集 ⇒ 每一格必定落在既有桶里，
  // 加总恒等于总数；不在 cohort 内的归因列不会凭空造出一个来源）。
  for (const userId of input.registered) bucketFor(sourceFor(userId)).registered += 1;
  for (const userId of input.generated) bucketFor(sourceFor(userId)).generated += 1;
  for (const userId of input.succeeded) bucketFor(sourceFor(userId)).succeeded += 1;
  for (const userId of input.paid) bucketFor(sourceFor(userId)).paid += 1;

  return [...buckets.values()].sort(
    (a, b) => b.registered - a.registered || a.source.localeCompare(b.source),
  );
}

/** 按业务日界切自然日（YYYY-MM-DD）。 */
export function calendarDayOf(iso: string, timeZone: string = STATISTICS_DAY_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

/**
 * 回访判定（D1 / 7 日内）：以首次生成的自然日为 D0，D0+1..D0+withinDays 任一天有生成即回访。
 * 同一天生成多次不算回访；超过窗口才再来也不算。
 */
export function returnedWithin(
  jobDays: readonly string[],
  withinDays: number = RETURN_WINDOW_DAYS,
): { returned: boolean; d1: boolean; firstDay: string | null } {
  if (jobDays.length === 0) return { returned: false, d1: false, firstDay: null };
  const numbers = [...new Set(jobDays.map(dayNumber))].sort((a, b) => a - b);
  const first = numbers[0];
  const firstDay = [...jobDays].sort()[0];
  const offsets = numbers.slice(1).map((value) => value - first);
  return {
    returned: offsets.some((offset) => offset >= 1 && offset <= withinDays),
    d1: offsets.includes(1),
    firstDay,
  };
}

/** 最近秩分位数（与 postgres percentile_disc 同口径）：排序后取第 ceil(p·n) 个。 */
export function nearestRankPercentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

function summarizeDurations(values: number[]): DurationSummary {
  return {
    samples: values.length,
    p50Seconds: nearestRankPercentile(values, 0.5),
    p90Seconds: nearestRankPercentile(values, 0.9),
  };
}

/**
 * 激活漏斗的纯投影。输入是三份原始事实（注册、任务、充值帐本行），
 * 内部剔除、时间窗、回访判定、现金判定都在这里一次做完——SQL 对照即对照这里的口径。
 */
export function projectActivationFunnel(input: {
  days: number;
  now: Date;
  registrations: FunnelRegistration[];
  jobs: FunnelJob[];
  recharges: FunnelRecharge[];
  internalUserIds: readonly number[];
  includeInternal: boolean;
  truncated?: boolean;
  dayTimezone?: string;
  /** 首次触达归因（可缺；缺＝全部归入未标记桶，加总仍等于总数）。 */
  attribution?: readonly FunnelAttribution[];
  /** 归因读取失败旗标（由组装层传入，投影本身不做 I/O 判断）。 */
  sourceBreakdownUnavailable?: boolean;
}): ActivationFunnelProjection {
  const timeZone = input.dayTimezone ?? STATISTICS_DAY_TIMEZONE;
  const windowStartMs = input.now.getTime() - input.days * 86_400_000;
  const internal = new Set(input.internalUserIds);

  const inWindow = input.registrations.filter((registration) => {
    const at = Date.parse(registration.registeredAt);
    return Number.isFinite(at) && at >= windowStartMs && at <= input.now.getTime();
  });
  const cohort = new Map<number, number>();
  let excludedInternalRegistrations = 0;
  for (const registration of inWindow) {
    if (!input.includeInternal && internal.has(registration.userId)) {
      excludedInternalRegistrations += 1;
      continue;
    }
    cohort.set(registration.userId, Date.parse(registration.registeredAt));
  }

  // 每个用户的任务（只计注册之后的——注册前不可能有自己的任务，防脏资料）。
  const jobsByUser = new Map<number, FunnelJob[]>();
  for (const job of input.jobs) {
    const registeredAt = cohort.get(job.userId);
    if (registeredAt === undefined) continue;
    const createdAt = Date.parse(job.createdAt);
    if (!Number.isFinite(createdAt) || createdAt < registeredAt) continue;
    const list = jobsByUser.get(job.userId) ?? [];
    list.push(job);
    jobsByUser.set(job.userId, list);
  }

  const cashPaid = new Set<number>();
  let nonCashRechargesSkipped = 0;
  for (const recharge of input.recharges) {
    const registeredAt = cohort.get(recharge.userId);
    if (registeredAt === undefined) continue;
    if (!isCashRechargeSource(recharge.source)) {
      nonCashRechargesSkipped += 1;
      continue;
    }
    const at = Date.parse(recharge.createdAt);
    if (Number.isFinite(at) && at >= registeredAt) cashPaid.add(recharge.userId);
  }

  const todayNumber = dayNumber(calendarDayOf(input.now.toISOString(), timeZone));
  const registered = [...cohort.keys()].sort((a, b) => a - b);
  const generated: number[] = [];
  const succeeded: number[] = [];
  const returned: number[] = [];
  const paid: number[] = [];
  let d1Returned = 0;
  let returnWindowImmature = 0;
  const registerToFirstSuccess: number[] = [];
  const firstJobDurations: number[] = [];
  let firstJobUnfinished = 0;
  let firstJobNotSucceeded = 0;

  for (const userId of registered) {
    const jobs = (jobsByUser.get(userId) ?? []).sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.jobId.localeCompare(b.jobId),
    );
    if (jobs.length === 0) continue;
    generated.push(userId);

    const firstJob = jobs[0];
    if (firstJob.status !== "succeeded") firstJobNotSucceeded += 1;
    if (firstJob.finishedAt) {
      firstJobDurations.push((Date.parse(firstJob.finishedAt) - Date.parse(firstJob.createdAt)) / 1000);
    } else {
      firstJobUnfinished += 1;
    }

    const successes = jobs.filter((job) => job.status === "succeeded" && job.finishedAt);
    if (successes.length === 0) continue;
    succeeded.push(userId);
    const firstSuccessFinished = Math.min(...successes.map((job) => Date.parse(job.finishedAt as string)));
    registerToFirstSuccess.push((firstSuccessFinished - (cohort.get(userId) as number)) / 1000);

    const days = jobs.map((job) => calendarDayOf(job.createdAt, timeZone));
    const verdict = returnedWithin(days);
    if (verdict.d1) d1Returned += 1;
    if (verdict.firstDay && dayNumber(verdict.firstDay) + RETURN_WINDOW_DAYS > todayNumber) returnWindowImmature += 1;
    if (!verdict.returned) continue;
    returned.push(userId);

    if (cashPaid.has(userId)) paid.push(userId);
  }

  const counts: Record<FunnelStepKey, number[]> = { registered, generated, succeeded, returned, paid };
  const steps: FunnelStep[] = FUNNEL_STEP_ORDER.map((key, index) => {
    const ids = counts[key];
    const previous = index === 0 ? null : counts[FUNNEL_STEP_ORDER[index - 1]];
    return {
      key,
      count: ids.length,
      userIds: ids,
      fromPrevious: previous === null ? null : sampleRate(ids.length, previous.length),
      fromRegistered: index === 0 ? null : sampleRate(ids.length, registered.length),
    };
  });

  return {
    state: "ok",
    days: input.days,
    windowStart: new Date(windowStartMs).toISOString(),
    includeInternal: input.includeInternal,
    internalUserIds: [...input.internalUserIds],
    excludedInternalRegistrations,
    steps,
    d1Returned,
    returnWindowImmature,
    paidAnyStage: cashPaid.size,
    nonCashRechargesSkipped,
    sources: buildFunnelSourceRows({
      registered,
      generated,
      succeeded,
      paid,
      attribution: input.attribution,
    }),
    sourceBreakdownUnavailable: input.sourceBreakdownUnavailable === true,
    timeToFirstImage: {
      registerToFirstSuccess: summarizeDurations(registerToFirstSuccess),
      firstJobCreatedToFinished: {
        ...summarizeDurations(firstJobDurations),
        unfinished: firstJobUnfinished,
        firstJobNotSucceeded,
      },
    },
    truncated: input.truncated === true,
    dayTimezone: timeZone,
  };
}
