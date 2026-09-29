// B 端 API 拒絕遙測：/v1/* 上「回非 2xx」的出口各留一行足跡。
//
// 為什麼要單獨記：被拒的請求（鑑權／餘額／參數）根本不進 generation_job，
// 所以「23 把 key 有 16 把一次都沒成功過」在既有數據裡是黑洞 —— 看不出流失在
// 鑑權、餘額還是參數校驗。這裡補上那條看不見的漏斗。
//
// 三條硬約束（寫進測試，改壞了會紅）：
//   ①只記 key 前 8 位：`sk-biz-7f`。不足以反推，也足夠在同批客訴裡對得上。
//   ②不記 prompt、不記完整 key、不記 email：payload 只在記憶體裡被讀，落地前就丟。
//   ③寫入失敗靜默吞掉：遙測壞掉不能把客戶的請求一起弄壞（best-effort，絕不 throw、
//     絕不 await 阻塞回應）。
//
// 表結構與 db/migrations/029_api_rejection.sql 同源（ensureSchema 首用即建，仿 referral-reward）。

import type { GenerationSql } from "@/lib/generation-core/database";
import { generationControlPlaneEnabled, getGenerationSql } from "@/lib/generation-core/database";

/** 落地時保留的 key 位數。 */
export const API_REJECTION_KEY_PREFIX_CHARS = 8;

/** 欄位上限：客戶端可控的字串不許把表撐大。 */
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
  /** 原始 Bearer 令牌。只在這裡被切成前 8 位，之後不再引用也不落地。 */
  rawKey?: string | null;
  path: string;
  model?: string | null;
  status: number;
  /** 分組用的穩定碼：一律傳回應體裡的 OpenAI `code`（如 missing_api_key／insufficient_quota）。 */
  reason: string;
}

export interface ApiRejectionStore {
  insert(row: ApiRejectionRecord): Promise<void>;
}

/**
 * 請求層的遙測上下文：路由在鑑權成功／解析出模型後就地填進來，
 * 出口由 `withApiRejectionTelemetry` 統一讀取。放物件而不是多個區域變數，
 * 是為了讓「後填的值」能穿過閉包回到包裝層。
 */
export interface RejectionContext {
  /** 原始 Bearer 令牌（只會被切成前 8 位）。 */
  rawKey: string | null;
  userId: number | null;
  /** 客戶請求的模型名（未歸一，只作分組線索）。 */
  model: string | null;
}

// ─────────────────────────────────────────────────────────── 純邏輯

/** key 前 8 位。空／非字串 → null（缺 key 的請求不編一個假的出來）。 */
export function apiKeyPrefix(rawKey: string | null | undefined): string | null {
  if (typeof rawKey !== "string") return null;
  const trimmed = rawKey.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, API_REJECTION_KEY_PREFIX_CHARS);
}

/** 去掉 query（可能帶 token）與控制字元，再截斷。 */
function sanitize(value: string, max: number): string {
  return value
    .split("?")[0]
    // eslint-disable-next-line no-control-regex -- 遙測欄位不接受控制字元（防注入換行）
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, max);
}

/**
 * 把入口的原始輸入收成可落地的一行。形狀不合法（沒有 path 或 status 非整數）→ null，
 * 寧可少一行也不寫進無法解釋的髒資料。
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
 * 造一個記錄器。回傳的函式永不 throw、立即返回（不 await 儲存層）——
 * 遙測是旁路，客戶的請求不該為它多等一個 RTT。
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
      // 靜默：記不上就算了，绝不能影響請求本身。
    });
  };
}

// ─────────────────────────────────────────────────────────── Postgres

let schemaReady: Promise<void> | null = null;

async function ensureSchema(sql: GenerationSql): Promise<void> {
  if (!schemaReady) {
    // 與 db/migrations/029_api_rejection.sql 同一 DDL（幂等，首用即建）。
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

/** 僅供測試重置建表快取。 */
export function __resetApiRejectionSchemaForTests(): void {
  schemaReady = null;
}

// ─────────────────────────────────────────────────────────── 出口攔截

/**
 * 從回應體裡取穩定碼當 reason。
 *
 * 用 clone() 讀：原回應仍可被客戶端正常消費。取不到（非 JSON、body 已被讀走、
 * 上游返回 HTML）就退回 `http_<status>` —— 這一組百分點本身就是「非 JSON 拒絕」的訊號。
 */
export async function rejectionReasonFromResponse(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as unknown;
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    if (typeof code === "string" && code.trim()) return code.trim();
  } catch {
    // 落到下面的兜底碼。
  }
  return `http_${response.status}`;
}

/**
 * 出口攔截：唯一記錄點。
 *
 * 寫成包裝層而不是在每個 `return` 前面插一行，是因為「漏記一條出口」這件事
 * 沒有任何測試能事後發現 —— 把規則放在邊界上，新增出口自動被覆蓋。
 * 只記錄 `status >= 300`；成功與 202 任務提交不進這張表。
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

// ─────────────────────────────────────────────────────────── 生產入口

/**
 * 路由用的記錄器。控制面未開（本機／C 端 Vercel 直連）時是 no-op ——
 * 沒有資料庫就不假裝記了，也不讓呼叫端為此分支。
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