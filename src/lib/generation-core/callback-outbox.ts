// 回调投递外发（outbox）。
//
// 现状：仓库里没有任何生产代码往客户端 callback_url 投递回调 —— generation_job
// 已经有 callback_url 字段，db/migrations/001_generation_control_plane.sql 也已经建好
// callback_delivery 表，但从来没有代码写过它。这个模块补上「排队 -> 认领 -> 投递 ->
// 记录结果」这条链路，供 worker/cron 调用；job-repository.ts / scheduler.ts /
// types.ts 由其他 agent 在改，这里只新增文件、只 import 只读的共享 helper。
//
// 设计对齐 job-repository.ts 里 claimNextGenerationJob 的 CTE + FOR UPDATE SKIP
// LOCKED 认领模式，以及 completeGenerationJob / beginGenerationAttempt 的
// sql.begin 事务写法。

import { createHash, createHmac, randomUUID } from "node:crypto";
import { getGenerationSql, type GenerationSql } from "./database";
import { planReplay, resolveReplayPolicy } from "./operation-registry";

type Row = Record<string, unknown>;

export type CallbackDeliveryStatus = "pending" | "delivering" | "delivered" | "dead_letter";

export interface CallbackDeliveryRow {
  id: string;
  jobId: string;
  callbackUrl: string;
  payloadJson: unknown;
  payloadHash: string;
  hmacKeyVersion: string;
  status: CallbackDeliveryStatus;
  deliveryCount: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  responseCode: number | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
  updatedAt: Date;
}

/**
 * 达到此次数仍未成功，直接判死信，不再重试（等运营/客户介入排查）。
 *
 * FG-03（2026-09-23）：重放预算唯一来源是封闭 operation registry 的
 * `callback.deliver` 政策；呼叫方（含本模组的调用者）不得自带 retry 次数。
 * 这个常量改为 registry 查询结果，不再是一个独立的魔数。
 */
export const MAX_CALLBACK_DELIVERY_ATTEMPTS = resolveReplayPolicy("callback.deliver").maxReplayAttempts;

/**
 * 投递重放裁决（FG-02/03）：只有 registry 的 `callback.deliver` 政策说可以，
 * 且下一次投递序号还在预算内，才排下一次；否则进死信。
 */
export function planCallbackDeliveryReplay(nextAttemptNo: number): ReturnType<typeof planReplay> {
  return planReplay({ operation: "callback.deliver", nextAttemptNo });
}

// ─────────────────────────────────────────────────────────── row mapping

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : asDate(value);
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function mapCallbackDelivery(row: Row): CallbackDeliveryRow {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    callbackUrl: String(row.callback_url),
    payloadJson: jsonValue(row.payload_json, null),
    payloadHash: String(row.payload_hash),
    hmacKeyVersion: String(row.hmac_key_version),
    status: row.status as CallbackDeliveryStatus,
    deliveryCount: Number(row.delivery_count),
    nextAttemptAt: asDate(row.next_attempt_at),
    leaseOwner: row.lease_owner === null || row.lease_owner === undefined ? null : String(row.lease_owner),
    leaseExpiresAt: nullableDate(row.lease_expires_at),
    responseCode: row.response_code === null || row.response_code === undefined ? null : Number(row.response_code),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    createdAt: asDate(row.created_at),
    deliveredAt: nullableDate(row.delivered_at),
    updatedAt: asDate(row.updated_at),
  };
}

// ─────────────────────────────────────────────────────────── SSRF guard

/**
 * 基础 SSRF 防护：只放行 https:// 且主机名不落在已知私有/回环/链路本地段的
 * 回调地址。这不是完整的出网防护（不做 DNS 解析后二次校验、不防 DNS rebinding），
 * 仅在入队时挡掉明显违规的地址；交付前重新校验 DNS/IP 留给未来的 worker 强化。
 */
const PRIVATE_OR_LOOPBACK_HOSTNAME_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^fe80:/i,
];

export function assertSafeCallbackUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid callback URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:") {
    throw new Error("Callback URL must use https://.");
  }
  const hostname = url.hostname.toLowerCase();
  if (PRIVATE_OR_LOOPBACK_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname))) {
    throw new Error(`Callback URL host is not allowed: ${hostname}`);
  }
  return url;
}

// ─────────────────────────────────────────────────────────── canonical hash + HMAC signing

/**
 * 与 crypto.ts 的 generationRequestHash 相同的规范化策略（key 排序、丢弃
 * undefined），但这里单独实现而不是直接导入它 —— generationRequestHash 是为
 * "请求去重指纹" 设计的语义，命名和用途都属于 job 幂等性，不该被回调载荷复用，
 * 以免以后两处需求分叉时互相牵连。算法保持一致即可。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(payload: unknown): string {
  return JSON.stringify(canonicalize(payload));
}

export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/**
 * 可轮换的 HMAC 密钥约定：`CALLBACK_HMAC_KEY_VERSION` 指出当前应该用哪个版本
 * （例如 "v1"），对应密钥读 `CALLBACK_HMAC_SECRET_<VERSION>`（大写），例如
 * CALLBACK_HMAC_SECRET_V1。仓库里没有现成的回调签名密钥约定（admin-auth.ts 的
 * ADMIN_SESSION_SECRET 是会话签名，语义不同，没有复用），这里新建一套但保持
 * "版本号 -> 独立密钥" 的可轮换形状，投递时把用到的版本号存在
 * callback_delivery.hmac_key_version 里，换密钥不影响已入队但未投递的行。
 */
export function currentHmacKeyVersion(env: NodeJS.ProcessEnv = process.env): string {
  const version = (env.CALLBACK_HMAC_KEY_VERSION ?? "v1").trim();
  if (!version) throw new Error("CALLBACK_HMAC_KEY_VERSION must not be blank.");
  return version;
}

export function hmacSecretForVersion(version: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = `CALLBACK_HMAC_SECRET_${version.toUpperCase()}`;
  const secret = (env[key] ?? "").trim();
  if (!secret) throw new Error(`${key} is required to sign callback deliveries.`);
  return secret;
}

export function signCallbackBody(rawBody: string, keyVersion: string, env?: NodeJS.ProcessEnv): string {
  const secret = hmacSecretForVersion(keyVersion, env);
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

// ─────────────────────────────────────────────────────────── backoff

/**
 * 指数退避，封顶一小时：min(2^attempt * 5s, 1h)。attempt 传入的是失败后的
 * delivery_count（从 1 开始），attempt<=0 视为第一次退避。纯函数，方便单测
 * 覆盖增长/封顶而不用碰数据库。
 */
export function backoffSeconds(attempt: number): number {
  const normalized = Math.max(1, Math.floor(attempt));
  const seconds = 2 ** normalized * 5;
  return Math.min(seconds, 3600);
}

// ─────────────────────────────────────────────────────────── enqueue

export interface EnqueueCallbackInput {
  jobId: string;
  callbackUrl: string;
  payload: unknown;
}

/**
 * 每个 job 最多一条回调记录（表上 UNIQUE (job_id) + ON CONFLICT DO NOTHING），
 * 与「一次生成任务只回调一次」的设计保持一致 —— 重复调用是无害的 no-op，
 * 不会覆盖已经在投递/已投递的行。
 */
export async function enqueueCallback(
  input: EnqueueCallbackInput,
  sql: GenerationSql = getGenerationSql(),
): Promise<void> {
  assertSafeCallbackUrl(input.callbackUrl);
  const hash = payloadHash(input.payload);
  const keyVersion = currentHmacKeyVersion();
  // 建 delivery 行前先确认密钥存在，避免入队一条永远签不出名的回调。
  hmacSecretForVersion(keyVersion);

  await sql`
    INSERT INTO callback_delivery (
      id, job_id, callback_url, payload_json, payload_hash, hmac_key_version,
      status, next_attempt_at
    ) VALUES (
      ${randomUUID()}, ${input.jobId}, ${input.callbackUrl}, ${sql.json(input.payload as Parameters<typeof sql.json>[0])}, ${hash},
      ${keyVersion}, 'pending', now()
    )
    ON CONFLICT (job_id) DO NOTHING
  `;
}

// ─────────────────────────────────────────────────────────── claim

/**
 * 事务内认领一批到期的回调，SKIP LOCKED 避免多 worker 抢同一行阻塞；
 * 与 job-repository.ts 的 claimNextGenerationJob 用同样的 CTE + UPDATE ... FROM
 * 认领模式，只是这里一次可以认领多行。
 */
export async function claimDueCallbacks(
  workerId: string,
  limit: number,
  leaseMs: number,
  sql: GenerationSql = getGenerationSql(),
): Promise<CallbackDeliveryRow[]> {
  const rows = await sql<Row[]>`
    WITH candidate AS (
      SELECT id
      FROM callback_delivery
      WHERE status IN ('pending', 'delivering')
        AND next_attempt_at <= now()
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
      ORDER BY next_attempt_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE callback_delivery delivery
    SET status = 'delivering', lease_owner = ${workerId},
        lease_expires_at = now() + (${leaseMs}::text || ' milliseconds')::interval,
        updated_at = now()
    FROM candidate
    WHERE delivery.id = candidate.id
    RETURNING delivery.*
  `;
  return rows.map(mapCallbackDelivery);
}

// ─────────────────────────────────────────────────────────── deliver

export interface DeliverCallbackResult {
  ok: boolean;
  responseCode?: number;
  error?: string;
}

export async function deliverCallback(
  row: CallbackDeliveryRow,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliverCallbackResult> {
  const body = canonicalJson(row.payloadJson);
  let signature: string;
  try {
    signature = signCallbackBody(body, row.hmacKeyVersion);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  try {
    const response = await fetchImpl(row.callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Callback-Signature": `sha256=${signature}`,
        "X-Callback-Id": row.id,
        "X-Callback-Delivery-Count": String(row.deliveryCount + 1),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const ok = response.status >= 200 && response.status < 300;
    if (ok) return { ok: true, responseCode: response.status };
    const text = await response.text().catch(() => "");
    return { ok: false, responseCode: response.status, error: text.slice(0, 2000) || `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ─────────────────────────────────────────────────────────── record result

export interface RecordCallbackDeliveryResultInput {
  id: string;
  ok: boolean;
  responseCode?: number;
  error?: string;
}

export async function recordCallbackDeliveryResult(
  input: RecordCallbackDeliveryResultInput,
  sql: GenerationSql = getGenerationSql(),
): Promise<void> {
  const succeeded = input.ok && input.responseCode !== undefined && input.responseCode >= 200 && input.responseCode < 300;

  if (succeeded) {
    await sql`
      UPDATE callback_delivery
      SET status = 'delivered', delivered_at = now(), response_code = ${input.responseCode ?? null},
          last_error = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = ${input.id}
    `;
    return;
  }

  const lastError = (input.error ?? "Unknown callback delivery failure.").slice(0, 2000);

  // 退避秒数取决于新的 delivery_count，这不是纯 SQL 表达式能算清楚的（backoffSeconds
  // 是一个 JS 里可单测的纯函数），所以在事务里先读出当前计数、算好下一步状态，
  // 再一次 UPDATE 写回。FOR UPDATE 防止同一行被并发 worker 同时结算两次。
  await sql.begin(async (tx) => {
    const rows = await tx<{ delivery_count: number }[]>`
      SELECT delivery_count FROM callback_delivery WHERE id = ${input.id} FOR UPDATE
    `;
    if (!rows[0]) return;
    const nextCount = Number(rows[0].delivery_count) + 1;
    // FG-02/03：刚失败的是第 nextCount 次，下一次投递的许可问 registry——
    // 不是问本模组的魔数，也不是问呼叫方传进来的任何预算。
    const replay = planCallbackDeliveryReplay(nextCount + 1);
    const deadLettered = !replay.allowed;

    if (deadLettered) {
      await tx`
        UPDATE callback_delivery
        SET delivery_count = ${nextCount}, response_code = ${input.responseCode ?? null},
            last_error = ${lastError}, status = 'dead_letter',
            lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = ${input.id}
      `;
      return;
    }

    const nextAttemptAt = new Date(Date.now() + backoffSeconds(nextCount) * 1000);
    await tx`
      UPDATE callback_delivery
      SET delivery_count = ${nextCount}, response_code = ${input.responseCode ?? null},
          last_error = ${lastError}, status = 'pending', next_attempt_at = ${nextAttemptAt},
          lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = ${input.id}
    `;
  });
}

// ─────────────────────────────────────────────────────────── worker loop

export interface CallbackWorkerSummary {
  delivered: number;
  failed: number;
  deadLettered: number;
}

const DEFAULT_CLAIM_BATCH = 20;
const DEFAULT_LEASE_MS = 30_000;

export async function runCallbackWorkerOnce(
  workerId: string,
  sql: GenerationSql = getGenerationSql(),
): Promise<CallbackWorkerSummary> {
  const claimed = await claimDueCallbacks(workerId, DEFAULT_CLAIM_BATCH, DEFAULT_LEASE_MS, sql);
  const summary: CallbackWorkerSummary = { delivered: 0, failed: 0, deadLettered: 0 };

  for (const row of claimed) {
    const result = await deliverCallback(row);
    await recordCallbackDeliveryResult({ id: row.id, ...result }, sql);
    if (result.ok && result.responseCode !== undefined && result.responseCode >= 200 && result.responseCode < 300) {
      summary.delivered += 1;
    } else if (!planCallbackDeliveryReplay(row.deliveryCount + 2).allowed) {
      summary.deadLettered += 1;
    } else {
      summary.failed += 1;
    }
  }

  return summary;
}
