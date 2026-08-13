// GET /api/admin/control-plane-diagnostics — 一次看穿四层。
//
// 采集逻辑在 src/lib/control-plane-diagnostics.ts；这里只做会话校验、
// 把控制面那一半通过签名通道取回来，再合并出结论。
//
// 为什么不直接把这个路由 rewrite 到控制面：控制面上没有 ADMIN_SESSION_SECRET
// （Vercel 上那个值被标记为 sensitive，连 CLI 都读不回来），
// requireAdminSession() 在那边必然 401。所以会话留在 Vercel，
// 数据库那一半走 HMAC 通道去取。

import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import {
  gatherLocalDiagnostics,
  summarizeProblems,
  type LocalDiagnostics,
} from "@/lib/control-plane-diagnostics";
import { bizKeySyncConfig, invokeBizKeySync } from "@/lib/biz-key-sync";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function probe(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    return { ok: response.ok, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "请求失败" };
  }
}

export async function GET() {
  try {
    await requireAdminSession();
  } catch {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }

  const local = await gatherLocalDiagnostics();
  const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/$/, "") ?? null;

  // 本实例就是控制面时不必再绕一圈。
  let controlPlane: LocalDiagnostics | null = generationControlPlaneEnabled() ? local : null;
  let reachability: { ok: boolean; detail: string } | null = null;

  if (!generationControlPlaneEnabled() && origin) {
    reachability = await probe(`${origin}/image-control/api/healthz`);
    const sync = bizKeySyncConfig();
    if (sync) {
      try {
        controlPlane = await invokeBizKeySync({ op: "diagnostics" }, sync) as LocalDiagnostics;
      } catch (error) {
        console.error("[diagnostics] 取控制面诊断失败。", error);
      }
    }
  }

  return NextResponse.json({
    success: true,
    checkedAt: new Date().toISOString(),
    local,
    controlPlane,
    reachability,
    problems: summarizeProblems({ local, controlPlane, controlPlaneReachable: reachability }),
  });
}
