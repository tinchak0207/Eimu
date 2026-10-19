// B 端 API 拒绝遥测：/v1/* 上「回非 2xx」的出口各留一行足迹。
//
// 为什么要单独记：被拒的请求（鉴权／余额／参数）根本不进 generation_job，
// 所以「23 把 key 有 16 把一次都没成功过」在既有数据里是黑洞 —— 看不出流失在
// 鉴权、余额还是参数校验。这里补上那条看不见的漏斗。
//
// 三条硬约束（写进测试，改坏了会红）：
//   ①只记 key 前 8 位：`sk-biz-7f`。不足以反推，也足够在同批客诉里对得上。
//   ②不记 prompt、不记完整 key、不记 email：payload 只在记忆体里被读，落地前就丢。
//   ③写入失败静默吞掉：遥测坏掉不能把客户的请求一起弄坏（best-effort，绝不 throw、
//     绝不 await 阻塞回应）。
//
// 表结构与 db/migrations/029_api_rejection.sql 同源（ensureSchema 首用即建，仿 referral-reward）。

import type { GenerationSql } from "@/lib/generation-core/database";
import { generationControlPlaneEnabled, getGenerationSql } from "@/lib/generation-core/database";

/** 落地时保留的 key 位数。 */
export const API_REJECTION_KEY_PREFIX_CHARS = 8;

/** 栏位上限：客户端可控的字串不许把表撑大。 */
const MAX_PATH_CHARS = 300;
const MAX_MODEL_CHARS = 128;
const MAX_REASON_CHARS = 200;

export interface ApiRejectionRecord {
  userId: number | null;
  keyPrefix: string | null;
  path: string;
  model: string | null;
  status: number;
  reason: string;
}

export interface ApiRejectionInput {
  userId?: number | null;
  /** 原始 Bearer 令牌。只在这里被切成前 8 位，之后不再引用也不落地。 */
  rawKey?: string | null;
  path: string;
  model?: string | null;
  status: number;
  /** 分组用的稳定码：一律传回应体里的 OpenAI `code`（如 missing_api_key／insufficient_quota）。 */
  reason: string;
}

export interface ApiRejectionStore {
  insert(row: ApiRejectionRecord): Promise<void>;
}

/**
 * 请求层的遥测上下文：路由在鉴权成功／解析出模型后就地填进来，
 * 出口由 `withApiRejectionTelemetry` 统一读取。放物件而不是多个区域变数，
 * 是为了让「后填的值」能穿过闭包回到包装层。
 */
export interface RejectionContext {
  /** 原始 Bearer 令牌（只会被切成前 8 位）。 */
  rawKey: string | null;
  userId: number | null;
  /** 客户请求的模型名（未归一，只作分组线索）。 */
  model: string | null;
}

// ─────────────────────────────────────────────────────────── 纯逻辑

/** key 前 8 位。空／非字串 → null（缺 key 的请求不编一个假的出来）。 */
export function apiKeyPrefix(rawKey: string | null | undefined): string | null {
  if (typeof rawKey !== "string") return null;
  const trimmed = rawKey.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, API_REJECTION_KEY_PREFIX_CHARS);
}

/** 去掉 query（可能带 token）与控制字元，再截断。 */
function sanitize(value: string, max: number): string {
  return value
    .split("?")[0]
    // eslint-disable-next-line no-control-regex -- 遥测栏位不接受控制字元（防注入换行）
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, max);
}

/**
 * 把入口的原始输入收成可落地的一行。形状不合法（没有 path 或 status 非整数）→ null，
 * 宁可少一行也不写进无法解释的脏资料。
 */
export function normalizeApiRejection(input: ApiRejectionInput): ApiRejectionRecord | null {
  if (!Number.isInteger(input.status)) return null;
  if (typeof input.path !== "string" || !input.path.trim()) return null;

  const userId = Number.isInteger(input.userId) && Number(input.userId) > 0 ? Number(input.userId) : null;
  const model = typeof input.model === "string" && input.model.trim() ? sanitize(input.model.trim(), MAX_MODEL_CHARS) : null;

  return {
    userId,
    keyPrefix: apiKeyPrefix(input.rawKey),
    path: sanitize(input.path.trim(), MAX_PATH_CHARS),
    model: model || null,
    status: input.status,
    reason: sanitize(typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : "unknown", MAX_REASON_CHARS),
  };
}

/**
 * 造一个记录器。回传的函式永不 throw、立即返回（不 await 储存层）——
 * 遥测是旁路，客户的请求不该为它多等一个 RTT。
 */
export function createApiRejectionRecorder(store: ApiRejectionStore): (input: ApiRejectionInput) => void {
  return (input) => {
    let row: ApiRejectionRecord | null;
    try {
      row = normalizeApiRejection(input);
    } catch {
      return;
    }
    if (!row) return;
    void store.insert(row).catch(() => {
      // 静默：记不上就算了，绝不能影响请求本身。
    });
  };
}

// ─────────────────────────────────────────────────────────── Postgres

let schemaReady: Promise<void> | null = null;

async function ensureSchema(sql: GenerationSql): Promise<void> {
  if (!schemaReady) {
    // 与 db/migrations/029_api_rejection.sql 同一 DDL（幂等，首用即建）。
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS api_rejection (
          id         bigserial PRIMARY KEY,
          user_id    bigint,
          key_prefix text,
          path       text NOT NULL,
          model      text,
          status     int NOT NULL,
          reason     text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS api_rejection_created_idx ON api_rejection (created_at)`;
      await sql`CREATE INDEX IF NOT EXISTS api_rejection_user_idx ON api_rejection (user_id, created_at)`;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

export function createPostgresApiRejectionStore(sql: GenerationSql): ApiRejectionStore {
  return {
    async insert(row) {
      await ensureSchema(sql);
      await sql`
        INSERT INTO api_rejection (user_id, key_prefix, path, model, status, reason)
        VALUES (${row.userId}, ${row.keyPrefix}, ${row.path}, ${row.model}, ${row.status}, ${row.reason})
      `;
    },
  };
}

/** 仅供测试重置建表快取。 */
export function __resetApiRejectionSchemaForTests(): void {
  schemaReady = null;
}

// ─────────────────────────────────────────────────────────── 出口拦截

/**
 * 从回应体里取稳定码当 reason。
 *
 * 用 clone() 读：原回应仍可被客户端正常消费。取不到（非 JSON、body 已被读走、
 * 上游返回 HTML）就退回 `http_<status>` —— 这一组百分点本身就是「非 JSON 拒绝」的讯号。
 */
export async function rejectionReasonFromResponse(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as unknown;
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    if (typeof code === "string" && code.trim()) return code.trim();
  } catch {
    // 落到下面的兜底码。
  }
  return `http_${response.status}`;
}

/**
 * 出口拦截：唯一记录点。
 *
 * 写成包装层而不是在每个 `return` 前面插一行，是因为「漏记一条出口」这件事
 * 没有任何测试能事后发现 —— 把规则放在边界上，新增出口自动被覆盖。
 * 只记录 `status >= 300`；成功与 202 任务提交不进这张表。
 */
export async function withApiRejectionTelemetry(
  path: string,
  context: RejectionContext,
  run: () => Promise<Response>,
  record: (input: ApiRejectionInput) => void = recordApiRejection,
): Promise<Response> {
  const response = await run();
  if (response.status >= 300) {
    record({
      userId: context.userId,
      rawKey: context.rawKey,
      path,
      model: context.model,
      status: response.status,
      reason: await rejectionReasonFromResponse(response),
    });
  }
  return response;
}

// ─────────────────────────────────────────────────────────── 生产入口

/**
 * 路由用的记录器。控制面未开（本机／C 端 Vercel 直连）时是 no-op ——
 * 没有资料库就不假装记了，也不让呼叫端为此分支。
 */
export function recordApiRejection(input: ApiRejectionInput): void {
  if (!generationControlPlaneEnabled()) return;
  let sql: GenerationSql;
  try {
    sql = getGenerationSql();
  } catch {
    return;
  }
  createApiRejectionRecorder(createPostgresApiRejectionStore(sql))(input);
}