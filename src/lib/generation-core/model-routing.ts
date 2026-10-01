// 生效路由解析：程式碼預設（MODEL_ROUTES）⊕ admin 熱覆寫（model_route_override 表）。
//
// 調度器（acquireSupplierLease）、提交前能力檢查（hasGenerationCapability）、
// 無供給診斷（diagnoseSupplierUnavailability）與 /admin「模型路由」面板全部經
// resolveModelRoute 取同一份結果——輸入相同則輸出相同，後台看到的就是調度實際用的。

import { MODEL_ROUTES, modelRoute, routeSupplierId } from "../model-routes.config";
import { getGenerationSql, type GenerationSql } from "./database";

export type ModelRouteSource = "config" | "override";

export interface EffectiveModelRoute {
  modelId: string;
  source: ModelRouteSource;
  /** 有序渠道 label。 */
  labels: string[];
  /** 對應 DB supplier id，順序同 labels。 */
  supplierIds: string[];
}

export interface ModelRouteOverrideRow {
  modelId: string;
  route: string[];
  note: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

/** 覆寫是人手速度的變更，熱路徑上只需短快取；寫入路徑會主動清快取。 */
const OVERRIDE_CACHE_MS = 5_000;
let overrideCache: { at: number; rows: Map<string, ModelRouteOverrideRow> } | null = null;

export function __resetModelRouteCacheForTests(): void {
  overrideCache = null;
}

function mapOverride(row: Record<string, unknown>): ModelRouteOverrideRow {
  return {
    modelId: String(row.model_id),
    route: Array.isArray(row.route) ? row.route.map(String) : [],
    note: row.note === null || row.note === undefined ? null : String(row.note),
    updatedBy: row.updated_by === null || row.updated_by === undefined ? null : String(row.updated_by),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export async function loadModelRouteOverrides(
  sql: GenerationSql = getGenerationSql(),
  { fresh = false }: { fresh?: boolean } = {},
): Promise<Map<string, ModelRouteOverrideRow>> {
  if (!fresh && overrideCache && Date.now() - overrideCache.at < OVERRIDE_CACHE_MS) return overrideCache.rows;
  let rows: Record<string, unknown>[];
  try {
    rows = await sql<Record<string, unknown>[]>`
      SELECT model_id, route, note, updated_by, updated_at FROM model_route_override
    `;
  } catch (error) {
    // 覆寫表讀不到（遷移未跑／DB 抖動）時退回程式碼預設路由，絕不因覆寫層故障擋住調度。
    // 面板讀取（fresh）要如實報錯，不吞。
    if (fresh) throw error;
    console.warn("[model-routing] model_route_override 讀取失敗，退回 MODEL_ROUTES 預設：", error);
    return overrideCache?.rows ?? new Map();
  }
  const map = new Map(rows.map((row) => {
    const mapped = mapOverride(row);
    return [mapped.modelId, mapped] as const;
  }));
  overrideCache = { at: Date.now(), rows: map };
  return map;
}

export function effectiveRoute(
  modelId: string,
  overrides: Map<string, ModelRouteOverrideRow>,
): EffectiveModelRoute {
  const override = overrides.get(modelId);
  const labels = override ? [...override.route] : [...modelRoute(modelId)];
  return {
    modelId,
    source: override ? "override" : "config",
    labels,
    supplierIds: labels.map(routeSupplierId),
  };
}

export async function resolveModelRoute(
  modelId: string,
  sql: GenerationSql = getGenerationSql(),
): Promise<EffectiveModelRoute> {
  return effectiveRoute(modelId, await loadModelRouteOverrides(sql));
}

/** 全部有路由（預設或覆寫）的模型，供 admin 面板列出。 */
export async function listEffectiveRoutes(sql: GenerationSql = getGenerationSql()): Promise<{
  routes: Array<EffectiveModelRoute & { configLabels: string[]; override: ModelRouteOverrideRow | null }>;
}> {
  const overrides = await loadModelRouteOverrides(sql, { fresh: true });
  const modelIds = [...new Set([...Object.keys(MODEL_ROUTES), ...overrides.keys()])];
  return {
    routes: modelIds.map((modelId) => ({
      ...effectiveRoute(modelId, overrides),
      configLabels: [...modelRoute(modelId)],
      override: overrides.get(modelId) ?? null,
    })),
  };
}

const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizeRouteInput(route: unknown): string[] {
  if (!Array.isArray(route)) throw new Error("route 必須是渠道 label 陣列。");
  const labels = route.map((item) => String(item).trim());
  for (const label of labels) {
    if (!LABEL_PATTERN.test(label)) throw new Error(`非法渠道 label：${label || "(空)"}`);
  }
  if (new Set(labels).size !== labels.length) throw new Error("route 內有重複渠道。");
  return labels;
}

export async function setModelRouteOverride(input: {
  modelId: string;
  route: string[];
  note?: string | null;
  updatedBy?: string | null;
}, sql: GenerationSql = getGenerationSql()): Promise<void> {
  await sql`
    INSERT INTO model_route_override (model_id, route, note, updated_by, updated_at)
    VALUES (${input.modelId}, ${input.route}::text[], ${input.note ?? null}, ${input.updatedBy ?? null}, now())
    ON CONFLICT (model_id) DO UPDATE SET
      route = EXCLUDED.route, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
  `;
  overrideCache = null;
}

export async function clearModelRouteOverride(modelId: string, sql: GenerationSql = getGenerationSql()): Promise<void> {
  await sql`DELETE FROM model_route_override WHERE model_id = ${modelId}`;
  overrideCache = null;
}
