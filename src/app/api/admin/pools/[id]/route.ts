import { NextRequest, NextResponse } from "next/server";
import { normalizePoolDraft, toPublicAdminPool } from "@/lib/admin-pools";
import { readAdminPools, writeAdminPools } from "@/lib/admin-pool-store";
import { requireAdminSession } from "@/lib/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

type RouteContext = { params: Promise<{ id: string }> };

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : "操作失败。";
  return NextResponse.json({ success: false, message }, { status: message === "渠道不存在。" ? 404 : 400 });
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    await requireAdminSession();
    const { id } = await context.params;
    const pools = await readAdminPools();
    const index = pools.findIndex((pool) => pool.id === id);
    if (index < 0) throw new Error("渠道不存在。");
    const draft = normalizePoolDraft(await req.json() as Record<string, unknown>, pools[index].apiKey);
    const updated = { ...pools[index], ...draft, updatedAt: Date.now() };
    pools[index] = updated;
    await writeAdminPools(pools);
    return NextResponse.json({ success: true, data: toPublicAdminPool(updated) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_req: NextRequest, context: RouteContext) {
  try {
    await requireAdminSession();
    const { id } = await context.params;
    const pools = await readAdminPools();
    if (!pools.some((pool) => pool.id === id)) throw new Error("渠道不存在。");
    await writeAdminPools(pools.filter((pool) => pool.id !== id));
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}
