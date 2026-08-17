import { NextRequest, NextResponse } from "next/server";
import { runGenerationWorkerOnce } from "@/lib/generation-core/worker-service";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Generation worker cron：每分鐘執行一次，claim 待處理與過期任務、執行生成、處理失敗退款。
 * 
 * Vercel Cron 配置：vercel.json → "crons": [{"path": "/api/cron/generation-worker", "schedule": "* * * * *"}]
 * 
 * 授權：僅允許 Vercel Cron（x-vercel-cron-id header）或本地開發（localhost）。
 */
export async function GET(req: NextRequest) {
  // Vercel Cron 身份驗證
  const cronId = req.headers.get("x-vercel-cron-id");
  const host = req.headers.get("host") ?? "";
  const isLocalDev = host.includes("localhost") || host.includes("127.0.0.1");
  
  if (!cronId && !isLocalDev) {
    return NextResponse.json(
      { error: "Unauthorized: missing x-vercel-cron-id" },
      { status: 401 }
    );
  }

  // Control plane 未啟用時直接返回（不報錯，避免 cron 噪音）
  if (!generationControlPlaneEnabled()) {
    return NextResponse.json({
      ok: true,
      worker_enabled: false,
      message: "Generation control plane is not enabled (GENERATION_CONTROL_PLANE_ENABLED=true + GENERATION_DATABASE_URL required)."
    });
  }

  try {
    const processed = await runGenerationWorkerOnce({
      workerId: `cron-${cronId ?? "local"}`,
      jobLeaseMs: 5 * 60 * 1000, // 5 分鐘租約
      supplierLeaseMs: 2 * 60 * 1000, // 2 分鐘 supplier 租約
    });

    return NextResponse.json({
      ok: true,
      worker_enabled: true,
      processed,
      cron_id: cronId ?? "local",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[generation-worker-cron] execution failed", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
