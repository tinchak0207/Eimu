import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import {
  listBillingOperations,
  reconcileBillingOperationManually,
  type BillingOperationView,
  type ManualBillingAction,
} from "@/lib/generation-core/billing-ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "Unauthorized." }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : "Billing reconciliation failed.";
  const status = /not found|cannot be|still executing|required/i.test(message) ? 400 : 500;
  return NextResponse.json({ success: false, message }, { status });
}

function isStatus(value: string | null): value is BillingOperationView["status"] {
  return value === "pending" || value === "executing" || value === "applied" || value === "unknown" || value === "failed";
}

function isAction(value: unknown): value is ManualBillingAction {
  return value === "mark_applied" || value === "mark_failed" || value === "retry";
}

export async function GET(req: NextRequest) {
  try {
    await requireAdminSession();
    const rawStatus = req.nextUrl.searchParams.get("status");
    if (rawStatus !== null && !isStatus(rawStatus)) {
      return NextResponse.json({ success: false, message: "Invalid billing status." }, { status: 400 });
    }
    const rawLimit = Number(req.nextUrl.searchParams.get("limit") ?? 100);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.floor(rawLimit), 500)) : 100;
    return NextResponse.json({ success: true, operations: await listBillingOperations({ status: rawStatus ?? undefined, limit }) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAdminSession();
    const body = await req.json().catch(() => null) as {
      operationId?: unknown;
      action?: unknown;
      note?: unknown;
    } | null;
    if (!body || typeof body.operationId !== "string" || !isAction(body.action) || typeof body.note !== "string") {
      return NextResponse.json({ success: false, message: "operationId, action, and note are required." }, { status: 400 });
    }
    const operation = await reconcileBillingOperationManually({
      operationId: body.operationId,
      action: body.action,
      actor: session.username,
      note: body.note,
    });
    return NextResponse.json({ success: true, operation });
  } catch (error) {
    return errorResponse(error);
  }
}
