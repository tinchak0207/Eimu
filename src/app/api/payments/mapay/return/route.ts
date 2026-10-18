import { NextRequest, NextResponse } from "next/server";
import { resolvePricingPlan } from "@/lib/plans";
import {
  getMapayConfig,
  isMapayPaymentSuccessful,
  mapayMoneyAcceptable,
  verifyMapaySignature,
} from "@/lib/mapay";
import { isMapayCreditSettled, readMapayCreditStatusViaRelay } from "@/lib/mapay-credit";
import { findMapayRedemption } from "@/lib/mapay-redemption";
import { resolveMapayOrderBinding } from "@/lib/mapay-order-param";

export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function pricingUrl(req: NextRequest, params: Record<string, string>) {
  const url = new URL("/pricing", req.url);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.hash = "redeem";
  return url;
}

export async function GET(req: NextRequest) {
  const config = getMapayConfig();
  const params = Object.fromEntries(req.nextUrl.searchParams.entries());

  if (!verifyMapaySignature(params, config.key)) {
    return NextResponse.redirect(pricingUrl(req, { mapay: "invalid" }));
  }

  if (!isMapayPaymentSuccessful(params)) {
    return NextResponse.redirect(pricingUrl(req, { mapay: "pending" }));
  }

  // param 有两种：已登入下单的自签值、未登入的旧格式（只有 planId）。
  // 回跳只读：不入帐、不创建兑换码。创建与直达入帐只留在 notify。
  const bound = resolveMapayOrderBinding(params.param);
  const plan = resolvePricingPlan(bound?.planId ?? params.param);
  if (!plan || !mapayMoneyAcceptable(params.money, plan.price)) {
    return NextResponse.redirect(pricingUrl(req, { mapay: "mismatch" }));
  }

  if (bound) {
    const credit = await readMapayCreditStatusViaRelay(params.out_trade_no);
    if (isMapayCreditSettled(credit)) {
      return NextResponse.redirect(pricingUrl(req, { mapay: "credited" }));
    }
  }

  try {
    const existing = await findMapayRedemption({
      orderId: params.out_trade_no,
      plan,
    });
    if (existing?.key) {
      return NextResponse.redirect(pricingUrl(req, { cdk: existing.key }));
    }
  } catch (error) {
    console.error("[mapay return]", error);
  }

  return NextResponse.redirect(pricingUrl(req, { mapay: "pending" }));
}
