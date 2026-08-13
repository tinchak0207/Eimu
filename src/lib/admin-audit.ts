// 管理面配置變更的稽核紀錄：channel-overrides / admin-pools 等每次寫入都是一次
// 「全量替換」，Blob 世代雖然保留了舊內容物理檔案，但沒人能回答「誰、何時、改了
// 什麼」，也沒有讀取/還原舊世代的入口。這裡補上稽核表的讀寫，掛在既有的
// Postgres control-plane 連線（generation-core/database.ts）上——不新開一條連線。
//
// 版本號設計：channel-overrides.ts 的 version 是 Blob pathname（字串，例如
// "admin/channel-overrides.v1-<ts>-<rand>.json"），不是整數；但稽核表 schema
// （db/migrations/002_admin_config_audit.sql）要求 version 是 integer，方便排序與
// 「回滾到第 N 版」這種人類可讀的操作。因此稽核表維護一條獨立於 Blob pathname 的
// 單調遞增整數序列（每個 config_key 各自從 1 起算），resolveNextConfigVersion 算出
// 下一個號碼。這條序列只活在稽核表裡，不影響 channel-overrides.ts 既有的並發控制
// （expectedVersion 仍然比對 Blob pathname，不受這裡影響）。
//
// 鐵則：稽核寫入絕不能擋住 admin 的正常配置保存。Postgres 未配置，或查詢失敗，
// 都只記警告、直接放行——寧可漏記一筆稽核，不能讓管理員連配置都存不進去。

import { randomUUID } from "node:crypto";
import { generationDatabaseConfigured, getGenerationSql, type GenerationSql } from "./generation-core/database";

export type ConfigChangeAction = "update" | "rollback";

export interface RecordConfigChangeInput {
  configKey: string;
  version: number;
  /** 呼叫端目前可取得的管理員身分；沒有就傳 null，落庫時存成 'unknown'。 */
  actor: string | null;
  action: ConfigChangeAction;
  previousVersion: number | null;
  diff: unknown;
  fullSnapshot: unknown;
}

export interface ConfigChangeRecord {
  id: string;
  configKey: string;
  version: number;
  actor: string;
  action: ConfigChangeAction;
  previousVersion: number | null;
  diff: unknown;
  fullSnapshot: unknown;
  createdAt: Date;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 淺層（僅頂層 key）diff：這些配置形狀（channel-overrides / admin-pools）本身就是
 * 「id -> 小物件」的扁平字典，頂層 key 級別的 before/after 已足夠讓人看懂改了哪個
 * 渠道；不需要遞迴深比對。非物件輸入視為空物件（不拋錯）。
 */
export function diffJson(before: unknown, after: unknown): Record<string, { before: unknown; after: unknown }> {
  const beforeObj = isPlainObject(before) ? before : {};
  const afterObj = isPlainObject(after) ? after : {};
  const keys = new Set<string>([...Object.keys(beforeObj), ...Object.keys(afterObj)]);

  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of keys) {
    const b = beforeObj[key];
    const a = afterObj[key];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      diff[key] = { before: b, after: a };
    }
  }
  return diff;
}

/** 解析要用的連線：測試/呼叫端可注入 sql；否則照 database.ts 的規則判斷是否已配置。 */
function resolveSql(sql?: GenerationSql): GenerationSql | null {
  if (sql) return sql;
  if (!generationDatabaseConfigured()) return null;
  return getGenerationSql();
}

function mapRow(row: Record<string, unknown>): ConfigChangeRecord {
  return {
    id: String(row.id),
    configKey: String(row.config_key),
    version: Number(row.version),
    actor: row.actor === null || row.actor === undefined ? "unknown" : String(row.actor),
    action: row.action as ConfigChangeAction,
    previousVersion:
      row.previous_version === null || row.previous_version === undefined ? null : Number(row.previous_version),
    diff: row.diff_json,
    fullSnapshot: row.full_snapshot_json,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  };
}

/**
 * 這個 config_key 目前稽核表裡最大的整數版本號，沒有任何紀錄則回 0（下一版就是 1）。
 * 呼叫端（route.ts）決定自己要用哪個號碼；這裡只負責「查詢+遞增」的慣用組合，
 * 供呼叫端在不想自己管序列時使用。
 */
export async function nextConfigVersion(configKey: string, sql?: GenerationSql): Promise<number> {
  const client = resolveSql(sql);
  if (!client) return 1;
  try {
    const rows = await client<{ max: number | null }[]>`
      SELECT MAX(version) AS max FROM admin_config_change WHERE config_key = ${configKey}
    `;
    const max = rows[0]?.max;
    return (typeof max === "number" ? max : 0) + 1;
  } catch (error) {
    console.warn("[admin-audit] Failed to resolve next config version; defaulting to 1.", error);
    return 1;
  }
}

/**
 * 記一筆配置變更。絕不拋錯：Postgres 未配置或查詢失敗都只記警告後直接返回——
 * 稽核紀錄漏一筆，遠比讓管理員的配置保存失敗要輕。
 */
export async function recordConfigChange(input: RecordConfigChangeInput, sql?: GenerationSql): Promise<void> {
  const client = resolveSql(sql);
  if (!client) {
    console.warn(
      `[admin-audit] Postgres control plane not configured; skipping audit record for '${input.configKey}' v${input.version}.`,
    );
    return;
  }

  try {
    const id = randomUUID();
    const actor = input.actor && input.actor.trim() ? input.actor.trim() : "unknown";
    await client`
      INSERT INTO admin_config_change (
        id, config_key, version, actor, action, previous_version, diff_json, full_snapshot_json
      ) VALUES (
        ${id},
        ${input.configKey},
        ${input.version},
        ${actor},
        ${input.action},
        ${input.previousVersion},
        ${JSON.stringify(input.diff ?? {})},
        ${JSON.stringify(input.fullSnapshot ?? null)}
      )
    `;
  } catch (error) {
    console.warn(
      `[admin-audit] Failed to record config change for '${input.configKey}' v${input.version}; continuing without audit entry.`,
      error,
    );
  }
}

/** 某個 config_key 最近的變更紀錄，新到舊排序。查詢失敗回空陣列（不拋錯，稽核讀取非關鍵路徑）。 */
export async function listConfigChanges(
  configKey: string,
  limit: number,
  sql?: GenerationSql,
): Promise<ConfigChangeRecord[]> {
  const client = resolveSql(sql);
  if (!client) return [];

  try {
    const rows = await client<Record<string, unknown>[]>`
      SELECT * FROM admin_config_change
      WHERE config_key = ${configKey}
      ORDER BY version DESC
      LIMIT ${limit}
    `;
    return rows.map(mapRow);
  } catch (error) {
    console.warn(`[admin-audit] Failed to list config changes for '${configKey}'.`, error);
    return [];
  }
}

/** 某個 config_key 在特定版本號的完整快照；找不到（Postgres 未配置、版本不存在）回 null。 */
export async function getConfigChangeSnapshot(
  configKey: string,
  version: number,
  sql?: GenerationSql,
): Promise<unknown | null> {
  const client = resolveSql(sql);
  if (!client) return null;

  try {
    const rows = await client<{ full_snapshot_json: unknown }[]>`
      SELECT full_snapshot_json FROM admin_config_change
      WHERE config_key = ${configKey} AND version = ${version}
      LIMIT 1
    `;
    return rows[0] ? rows[0].full_snapshot_json : null;
  } catch (error) {
    console.warn(`[admin-audit] Failed to fetch config change snapshot for '${configKey}' v${version}.`, error);
    return null;
  }
}
