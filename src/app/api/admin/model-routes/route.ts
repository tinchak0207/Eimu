// /admin「模型路由」：控面调度顺序的唯一后台入口（2026-10-01 路由收口）。
//
// GET    → 每个模型的生效路由（程式码预设 ⊕ 热覆写）＋每一步的即时供给状态
// PUT    → { modelId, route: string[], note? } 写热覆写，立即生效、不需部署
// DELETE → ?modelId=… 清除覆写，回到 MODEL_ROUTES 预设
//
// 只在控面执行（control-plane-proxy-routes 代理过去）：要读写 model_route_override 与 supplier 表。

import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { getGenerationSql } from "@/lib/generation-core/database";
import {
  clearModelRouteOverride,
  listEffectiveRoutes,
  normalizeRouteInput,
  setModelRouteOverride,
} from "@/lib/generation-core/model-routing";
import { GENERATION_MODEL_CATALOG } from "@/lib/generation-model-catalog";
import { modelBaseName } from "@/lib/provider-config";
import { routeSupplierId } from "@/lib/model-routes.config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StepState = "ok" | "degraded" | "cooldown" | "disabled" | "no_capability" | "missing";

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : fallback;
  return NextResponse.json({ success: false, message }, { status: 500 });
}

async function loadSupplierState() {
  const sql = getGenerationSql();
  const suppliers = await sql<Record<string, unknown>[]>`
    SELECT id, label, adapter_type, enabled, health_status, cooldown_until FROM supplier ORDER BY id
  `;
  const claims = await sql<Record<string, unknown>[]>`
    SELECT DISTINCT supplier_id, public_model_id FROM supplier_capability WHERE is_current AND enabled
  `;
  return {
    suppliers: new Map(suppliers.map((row) => [String(row.id), row])),
    claims: new Set(claims.map((row) => `${String(row.supplier_id)} ${String(row.public_model_id)}`)),
  };
}

function stepState(
  supplier: Record<string, unknown> | undefined,
  hasClaim: boolean,
): StepState {
  if (!supplier) return "missing";
  if (!supplier.enabled || supplier.health_status === "disabled") return "disabled";
  if (!hasClaim) return "no_capability";
  const cooldownUntil = supplier.cooldown_until ? new Date(String(supplier.cooldown_until)).getTime() : 0;
  if (cooldownUntil > Date.now()) return "cooldown";
  return supplier.health_status === "degraded" ? "degraded" : "ok";
}

export async function GET() {
  try {
    await requireAdminSession();
    const [{ routes }, state] = await Promise.all([listEffectiveRoutes(), loadSupplierState()]);
    const payload = routes.map((route) => {
      const model = GENERATION_MODEL_CATALOG[route.modelId];
      return {
        modelId: route.modelId,
        modelName: model ? modelBaseName(route.modelId) : route.modelId,
        kind: model?.kind ?? "unknown",
        source: route.source,
        labels: route.labels,
        configLabels: route.configLabels,
        override: route.override,
        steps: route.labels.map((label) => {
          const supplierId = routeSupplierId(label);
          return {
            label,
            supplierId,
            state: stepState(state.suppliers.get(supplierId), state.claims.has(`${supplierId} ${route.modelId}`)),
          };
        }),
      };
    });
    const channels = [...state.suppliers.values()]
      .filter((row) => String(row.id).startsWith("env:"))
      .map((row) => ({
        label: String(row.id).slice("env:".length),
        enabled: Boolean(row.enabled),
        healthStatus: String(row.health_status),
        adapterType: String(row.adapter_type),
      }));
    return NextResponse.json({ success: true, data: { routes: payload, channels } });
  } catch (error) {
    return errorResponse(error, "读取模型路由失败。");
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await requireAdminSession();
    const body = (await req.json().catch(() => null)) as { modelId?: unknown; route?: unknown; note?: unknown } | null;
    const modelId = typeof body?.modelId === "string" ? body.modelId.trim() : "";
    if (!modelId) return NextResponse.json({ success: false, message: "缺少 modelId。" }, { status: 400 });
    let route: string[];
    try {
      route = normalizeRouteInput(body?.route);
    } catch (error) {
      return NextResponse.json({ success: false, message: (error as Error).message }, { status: 400 });
    }
    // 只接受 DB 里真实存在的渠道——打错字的 label 会让那一步永远选不中，必须当场拒收。
    const { suppliers } = await loadSupplierState();
    const unknown = route.filter((label) => !suppliers.has(routeSupplierId(label)));
    if (unknown.length) {
      return NextResponse.json({ success: false, message: `未知渠道：${unknown.join("、")}` }, { status: 400 });
    }
    await setModelRouteOverride({
      modelId,
      route,
      note: typeof body?.note === "string" ? body.note.slice(0, 500) : null,
      updatedBy: session.username,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, "保存模型路由失败。");
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireAdminSession();
    const modelId = req.nextUrl.searchParams.get("modelId")?.trim() ?? "";
    if (!modelId) return NextResponse.json({ success: false, message: "缺少 modelId。" }, { status: 400 });
    await clearModelRouteOverride(modelId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, "清除模型路由覆写失败。");
  }
}
