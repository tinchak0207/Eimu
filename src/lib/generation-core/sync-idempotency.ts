/**
 * 同步路由（edits/upscale）的冪等性緩存。
 * 有 Postgres control plane 時持久化；否則退到進程內 Map（dev 用）。
 */
import { createHash } from "node:crypto";
import { generationDatabaseConfigured, getGenerationSql } from "./database";

export class SyncIdempotencyConflictError extends Error {
  constructor(message = "The Idempotency-Key was already used with a different request.") {
    super(message);
    this.name = "SyncIdempotencyConflictError";
  }
}

export function computeRequestHash(obj: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(obj, Object.keys(obj).sort())).digest("hex");
}

interface CachedEntry {
  status: number;
  body: unknown;
  requestHash: string;
  createdAt: number;
}

// 進程內兜底（dev / 無 DB）
const memCache = new Map<string, CachedEntry>();
const MEM_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function memKey(tenantId: string, idempotencyKey: string): string {
  return `${tenantId}::${idempotencyKey}`;
}

export async function checkOrReserveSyncIdempotency(input: {
  tenantId: string;
  idempotencyKey: string;
  requestHash: string;
}): Promise<{ cached: true; status: number; body: unknown } | { cached: false }> {
  // 進程內路徑（dev 或 DB 未配置）
  if (!generationDatabaseConfigured()) {
    const key = memKey(input.tenantId, input.idempotencyKey);
    const entry = memCache.get(key);
    if (entry) {
      if (Date.now() - entry.createdAt > MEM_TTL_MS) { memCache.delete(key); return { cached: false }; }
      if (entry.requestHash !== input.requestHash) throw new SyncIdempotencyConflictError();
      return { cached: true, status: entry.status, body: entry.body };
    }
    // 先佔位（空 body），完成後用 commitSyncIdempotency 寫真實結果
    memCache.set(key, { status: 0, body: null, requestHash: input.requestHash, createdAt: Date.now() });
    return { cached: false };
  }

  // Postgres 路徑
  const sql = getGenerationSql();
  // 確保表存在（idempotent DDL）
  await sql`
    CREATE TABLE IF NOT EXISTS sync_idempotency_cache (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      idem_key    TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status_code  INT,
      response_json TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, idem_key)
    )
  `;
  const rows = await sql<{ request_hash: string; status_code: number | null; response_json: string | null }[]>`
    INSERT INTO sync_idempotency_cache (id, tenant_id, idem_key, request_hash)
    VALUES (gen_random_uuid()::text, ${input.tenantId}, ${input.idempotencyKey}, ${input.requestHash})
    ON CONFLICT (tenant_id, idem_key) DO NOTHING
    RETURNING tenant_id
  `;
  if (rows.length > 0) return { cached: false }; // 成功插入新行，繼續處理

  // 已存在
  const existing = await sql<{ request_hash: string; status_code: number | null; response_json: string | null }[]>`
    SELECT request_hash, status_code, response_json FROM sync_idempotency_cache
    WHERE tenant_id = ${input.tenantId} AND idem_key = ${input.idempotencyKey}
    LIMIT 1
  `;
  if (!existing[0]) return { cached: false };
  if (existing[0].request_hash !== input.requestHash) throw new SyncIdempotencyConflictError();
  if (existing[0].status_code === null) return { cached: false }; // 仍在處理中
  return { cached: true, status: existing[0].status_code, body: JSON.parse(existing[0].response_json ?? "null") };
}

export async function commitSyncIdempotency(input: {
  tenantId: string;
  idempotencyKey: string;
  status: number;
  body: unknown;
}): Promise<void> {
  if (!generationDatabaseConfigured()) {
    const key = memKey(input.tenantId, input.idempotencyKey);
    const entry = memCache.get(key);
    if (entry) memCache.set(key, { ...entry, status: input.status, body: input.body });
    return;
  }
  const sql = getGenerationSql();
  await sql`
    UPDATE sync_idempotency_cache
    SET status_code = ${input.status}, response_json = ${JSON.stringify(input.body)}
    WHERE tenant_id = ${input.tenantId} AND idem_key = ${input.idempotencyKey}
  `;
}
