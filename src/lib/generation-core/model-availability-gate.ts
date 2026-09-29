// 模型可用性閘（circuit breaker，2026-09-27）：由「真實生成結果」驅動。
//
// 病根：gemini-3.1-flash-image 14 天 103 單 0% 成功、seedance-2.0 系列 0%——用戶選到
// 死模型要白等到 deadline（數分鐘）才失敗，UI 宣稱與真實能力不符。既有活性信號
// （model-status-probe 的 GET /models 探測 + supplier-health-signal 的供應商/帳戶
// 健康）都是「前置條件」，不是「結果」：渠道 /models 200、帳戶未冷卻，照樣可以單單
// deadline_exceeded。這裡補上最後一把尺——控制面 generation_job 的終態本身。
//
// 跑在哪一層：VPS 控制面（image-control-api）。generation_job 只在控制面 Postgres，
// 所有提交路由（/v1/*、/api/generation-jobs）在生產都經 next.config rewrites 代理到
// 控制面；Vercel 側（模型選單）經 HMAC 內部端點 /api/internal/model-status 讀同一份
// 判定，不在邊緣另算。
//
// 規則（具名常數，見下）：
//   某 model_id 在最近 72h 內、最近 20 個「計入」的終態 job 中（排除用戶側原因
//   user_input / cancelled，以及 status=cancelled），
//     樣本 ≥5 且成功 0，或 樣本 ≥10 且成功率 <20% → open（unavailable）。
//   半開：open 狀態下每 30 分鐘放行 1 單試探（以該模型最後一次建單時間 + 本進程
//   放行記錄為準）；最近一個計入終態是成功 → 立即 closed（成功即恢復）。
//
// fail-open 紀律：DB 讀失敗 → 空快照 → 全部 closed，絕不因為統計讀不到把好模型標死。

import { generationControlPlaneEnabled, getGenerationSql, type GenerationSql } from "./database";
import type { GenerationKind } from "./types";

/** 統計窗口：只看最近 72h 建立的 job。 */
export const MODEL_BREAKER_WINDOW_MS = 72 * 60 * 60_000;
/** 每模型只取最近 N 個計入的終態 job。 */
export const MODEL_BREAKER_SAMPLE_LIMIT = 20;
/** 規則 A：樣本 ≥ 此值且 0 成功 → open。 */
export const MODEL_BREAKER_ZERO_SUCCESS_MIN_SAMPLES = 5;
/** 規則 B：樣本 ≥ 此值且成功率 < MODEL_BREAKER_LOW_SUCCESS_RATE → open。 */
export const MODEL_BREAKER_LOW_RATE_MIN_SAMPLES = 10;
export const MODEL_BREAKER_LOW_SUCCESS_RATE = 0.2;
/** 半開：open 狀態下每隔多久放行 1 單試探。 */
export const MODEL_BREAKER_HALF_OPEN_INTERVAL_MS = 30 * 60_000;
/** 統計快照記憶體快取 TTL。 */
export const MODEL_BREAKER_CACHE_TTL_MS = 60_000;
/** 用戶側失敗原因：不代表模型壞，不計入樣本。 */
export const MODEL_BREAKER_EXCLUDED_FAILURE_CLASSES: readonly string[] = ["user_input", "cancelled"];
/** 計入的終態（cancelled 是用戶主動取消，不計入）。 */
export const MODEL_BREAKER_TERMINAL_STATUSES: readonly string[] = ["succeeded", "failed", "refunded"];
/** 回滾開關：設為 1/true 則閘門整體停用（列表與提交都不攔）。 */
export const MODEL_BREAKER_DISABLED_ENV = "GENERATION_MODEL_BREAKER_DISABLED";
/** 單次讀取的行數上限（72h 內全平台 job 量級為數百，上限只防異常膨脹）。 */
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
  /** 計入的終態樣本數（≤ MODEL_BREAKER_SAMPLE_LIMIT）。 */
  samples: number;
  successes: number;
  /** 最近一個計入終態是否成功（半開恢復依據）。無樣本 → null。 */
  lastOutcomeSucceeded: boolean | null;
  /** 窗口內該模型最後一次建單時間（任何狀態，含進行中）——半開放行的時間錨。 */
  lastAttemptAt: number | null;
}

export type ModelBreakerState = "closed" | "open";

export interface ModelBreakerVerdict extends ModelBreakerStats {
  state: ModelBreakerState;
  successRate: number | null;
  /** open 時的中文原因（誠實陳述樣本）。 */
  reason?: string;
}

export interface ModelBreakerSnapshot {
  generatedAt: number;
  verdicts: Map<string, ModelBreakerVerdict>;
  /**
   * 供給面斷供：有 capability 合約、但沒有任何「供應商＋合約＋帳號」三者皆 enabled 且
   * 非 disabled 的組合（與 scheduler acquire 同條件，cooldown 屬暫時態不計）。
   * 這種模型提交了也只會排隊空轉到 deadline（INC-VIDEO-0927b），且試探單不可能成功，
   * 所以直接判不可用、不放半開試探；供應恢復（管理員重新啟用）即自動解除。
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

/** 純函數：把窗口內的 job 行彙總成每模型統計（最近 N 個計入終態 + 最後建單時間）。 */
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

/** 純函數：單模型判定（規則見檔頭）。 */
export function evaluateModelBreaker(stats: ModelBreakerStats): ModelBreakerVerdict {
  const successRate = stats.samples > 0 ? stats.successes / stats.samples : null;
  const base = { ...stats, successRate };
  // 半開恢復：最近一個計入終態是成功 → 立即 closed（試探單成功即恢復）。
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

/** 同介質中成功率最高的可用模型（有真實成功樣本才推薦，不推薦沒證據的模型）。 */
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

// ── DB 讀取 + 60s 快取 ─────────────────────────────────────────────

let snapshotCache: { expiresAt: number; snapshot: ModelBreakerSnapshot } | null = null;
/** 本進程已放行的試探單時間（跨快取週期防同進程連放；跨進程以 DB 最後建單時間為錨）。 */
const probeReleasedAt = new Map<string, number>();

export function __resetModelBreakerStateForTests(): void {
  snapshotCache = null;
  probeReleasedAt.clear();
}

/**
 * 讀控制面 generation_job 窗口內的 job（只讀、走 created_at 索引，實測 72h 窗 ~2ms），
 * 彙總成判定快照。60s 記憶體快取；DB 失敗 → 空快照（fail-open）。
 */
export async function readModelBreakerSnapshot(
  sql?: GenerationSql,
  options: { now?: () => number } = {},
): Promise<ModelBreakerSnapshot> {
  const now = (options.now ?? Date.now)();
  if (snapshotCache && snapshotCache.expiresAt > now) return snapshotCache.snapshot;
  // 無 DB 的實例（Vercel 邊緣）不另算：空快照 = 全部可用，真判定只在控制面。
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
    const snapshot = buildModelBreakerSnapshot(rows, now);
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
    console.error("[model-availability-gate] generation_job 讀取失敗（fail-open，不攔任何模型）", error);
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
 * 提交面用：在建單 / 預扣費之前判斷該模型能否提交。
 *   closed → 放行；open 且距最後一次建單已超過半開間隔 → 放行 1 單試探；
 *   其餘 → 拒絕（誠實中文訊息 + 同介質替代建議）。
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

/** 提交閘拒單：由 submitGenerationCommand 在建單/預扣費之前拋出，路由層映射為 503。 */
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

/** 提交閘函數型別（submitGenerationCommand 可注入，測試不碰 DB）。 */
export type ModelAvailabilityGate = (input: { modelId: string; kind: GenerationKind | string }) => Promise<ModelGateDecision>;
