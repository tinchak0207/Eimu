import { getGenerationSql } from "@/lib/generation-core/database";

// ─────────────────────────── Postgres 路径（未启用）

/** 探测 Postgres 是否可用（沿用基底：getGenerationSql 抛错即视为不可用）。 */
function dbAvailable(): boolean {
  try {
    getGenerationSql();
    return true;
  } catch {
    return false;
  }
}

/** 诊断用：本进程是否探测到 Postgres。写入一律 blob/Map（契约 §0）。 */
export function memoryStoreDbBackendAvailable(): boolean {
  return dbAvailable();
}
