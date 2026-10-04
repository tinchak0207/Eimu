import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { runCallbackWorkerOnce } from "@/lib/generation-core/callback-outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

/**
 * Cron-triggered entrypoint that drains due callback_delivery rows once per call.
 * There is no CRON_SECRET / shared-secret convention already established in this repo
 * for internal routes (grepped for CRON_SECRET, INTERNAL_WORKER_SECRET, x-internal-* —
 * none exist yet); the closest precedent is image-upstream-probe/route.ts and
 * sub2api-fix-groups/route.ts, which both gate on a bearer-style token compared with
 * timingSafeEqual instead of the admin session cookie. This route follows that same
 * shape with its own env var so it isn't confused with the unrelated upstream probe token.
 */

function workerSecret(): string {
  return (process.env.CALLBACK_WORKER_SECRET ?? "").trim();
}

function authorized(req: NextRequest): boolean {
  const expected = workerSecret();
  const actual = req.headers.get("x-internal-worker-secret") ?? "";
  if (!expected || expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const workerId = `callback-worker:${req.headers.get("x-vercel-id") ?? "local"}:${Date.now()}`;
  const summary = await runCallbackWorkerOnce(workerId);
  return NextResponse.json(summary);
}

/**
 * 每分钟触发的 cron 入口，带 Authorization: Bearer ${CRON_SECRET}。
 *
 * **不要把 `crons` 加回 vercel.json。** 两个独立原因：
 * 1. 本专案是 Hobby 帐号，`* * * * *` 直接让整个 deploy 失败
 *    （"Hobby accounts are limited to daily cron jobs"），连同批其他改动一起挡掉。
 * 2. 更根本：`callback_delivery` 表住在 VPS 控制面的 Postgres，那个容器不发布任何
 *    埠，且 Vercel 上没有 `GENERATION_DATABASE_URL`。所以就算升级 Pro，Vercel 端的
 *    cron 也永远抽不到任何 outbox row。
 *
 * 真正的触发来自 VPS crontab，每分钟打控制面自己的这个路由（见
 * /usr/local/bin/drain-callback-outbox.sh），用 `x-internal-worker-secret` 走 POST。
 */
export async function GET(req: NextRequest) {
  const cronSecret = (process.env.CRON_SECRET ?? "").trim();
  const authHeader = req.headers.get("authorization") ?? "";
  const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (cronSecret && provided !== cronSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const workerId = `callback-worker-cron:${req.headers.get("x-vercel-id") ?? "local"}:${Date.now()}`;
  const summary = await runCallbackWorkerOnce(workerId);
  return NextResponse.json(summary);
}
