import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { normalizePoolDraft, summarizeEnvironmentEndpoints, toPublicAdminPool, type AdminPool } from "@/lib/admin-pools";
import { readAdminPools, writeAdminPools } from "@/lib/admin-pool-store";
import { requireAdminSession } from "@/lib/admin-session";
import { buildGatewayEndpoints } from "@/lib/sub2api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : "保存失败。";
  return NextResponse.json({ success: false, message }, { status: 400 });
}

export async function GET() {
  try {
    await requireAdminSession();
    const pools = await readAdminPools();
    return NextResponse.json({
      success: true,
      data: {
        pools: pools.map(toPublicAdminPool),
        environment: summarizeEnvironmentEndpoints(buildGatewayEndpoints(process.env)),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdminSession();
    const current = await readAdminPools();
    if (current.length >= 12) throw new Error("最多维护 12 个渠道。");
    const draft = normalizePoolDraft(await req.json() as Record<string, unknown>);
    const now = Date.now();
    const pool: AdminPool = { id: randomUUID(), ...draft, createdAt: now, updatedAt: now };
    await writeAdminPools([...current, pool]);
    return NextResponse.json({ success: true, data: toPublicAdminPool(pool) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
