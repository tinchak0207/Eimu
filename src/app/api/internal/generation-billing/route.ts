import { NextRequest, NextResponse } from "next/server";
import { ImageBillingGatewayError, ImageBillingRevertedError, refundImageQuota, reserveImageQuota } from "@/lib/image-billing";
import { verifyBillingRelayRequest, type BillingRelayOperation } from "@/lib/generation-core/billing-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

type RelayBody = {
  job_id?: unknown;
  operation?: unknown;
  user_id?: unknown;
  amount?: unknown;
};

function configuredSecret(): string {
  return process.env.GENERATION_BILLING_RELAY_SECRET?.trim() ?? "";
}

function isOperation(value: unknown): value is BillingRelayOperation {
  return value === "reserve" || value === "refund";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  if (!verifyBillingRelayRequest({
    secret: configuredSecret(),
    timestamp: req.headers.get("x-generation-billing-timestamp"),
    signature: req.headers.get("x-generation-billing-signature"),
    rawBody,
  })) {
    return NextResponse.json({ ok: false, message: "Unauthorized billing relay request." }, { status: 401 });
  }

  let body: RelayBody;
  try {
    body = JSON.parse(rawBody) as RelayBody;
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid billing relay JSON." }, { status: 400 });
  }
  if (
    !body || typeof body.job_id !== "string" || body.job_id.length < 8 || body.job_id.length > 128 ||
    !isOperation(body.operation) || !isPositiveInteger(body.user_id) || !isPositiveInteger(body.amount)
  ) {
    return NextResponse.json({ ok: false, message: "Invalid billing relay payload." }, { status: 400 });
  }

  try {
    if (body.operation === "reserve") await reserveImageQuota(body.user_id, body.amount);
    else await refundImageQuota(body.user_id, body.amount);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Billing relay failed.";
    if (error instanceof ImageBillingRevertedError) {
      return NextResponse.json({ ok: false, reverted: true, message }, { status: 409 });
    }
    if (error instanceof ImageBillingGatewayError) {
      const headers = error.retryAfter ? { "Retry-After": error.retryAfter } : undefined;
      return NextResponse.json({ ok: false, message }, { status: error.status ?? 502, headers });
    }
    return NextResponse.json({ ok: false, message }, { status: 502 });
  }
}
