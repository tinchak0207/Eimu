import { NextRequest, NextResponse } from "next/server";
import { runGenerationMaintenanceOnce, runGenerationWorkerOnce } from "@/lib/generation-core/worker-service";
import { runMapayOrderReconciliationOnce } from "@/lib/generation-core/mapay-order-reconciliation";
import { generationControlPlaneEnabled, getGenerationSql } from "@/lib/generation-core/database";
import { sweepMapayIntakeOnce, type MapayIntakeSweepResult } from "@/lib/mapay-intake";

export const runtime = "nodejs";
export const maxDuration = 60;
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

/**
 * Generation worker cron：每分钟执行一次，claim 待处理与过期任务、执行生成、处理失败退款。
 * 
 * Vercel Cron 配置：vercel.json → "crons": [{"path": "/api/cron/generation-worker", "schedule": "* * * * *"}]
 * 
 * 授权：仅允许 Vercel Cron（x-vercel-cron-id header）或本地开发（localhost）。
 */
export async function GET(req: NextRequest) {
  // Vercel Cron 身份验证
  const cronId = req.headers.get("x-vercel-cron-id");
  const host = req.headers.get("host") ?? "";
  const isLocalDev = host.includes("localhost") || host.includes("127.0.0.1");
  
  if (!cronId && !isLocalDev) {
    return NextResponse.json(
      { error: "Unauthorized: missing x-vercel-cron-id" },
      { status: 401 }
    );
  }

  // Control plane 未启用时直接返回（不报错，避免 cron 噪音）
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
      jobLeaseMs: 5 * 60 * 1000, // 5 分钟租约
      supplierLeaseMs: 2 * 60 * 1000, // 2 分钟 supplier 租约
    });

    // 维护闭环（租约回收/计费结算/INC-0831 provider 对帐/健康巡检）：
    // 长驻 worker 关停期间由 cron 每分钟补位，对帐不能只有一条心跳。
    let maintenance: { ok: true } | { ok: false; error: string };
    try {
      await runGenerationMaintenanceOnce({ workerId: `cron-${cronId ?? "local"}` });
      maintenance = { ok: true };
    } catch (maintenanceError) {
      // 维护失败不影响本轮派单结果；对帐下一分钟再试。
      console.error("[generation-worker-cron] maintenance failed（下一轮重试）", maintenanceError);
      maintenance = { ok: false, error: maintenanceError instanceof Error ? maintenanceError.message : String(maintenanceError) };
    }

    // 付款对帐（独立函式，B2）：用**支付商自己的资料**对帐「已付款 vs 已履约」，
    // 抓出我方帐本吞掉的实单（2026-09-19 IMGMU7UH9SFF9A21D 同族事故）。自带节流
    // （默认 30 分钟一次，MAPAY_RECONCILE_INTERVAL_MS 可调）⇒ 不与其他 sweep 抢程式码、
    // 也不每分钟打爆支付商 API。只读；失败只记日志，不挡本轮派单回报。
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
      console.error("[generation-worker-cron] mapay order reconciliation failed（下一轮重试）", reconcileError);
      mapayReconciliation = {
        ok: false,
        error: reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
      };
    }

    // mPay 落地存证自愈（A2）：挑 state='received' 且落地超过 10 分钟的 intake 行，
    // 用既有幂等路径重投履约（bound→直达入帐；未绑→兑换码；席位→席位通道）。
    // 不新建 scheduler：复用本 cron 每分钟心跳。失败只记日志，不挡本轮派单回报。
    let mapayIntakeSweep: MapayIntakeSweepResult | { ok: false; error: string };
    try {
      mapayIntakeSweep = await sweepMapayIntakeOnce(getGenerationSql());
    } catch (sweepError) {
      console.error("[generation-worker-cron] mapay intake sweep failed（下一轮重试）", sweepError);
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
