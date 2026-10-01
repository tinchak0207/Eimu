// 管理员调额：一次写两层（上游 users.quota + account_ledger），按 Idempotency-Key 幂等。
// 核心见 src/lib/admin-account-adjustment.ts；本路由只在控制面执行（control-plane-proxy-routes.mjs）。
import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import {
  applyAdminAccountAdjustment,
  parseAdminAdjustmentRequest,
  productionAdminAdjustmentDeps,
} from "@/lib/admin-account-adjustment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

export async function POST(req: NextRequest) {
  let operator: string;
  try {
    operator = (await requireAdminSession()).username;
  } catch {
    return NextResponse.json({ success: false, message: "Unauthorized." }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = parseAdminAdjustmentRequest(req.headers.get("idempotency-key"), body);
  if ("error" in parsed) {
    return NextResponse.json({ success: false, message: parsed.error }, { status: 400 });
  }

  const result = await applyAdminAccountAdjustment(parsed.input, operator, productionAdminAdjustmentDeps());
  if (result.status === "conflict") {
    return NextResponse.json({ success: false, message: result.reason, ...result }, { status: 409 });
  }
  const ok = result.status === "applied" || result.status === "already_applied";
  return NextResponse.json({ success: ok, ...result }, { status: ok ? 200 : result.status === "in_flight" ? 202 : 503 });
}
