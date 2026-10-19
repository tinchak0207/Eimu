// 管理面配置变更的稽核纪录：channel-overrides / admin-pools 等每次写入都是一次
// 「全量替换」，Blob 世代虽然保留了旧内容物理档案，但没人能回答「谁、何时、改了
// 什么」，也没有读取/还原旧世代的入口。这里补上稽核表的读写，挂在既有的
// Postgres control-plane 连线（generation-core/database.ts）上——不新开一条连线。
//
// 版本号设计：channel-overrides.ts 的 version 是 Blob pathname（字串，例如
// "admin/channel-overrides.v1-<ts>-<rand>.json"），不是整数；但稽核表 schema
// （db/migrations/002_admin_config_audit.sql）要求 version 是 integer，方便排序与
// 「回滚到第 N 版」这种人类可读的操作。因此稽核表维护一条独立于 Blob pathname 的
// 单调递增整数序列（每个 config_key 各自从 1 起算），resolveNextConfigVersion 算出
// 下一个号码。这条序列只活在稽核表里，不影响 channel-overrides.ts 既有的并发控制
// （expectedVersion 仍然比对 Blob pathname，不受这里影响）。
//
// 铁则：稽核写入绝不能挡住 admin 的正常配置保存。Postgres 未配置，或查询失败，
// 都只记警告、直接放行——宁可漏记一笔稽核，不能让管理员连配置都存不进去。

import { randomUUID } from "node:crypto";
import { generationDatabaseConfigured, getGenerationSql, type GenerationSql } from "./generation-core/database";

export type ConfigChangeAction = "update" | "rollback";

export interface RecordConfigChangeInput {
  configKey: string;
  version: number;
  /** 呼叫端目前可取得的管理员身分；没有就传 null，落库时存成 'unknown'。 */
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
 * 浅层（仅顶层 key）diff：这些配置形状（channel-overrides / admin-pools）本身就是
 * 「id -> 小物件」的扁平字典，顶层 key 级别的 before/after 已足够让人看懂改了哪个
 * 渠道；不需要递回深比对。非物件输入视为空物件（不抛错）。
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

/** 解析要用的连线：测试/呼叫端可注入 sql；否则照 database.ts 的规则判断是否已配置。 */
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
 * 这个 config_key 目前稽核表里最大的整数版本号，没有任何纪录则回 0（下一版就是 1）。
 * 呼叫端（route.ts）决定自己要用哪个号码；这里只负责「查询+递增」的惯用组合，
 * 供呼叫端在不想自己管序列时使用。
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
 * 记一笔配置变更。绝不抛错：Postgres 未配置或查询失败都只记警告后直接返回——
 * 稽核纪录漏一笔，远比让管理员的配置保存失败要轻。
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

/** 某个 config_key 最近的变更纪录，新到旧排序。查询失败回空阵列（不抛错，稽核读取非关键路径）。 */
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

/** 某个 config_key 在特定版本号的完整快照；找不到（Postgres 未配置、版本不存在）回 null。 */
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
