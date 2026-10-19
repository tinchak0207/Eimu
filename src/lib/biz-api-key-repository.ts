// B 端密钥的 Postgres 存取层。
//
// 这一层存在的理由见 db/migrations/007_biz_api_key.sql：Blob 被 block 时
// 认证整条瘫痪，且签发与认证两侧数据源分叉。Postgres 成为权威源后，
// Blob 退为镜像、env 退为最后兜底。
//
// 所有函数在 GENERATION_DATABASE_URL 未配置时返回 null/false，让调用方
// 走原有的 Blob 路径 —— C 端 Vercel 部署没有这个库，不能因此炸掉。

import { generationControlPlaneEnabled, getGenerationSql } from "./generation-core/database";
import type { BizApiKey } from "./biz-api-keys";

type Row = {
  id: string;
  label: string;
  key_hash: string;
  key_preview: string;
  user_id: number;
  enabled: boolean;
  rpm: number;
  allowed_models: string[];
  created_at: Date;
  last_used_at: Date | null;
  total_requests: string | number;
  total_images: string | number;
};

/** Postgres 可用作权威源吗。 */
export function bizKeyDatabaseEnabled(): boolean {
  return generationControlPlaneEnabled();
}

function mapRow(row: Row): BizApiKey {
  return {
    id: row.id,
    label: row.label,
    keyHash: row.key_hash,
    keyPreview: row.key_preview,
    userId: Number(row.user_id),
    enabled: row.enabled !== false,
    rpm: Number(row.rpm) > 0 ? Number(row.rpm) : 60,
    allowedModels: Array.isArray(row.allowed_models) ? row.allowed_models : [],
    createdAt: row.created_at ? new Date(row.created_at).getTime() : 0,
    ...(row.last_used_at ? { lastUsedAt: new Date(row.last_used_at).getTime() } : {}),
    totalRequests: Number(row.total_requests ?? 0),
    totalImages: Number(row.total_images ?? 0),
  };
}

export async function listBizKeysFromDatabase(): Promise<BizApiKey[] | null> {
  if (!bizKeyDatabaseEnabled()) return null;
  const rows = await getGenerationSql()<Row[]>`
    SELECT id, label, key_hash, key_preview, user_id, enabled, rpm, allowed_models,
      created_at, last_used_at, total_requests, total_images
    FROM biz_api_key
    ORDER BY created_at DESC
  `;
  return rows.map(mapRow);
}

/**
 * 按 hash 查单把 key。
 *
 * 认证热路径专用：只取一行，不把整张表拉进内存。停用的 key 也要返回 ——
 * 调用方需要区分「不存在」（401）与「已停用」（403）。
 */
export async function findBizKeyByHash(keyHash: string): Promise<BizApiKey | null> {
  if (!bizKeyDatabaseEnabled()) return null;
  const rows = await getGenerationSql()<Row[]>`
    SELECT id, label, key_hash, key_preview, user_id, enabled, rpm, allowed_models,
      created_at, last_used_at, total_requests, total_images
    FROM biz_api_key
    WHERE key_hash = ${keyHash.toLowerCase()}
    LIMIT 1
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function insertBizKeyIntoDatabase(record: BizApiKey): Promise<boolean> {
  if (!bizKeyDatabaseEnabled()) return false;
  await getGenerationSql()`
    INSERT INTO biz_api_key (
      id, label, key_hash, key_preview, user_id, enabled, rpm, allowed_models, created_at
    ) VALUES (
      ${record.id}, ${record.label}, ${record.keyHash.toLowerCase()}, ${record.keyPreview},
      ${record.userId}, ${record.enabled}, ${record.rpm}, ${record.allowedModels},
      ${new Date(record.createdAt || Date.now())}
    )
    ON CONFLICT (id) DO UPDATE SET
      label = EXCLUDED.label, key_preview = EXCLUDED.key_preview, user_id = EXCLUDED.user_id,
      enabled = EXCLUDED.enabled, rpm = EXCLUDED.rpm, allowed_models = EXCLUDED.allowed_models,
      updated_at = now()
  `;
  return true;
}

export async function updateBizKeyInDatabase(
  id: string,
  patch: Partial<Pick<BizApiKey, "label" | "enabled" | "rpm" | "allowedModels" | "userId">>,
): Promise<BizApiKey | null> {
  if (!bizKeyDatabaseEnabled()) return null;
  const rows = await getGenerationSql()<Row[]>`
    UPDATE biz_api_key SET
      label = COALESCE(${patch.label ?? null}, label),
      enabled = COALESCE(${patch.enabled ?? null}, enabled),
      rpm = COALESCE(${patch.rpm ?? null}, rpm),
      allowed_models = COALESCE(${patch.allowedModels ?? null}, allowed_models),
      user_id = COALESCE(${patch.userId ?? null}, user_id),
      updated_at = now()
    WHERE id = ${id}
    RETURNING id, label, key_hash, key_preview, user_id, enabled, rpm, allowed_models,
      created_at, last_used_at, total_requests, total_images
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function deleteBizKeyFromDatabase(id: string): Promise<boolean> {
  if (!bizKeyDatabaseEnabled()) return false;
  const rows = await getGenerationSql()<{ id: string }[]>`
    DELETE FROM biz_api_key WHERE id = ${id} RETURNING id
  `;
  return rows.length > 0;
}

/**
 * 用量累加。
 *
 * 用 SQL 自增而不是读改写：多个 control plane 实例同时 flush 时，
 * 读改写会互相盖掉计数。
 */
export async function accumulateBizKeyUsageInDatabase(
  usage: Map<string, { requests: number; images: number; lastUsedAt: number }>,
): Promise<boolean> {
  if (!bizKeyDatabaseEnabled() || !usage.size) return false;
  const sql = getGenerationSql();
  for (const [id, value] of usage) {
    await sql`
      UPDATE biz_api_key SET
        total_requests = total_requests + ${value.requests},
        total_images = total_images + ${value.images},
        last_used_at = GREATEST(COALESCE(last_used_at, to_timestamp(0)), ${new Date(value.lastUsedAt)}),
        updated_at = now()
      WHERE id = ${id}
    `;
  }
  return true;
}

/**
 * 把外部来源的 key 收进 Postgres（env 兜底行、Blob 旧索引）。
 *
 * 应急流程原本是「手动加 env hash + 重启容器」，加完就永久停在 env 里：
 * 之后 admin 面板看不到它、改不了它、也不知道它还在生效。开机时同步一次，
 * env 与 Blob 就退化成「一次性导入通道」，而不是永久的第二、第三份数据源。
 *
 * 冲突一律 DO NOTHING：Postgres 里的记录是权威的，且它比 env 那行更完整
 * （有 label、rpm、allowedModels、用量计数）。不带 conflict target 是故意的 ——
 * id 与 key_hash 两个唯一约束都要覆盖，否则 id 撞车会直接抛错中断导入。
 */
export async function importBizKeysIntoDatabase(keys: BizApiKey[]): Promise<number> {
  if (!bizKeyDatabaseEnabled() || !keys.length) return 0;
  const sql = getGenerationSql();
  let imported = 0;
  for (const key of keys) {
    if (!/^[0-9a-f]{64}$/.test(key.keyHash.toLowerCase())) continue;
    const rows = await sql<{ id: string }[]>`
      INSERT INTO biz_api_key (
        id, label, key_hash, key_preview, user_id, enabled, rpm, allowed_models,
        created_at, last_used_at, total_requests, total_images
      ) VALUES (
        ${key.id}, ${key.label}, ${key.keyHash.toLowerCase()}, ${key.keyPreview},
        ${key.userId}, ${key.enabled}, ${key.rpm}, ${key.allowedModels},
        ${key.createdAt ? new Date(key.createdAt) : new Date()},
        ${key.lastUsedAt ? new Date(key.lastUsedAt) : null},
        ${key.totalRequests || 0}, ${key.totalImages || 0}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    if (rows.length) imported += 1;
  }
  return imported;
}
