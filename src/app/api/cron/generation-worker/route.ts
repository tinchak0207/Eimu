import { NextRequest, NextResponse } from "next/server";
import { runGenerationMaintenanceOnce, runGenerationWorkerOnce } from "@/lib/generation-core/worker-service";
import { runMapayOrderReconciliationOnce } from "@/lib/generation-core/mapay-order-reconciliation";
import { generationControlPlaneEnabled, getGenerationSql } from "@/lib/generation-core/database";
import { sweepMapayIntakeOnce, type MapayIntakeSweepResult } from "@/lib/mapay-intake";

export const runtime = "nodejs";
export const maxDuration = 60;
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

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

    // 維護閉環（租約回收/計費結算/INC-0831 provider 對帳/健康巡檢）：
    // 長駐 worker 關停期間由 cron 每分鐘補位，對帳不能只有一條心跳。
    let maintenance: { ok: true } | { ok: false; error: string };
    try {
      await runGenerationMaintenanceOnce({ workerId: `cron-${cronId ?? "local"}` });
      maintenance = { ok: true };
    } catch (maintenanceError) {
      // 維護失敗不影響本輪派單結果；對帳下一分鐘再試。
      console.error("[generation-worker-cron] maintenance failed（下一輪重試）", maintenanceError);
      maintenance = { ok: false, error: maintenanceError instanceof Error ? maintenanceError.message : String(maintenanceError) };
    }

    // 付款對帳（獨立函式，B2）：用**支付商自己的資料**對帳「已付款 vs 已履約」，
    // 抓出我方帳本吞掉的實單（2026-09-19 IMGMU7UH9SFF9A21D 同族事故）。自帶節流
    // （默認 30 分鐘一次，MAPAY_RECONCILE_INTERVAL_MS 可調）⇒ 不與其他 sweep 搶程式碼、
    // 也不每分鐘打爆支付商 API。只讀；失敗只記日誌，不擋本輪派單回報。
    let mapayReconciliation: Record<string, unknown>;
    try {
      const report = await runMapayOrderReconciliationOnce();
      mapayReconciliation = report
        ? {
            ok: true,
            checked: report.checked,
            fulfilled: report.fulfilled,
            paid_unfulfilled: report.paidUnfulfilled.length,
            unknown: report.unknown.length,
          }
        : { ok: true, skipped: "interval_or_unconfigured" };
    } catch (reconcileError) {
      console.error("[generation-worker-cron] mapay order reconciliation failed（下一輪重試）", reconcileError);
      mapayReconciliation = {
        ok: false,
        error: reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
      };
    }

    // mPay 落地存證自癒（A2）：挑 state='received' 且落地超過 10 分鐘的 intake 行，
    // 用既有冪等路径重投履约（bound→直達入帳；未綁→兌換碼；席位→席位通道）。
    // 不新建 scheduler：复用本 cron 每分鐘心跳。失敗只記日誌，不擋本輪派單回報。
    let mapayIntakeSweep: MapayIntakeSweepResult | { ok: false; error: string };
    try {
      mapayIntakeSweep = await sweepMapayIntakeOnce(getGenerationSql());
    } catch (sweepError) {
      console.error("[generation-worker-cron] mapay intake sweep failed（下一輪重試）", sweepError);
      mapayIntakeSweep = {
        ok: false,
        error: sweepError instanceof Error ? sweepError.message : String(sweepError),
      };
    }

    return NextResponse.json({
      ok: true,
      worker_enabled: true,
      processed,
      maintenance,
      mapay_reconciliation: mapayReconciliation,
      mapay_intake_sweep: mapayIntakeSweep,
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
