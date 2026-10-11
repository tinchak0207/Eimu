// 模型可用性闸（circuit breaker，2026-09-27）：由「真实生成结果」驱动。
//
// 病根：gemini-3.1-flash-image 14 天 103 单 0% 成功、seedance-2.0 系列 0%——用户选到
// 死模型要白等到 deadline（数分钟）才失败，UI 宣称与真实能力不符。既有活性信号
// （model-status-probe 的 GET /models 探测 + supplier-health-signal 的供应商/帐户
// 健康）都是「前置条件」，不是「结果」：渠道 /models 200、帐户未冷却，照样可以单单
// deadline_exceeded。这里补上最后一把尺——控制面 generation_job 的终态本身。
//
// 跑在哪一层：VPS 控制面（image-control-api）。generation_job 只在控制面 Postgres，
// 所有提交路由（/v1/*、/api/generation-jobs）在生产都经 next.config rewrites 代理到
// 控制面；Vercel 侧（模型选单）经 HMAC 内部端点 /api/internal/model-status 读同一份
// 判定，不在边缘另算。
//
// 规则（具名常数，见下）：
//   某 model_id 在最近 72h 内、最近 20 个「计入」的终态 job 中（排除用户侧原因
//   user_input / cancelled，以及 status=cancelled），
//     样本 ≥5 且成功 0，或 样本 ≥10 且成功率 <20% → open（unavailable）。
//   半开：open 状态下每 30 分钟放行 1 单试探（以该模型最后一次建单时间 + 本进程
//   放行记录为准）；最近一个计入终态是成功 → 立即 closed（成功即恢复）。
//
// fail-open 纪律：DB 读失败 → 空快照 → 全部 closed，绝不因为统计读不到把好模型标死。

import { generationControlPlaneEnabled, getGenerationSql, type GenerationSql } from "./database";
import { applyModelBiasResetToJobRows, EMPTY_BIAS_RESET_WATERMARKS, readBiasResetWatermarks } from "../bias-reset";
import type { GenerationKind } from "./types";

/** 统计窗口：只看最近 72h 建立的 job。 */
export const MODEL_BREAKER_WINDOW_MS = 72 * 60 * 60_000;
/** 每模型只取最近 N 个计入的终态 job。 */
export const MODEL_BREAKER_SAMPLE_LIMIT = 20;
/** 规则 A：样本 ≥ 此值且 0 成功 → open。 */
export const MODEL_BREAKER_ZERO_SUCCESS_MIN_SAMPLES = 5;
/** 规则 B：样本 ≥ 此值且成功率 < MODEL_BREAKER_LOW_SUCCESS_RATE → open。 */
export const MODEL_BREAKER_LOW_RATE_MIN_SAMPLES = 10;
export const MODEL_BREAKER_LOW_SUCCESS_RATE = 0.2;
/** 半开：open 状态下每隔多久放行 1 单试探。 */
export const MODEL_BREAKER_HALF_OPEN_INTERVAL_MS = 30 * 60_000;
/** 统计快照记忆体快取 TTL。 */
export const MODEL_BREAKER_CACHE_TTL_MS = 60_000;
/** 用户侧失败原因：不代表模型坏，不计入样本。 */
export const MODEL_BREAKER_EXCLUDED_FAILURE_CLASSES: readonly string[] = ["user_input", "cancelled"];
/** 计入的终态（cancelled 是用户主动取消，不计入）。 */
export const MODEL_BREAKER_TERMINAL_STATUSES: readonly string[] = ["succeeded", "failed", "refunded"];
/** 回滚开关：设为 1/true 则闸门整体停用（列表与提交都不拦）。 */
export const MODEL_BREAKER_DISABLED_ENV = "GENERATION_MODEL_BREAKER_DISABLED";
/** 单次读取的行数上限（72h 内全平台 job 量级为数百，上限只防异常膨胀）。 */
const MODEL_BREAKER_ROW_LIMIT = 5_000;

export type ModelMediaFamily = "image" | "video" | "audio" | "other";

export interface ModelOutcomeRow {
  model_id: string;
  kind: string;
  status: string;
  failure_class: string | null;
  created_at: Date | string;
  finished_at: Date | string | null;
  updated_at: Date | string | null;
}

export interface ModelBreakerStats {
  modelId: string;
  family: ModelMediaFamily;
  /** 计入的终态样本数（≤ MODEL_BREAKER_SAMPLE_LIMIT）。 */
  samples: number;
  successes: number;
  /** 最近一个计入终态是否成功（半开恢复依据）。无样本 → null。 */
  lastOutcomeSucceeded: boolean | null;
  /** 窗口内该模型最后一次建单时间（任何状态，含进行中）——半开放行的时间锚。 */
  lastAttemptAt: number | null;
}

export type ModelBreakerState = "closed" | "open";

export interface ModelBreakerVerdict extends ModelBreakerStats {
  state: ModelBreakerState;
  successRate: number | null;
  /** open 时的中文原因（诚实陈述样本）。 */
  reason?: string;
}

export interface ModelBreakerSnapshot {
  generatedAt: number;
  verdicts: Map<string, ModelBreakerVerdict>;
  /**
   * 供给面断供：有 capability 合约、但没有任何「供应商＋合约＋帐号」三者皆 enabled 且
   * 非 disabled 的组合（与 scheduler acquire 同条件，cooldown 属暂时态不计）。
   * 这种模型提交了也只会排队空转到 deadline（INC-VIDEO-0927b），且试探单不可能成功，
   * 所以直接判不可用、不放半开试探；供应恢复（管理员重新启用）即自动解除。
   */
  unsupplied?: Set<string>;
}

export const MODEL_UNSUPPLIED_REASON = "供应商账户暂不可用（已停用，等待恢复）";

export interface ModelAlternative {
  modelId: string;
  successRate: number;
  samples: number;
}

export type ModelGateDecision =
  | { allowed: true; probe: boolean }
  | {
    allowed: false;
    modelId: string;
    message: string;
    alternatives: ModelAlternative[];
    retryAfterSeconds: number;
  };

export function modelBreakerDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[MODEL_BREAKER_DISABLED_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export function mediaFamilyForKind(kind: string): ModelMediaFamily {
  if (kind === "image_generate" || kind === "image_edit") return "image";
  if (kind === "video_generate" || kind === "avatar" || kind === "lipsync") return "video";
  if (kind === "tts") return "audio";
  return "other";
}

function toMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function countsAsSample(row: ModelOutcomeRow): boolean {
  if (!MODEL_BREAKER_TERMINAL_STATUSES.includes(row.status)) return false;
  if (row.failure_class && MODEL_BREAKER_EXCLUDED_FAILURE_CLASSES.includes(row.failure_class)) return false;
  return true;
}

/** 纯函数：把窗口内的 job 行汇总成每模型统计（最近 N 个计入终态 + 最后建单时间）。 */
export function summarizeModelOutcomes(
  rows: readonly ModelOutcomeRow[],
  options: { now?: number; windowMs?: number; sampleLimit?: number } = {},
): Map<string, ModelBreakerStats> {
  const now = options.now ?? Date.now();
  const since = now - (options.windowMs ?? MODEL_BREAKER_WINDOW_MS);
  const sampleLimit = options.sampleLimit ?? MODEL_BREAKER_SAMPLE_LIMIT;

  const byModel = new Map<string, { family: ModelMediaFamily; familyAt: number; lastAttemptAt: number | null; terminal: { endedAt: number; succeeded: boolean }[] }>();
  for (const row of rows) {
    const createdAt = toMs(row.created_at);
    if (createdAt === null || createdAt <= since) continue;
    const entry = byModel.get(row.model_id) ?? { family: mediaFamilyForKind(row.kind), familyAt: createdAt, lastAttemptAt: null, terminal: [] };
    if (createdAt >= entry.familyAt) {
      entry.family = mediaFamilyForKind(row.kind);
      entry.familyAt = createdAt;
    }
    entry.lastAttemptAt = entry.lastAttemptAt === null ? createdAt : Math.max(entry.lastAttemptAt, createdAt);
    if (countsAsSample(row)) {
      const endedAt = toMs(row.finished_at) ?? toMs(row.updated_at) ?? createdAt;
      entry.terminal.push({ endedAt, succeeded: row.status === "succeeded" });
    }
    byModel.set(row.model_id, entry);
  }

  const stats = new Map<string, ModelBreakerStats>();
  for (const [modelId, entry] of byModel) {
    const recent = entry.terminal.sort((a, b) => b.endedAt - a.endedAt).slice(0, sampleLimit);
    stats.set(modelId, {
      modelId,
      family: entry.family,
      samples: recent.length,
      successes: recent.filter((item) => item.succeeded).length,
      lastOutcomeSucceeded: recent.length ? recent[0].succeeded : null,
      lastAttemptAt: entry.lastAttemptAt,
    });
  }
  return stats;
}

/** 纯函数：单模型判定（规则见档头）。 */
export function evaluateModelBreaker(stats: ModelBreakerStats): ModelBreakerVerdict {
  const successRate = stats.samples > 0 ? stats.successes / stats.samples : null;
  const base = { ...stats, successRate };
  // 半开恢复：最近一个计入终态是成功 → 立即 closed（试探单成功即恢复）。
  if (stats.lastOutcomeSucceeded === true) return { ...base, state: "closed" };
  const zeroSuccess = stats.samples >= MODEL_BREAKER_ZERO_SUCCESS_MIN_SAMPLES && stats.successes === 0;
  const lowRate = stats.samples >= MODEL_BREAKER_LOW_RATE_MIN_SAMPLES
    && successRate !== null
    && successRate < MODEL_BREAKER_LOW_SUCCESS_RATE;
  if (!zeroSuccess && !lowRate) return { ...base, state: "closed" };
  const pct = Math.round((successRate ?? 0) * 100);
  return {
    ...base,
    state: "open",
    reason: `近 72 小时最近 ${stats.samples} 单真实生成仅 ${stats.successes} 单成功（${pct}%）`,
  };
}

export function buildModelBreakerSnapshot(
  rows: readonly ModelOutcomeRow[],
  now: number = Date.now(),
): ModelBreakerSnapshot {
  const verdicts = new Map<string, ModelBreakerVerdict>();
  for (const [modelId, stats] of summarizeModelOutcomes(rows, { now })) {
    verdicts.set(modelId, evaluateModelBreaker(stats));
  }
  return { generatedAt: now, verdicts };
}

/** 同介质中成功率最高的可用模型（有真实成功样本才推荐，不推荐没证据的模型）。 */
export function suggestAlternativeModels(
  snapshot: ModelBreakerSnapshot,
  modelId: string,
  limit = 2,
): ModelAlternative[] {
  const self = snapshot.verdicts.get(modelId);
  if (!self || self.family === "other") return [];
  return [...snapshot.verdicts.values()]
    .filter((verdict) => verdict.modelId !== modelId
      && !snapshot.unsupplied?.has(verdict.modelId)
      && verdict.family === self.family
      && verdict.state === "closed"
      && verdict.successes > 0
      && verdict.successRate !== null)
    .sort((a, b) => (b.successRate! - a.successRate!) || (b.samples - a.samples) || a.modelId.localeCompare(b.modelId))
    .slice(0, limit)
    .map((verdict) => ({ modelId: verdict.modelId, successRate: verdict.successRate!, samples: verdict.samples }));
}

// ── DB 读取 + 60s 快取 ─────────────────────────────────────────────

let snapshotCache: { expiresAt: number; snapshot: ModelBreakerSnapshot } | null = null;
/** 本进程已放行的试探单时间（跨快取周期防同进程连放；跨进程以 DB 最后建单时间为锚）。 */
const probeReleasedAt = new Map<string, number>();

export function __resetModelBreakerStateForTests(): void {
  snapshotCache = null;
  probeReleasedAt.clear();
}

/**
 * 读控制面 generation_job 窗口内的 job（只读、走 created_at 索引，实测 72h 窗 ~2ms），
 * 汇总成判定快照。60s 记忆体快取；DB 失败 → 空快照（fail-open）。
 */
export async function readModelBreakerSnapshot(
  sql?: GenerationSql,
  options: { now?: () => number } = {},
): Promise<ModelBreakerSnapshot> {
  const now = (options.now ?? Date.now)();
  if (snapshotCache && snapshotCache.expiresAt > now) return snapshotCache.snapshot;
  // 无 DB 的实例（Vercel 边缘）不另算：空快照 = 全部可用，真判定只在控制面。
  if (!sql && !generationControlPlaneEnabled()) return { generatedAt: now, verdicts: new Map() };
  try {
    const db = sql ?? getGenerationSql();
    const since = new Date(now - MODEL_BREAKER_WINDOW_MS);
    const rows = await db<ModelOutcomeRow[]>`
      SELECT model_id, kind, status, failure_class, created_at, finished_at, updated_at
      FROM generation_job
      WHERE created_at > ${since}
      ORDER BY created_at DESC
      LIMIT ${MODEL_BREAKER_ROW_LIMIT}
    `;
    // 渠道 bias 刷新水位（2026-10-12）：渠道修好后，被判为「修复前旧证据」的终态样本
    // 不再计入本轮统计——否则修好的渠道要干等 72h 才从断路器里出来。fail-open。
    const watermarks = await readBiasResetWatermarks(db).catch(() => EMPTY_BIAS_RESET_WATERMARKS);
    const snapshot = buildModelBreakerSnapshot(applyModelBiasResetToJobRows(rows, watermarks), now);
    const supply = await db<{ public_model_id: string }[]>`
      SELECT capability.public_model_id
      FROM supplier_capability capability
      JOIN supplier ON supplier.id = capability.supplier_id
      LEFT JOIN supplier_account account ON account.supplier_id = supplier.id
      WHERE capability.is_current
      GROUP BY capability.public_model_id
      HAVING NOT bool_or(
        supplier.enabled AND supplier.health_status <> 'disabled'
        AND capability.enabled AND capability.health_status <> 'disabled'
        AND COALESCE(account.enabled AND account.health_status <> 'disabled', false)
      )
    `;
    snapshot.unsupplied = new Set(supply.map((row) => row.public_model_id));
    snapshotCache = { expiresAt: now + MODEL_BREAKER_CACHE_TTL_MS, snapshot };
    return snapshot;
  } catch (error) {
    console.error("[model-availability-gate] generation_job 读取失败（fail-open，不拦任何模型）", error);
    return { generatedAt: now, verdicts: new Map() };
  }
}

/** 列表面用：open 的模型 → 原因。空 map = 全部可用。 */
export async function readUnavailableModels(
  sql?: GenerationSql,
  options: { now?: () => number; env?: NodeJS.ProcessEnv } = {},
): Promise<Map<string, string>> {
  if (modelBreakerDisabled(options.env)) return new Map();
  const snapshot = await readModelBreakerSnapshot(sql, options);
  const unavailable = new Map<string, string>();
  for (const verdict of snapshot.verdicts.values()) {
    if (verdict.state === "open") unavailable.set(verdict.modelId, verdict.reason ?? "近期真实生成全部失败");
  }
  for (const modelId of snapshot.unsupplied ?? []) unavailable.set(modelId, MODEL_UNSUPPLIED_REASON);
  return unavailable;
}

function formatAlternatives(alternatives: readonly ModelAlternative[]): string {
  if (!alternatives.length) return "请稍后重试或换用其他模型。";
  const list = alternatives
    .map((alt) => `${alt.modelId}（近期成功率 ${Math.round(alt.successRate * 100)}%）`)
    .join("、");
  return `建议改用 ${list}。`;
}

/**
 * 提交面用：在建单 / 预扣费之前判断该模型能否提交。
 *   closed → 放行；open 且距最后一次建单已超过半开间隔 → 放行 1 单试探；
 *   其余 → 拒绝（诚实中文讯息 + 同介质替代建议）。
 */
export async function checkModelAvailability(
  modelId: string,
  options: { sql?: GenerationSql; now?: () => number; env?: NodeJS.ProcessEnv } = {},
): Promise<ModelGateDecision> {
  if (modelBreakerDisabled(options.env)) return { allowed: true, probe: false };
  const nowFn = options.now ?? Date.now;
  const snapshot = await readModelBreakerSnapshot(options.sql, { now: nowFn });
  if (snapshot.unsupplied?.has(modelId)) {
    const alternatives = suggestAlternativeModels(snapshot, modelId);
    const retryAfterSeconds = Math.ceil(MODEL_BREAKER_HALF_OPEN_INTERVAL_MS / 1000);
    return {
      allowed: false,
      modelId,
      message: `模型 ${modelId} 暂不可用：${MODEL_UNSUPPLIED_REASON}。本次未提交、未扣费。` + formatAlternatives(alternatives),
      alternatives,
      retryAfterSeconds,
    };
  }
  const verdict = snapshot.verdicts.get(modelId);
  if (!verdict || verdict.state === "closed") return { allowed: true, probe: false };

  const now = nowFn();
  const lastAttemptAt = Math.max(verdict.lastAttemptAt ?? 0, probeReleasedAt.get(modelId) ?? 0);
  const nextProbeAt = lastAttemptAt + MODEL_BREAKER_HALF_OPEN_INTERVAL_MS;
  if (now >= nextProbeAt) {
    probeReleasedAt.set(modelId, now);
    return { allowed: true, probe: true };
  }

  const alternatives = suggestAlternativeModels(snapshot, modelId);
  const retryAfterSeconds = Math.max(1, Math.ceil((nextProbeAt - now) / 1000));
  const retryMinutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  const message = `模型 ${modelId} 暂不可用：${verdict.reason ?? "近期真实生成全部失败"}。本次未提交、未扣费。`
    + formatAlternatives(alternatives)
    + `系统约每 ${Math.round(MODEL_BREAKER_HALF_OPEN_INTERVAL_MS / 60_000)} 分钟放行 1 单试探，成功即自动恢复（约 ${retryMinutes} 分钟后可再试）。`;
  return { allowed: false, modelId, message, alternatives, retryAfterSeconds };
}

/** 提交闸拒单：由 submitGenerationCommand 在建单/预扣费之前抛出，路由层映射为 503。 */
export class GenerationModelUnavailableError extends Error {
  readonly modelId: string;
  readonly alternatives: ModelAlternative[];
  readonly retryAfterSeconds: number;

  constructor(decision: Extract<ModelGateDecision, { allowed: false }>) {
    super(decision.message);
    this.name = "GenerationModelUnavailableError";
    this.modelId = decision.modelId;
    this.alternatives = decision.alternatives;
    this.retryAfterSeconds = decision.retryAfterSeconds;
  }
}

/** 提交闸函数型别（submitGenerationCommand 可注入，测试不碰 DB）。 */
export type ModelAvailabilityGate = (input: { modelId: string; kind: GenerationKind | string }) => Promise<ModelGateDecision>;
