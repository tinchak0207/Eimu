import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { runGenerationMaintenanceOnce, runGenerationWorkerOnce } from "@/lib/generation-core/worker-service";
import { runMapayOrderReconciliationOnce } from "@/lib/generation-core/mapay-order-reconciliation";
import { generationControlPlaneEnabled, getGenerationSql } from "@/lib/generation-core/database";
import { sweepMapayIntakeOnce, type MapayIntakeSweepResult } from "@/lib/mapay-intake";

export const runtime = "nodejs";
export const maxDuration = 60;
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

/** 配置的 cron 密钥（trim 后）；未配置＝空字串。 */
function cronSecret(): string {
  return (process.env.CRON_SECRET ?? "").trim();
}

/**
 * 常数时间比对（写法照 src/app/api/admin/image-upstream-probe/route.ts 的既有先例）。
 * 任一为空或长度不等一律不匹配——绝不只看「头存在」。
 */
function secretEquals(provided: string, expected: string): boolean {
  if (!provided || !expected || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

type CronAuthResult = { ok: true; label: string } | { ok: false; status: number; error: string };

/**
 * cron 鉴权（fail-closed）：
 * - 生产：`Authorization: Bearer <CRON_SECRET>`（Vercel Cron 的官方形态；设了 CRON_SECRET 后
 *   Vercel 会自动带上），或 `x-vercel-cron-id: <CRON_SECRET>`（同一密钥，常数时间比对）。
 * - 本机开发：显式 `ALLOW_LOCAL_CRON=1` 开关。
 * - **禁止用 Host 推断本机**（2026-10-05 红队修复）：Host 是攻击者可控头，
 *   旧逻辑 `Host: localhost.evil.com` 即可穿过；且旧逻辑对 x-vercel-cron-id 只看存在性。
 * - CRON_SECRET 未配置时拒绝执行并回明确错误（不得退化成放行）。
 */
function authorizeCron(req: NextRequest): CronAuthResult {
  if ((process.env.ALLOW_LOCAL_CRON ?? "").trim() === "1") {
    return { ok: true, label: "local-dev" };
  }

  const expected = cronSecret();
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error:
        "cron_auth_not_configured: CRON_SECRET is required (Authorization: Bearer <CRON_SECRET> or x-vercel-cron-id: <CRON_SECRET>); ALLOW_LOCAL_CRON=1 is the only local-dev bypass. Refusing to run.",
    };
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (secretEquals(bearer, expected)) return { ok: true, label: "bearer" };

  const cronId = req.headers.get("x-vercel-cron-id") ?? "";
  if (secretEquals(cronId, expected)) return { ok: true, label: "cron-id" };

  return { ok: false, status: 401, error: "Unauthorized: valid cron credentials required." };
}

/**
 * Generation worker cron：每分钟执行一次，claim 待处理与过期任务、执行生成、处理失败退款。
 *
 * 授权：见 authorizeCron（Bearer CRON_SECRET / x-vercel-cron-id=CRON_SECRET / 显式 ALLOW_LOCAL_CRON=1）。
 * 手动/外部触发（如 VPS crontab）用 `Authorization: Bearer ${CRON_SECRET}` 或 `x-vercel-cron-id: ${CRON_SECRET}` 即可。
 */
export async function GET(req: NextRequest) {
  const auth = authorizeCron(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
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
      workerId: `cron-${auth.label}`,
      jobLeaseMs: 5 * 60 * 1000, // 5 分钟租约
      supplierLeaseMs: 2 * 60 * 1000, // 2 分钟 supplier 租约
    });

    // 维护闭环（租约回收/计费结算/INC-0831 provider 对帐/健康巡检）：
    // 长驻 worker 关停期间由 cron 每分钟补位，对帐不能只有一条心跳。
    let maintenance: { ok: true } | { ok: false; error: string };
    try {
      await runGenerationMaintenanceOnce({ workerId: `cron-${auth.label}` });
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
      cron_auth: auth.label,
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
