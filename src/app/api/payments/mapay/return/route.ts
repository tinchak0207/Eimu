import { NextRequest, NextResponse } from "next/server";
import { resolvePricingPlan } from "@/lib/plans";
import {
  getMapayConfig,
  isMapayPaymentSuccessful,
  mapayMoneyAcceptable,
  verifyMapaySignature,
} from "@/lib/mapay";
import { fulfillMapayRedemption } from "@/lib/mapay-redemption";

export const runtime = "nodejs";

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

  const plan = resolvePricingPlan(params.param); // 与 notify 同源：自定义档 custom:<coins> 也要能解析
  if (!plan || !mapayMoneyAcceptable(params.money, plan.price)) {
    return NextResponse.redirect(pricingUrl(req, { mapay: "mismatch" }));
  }

  try {
    const redemption = await fulfillMapayRedemption({
      orderId: params.out_trade_no,
      plan,
    });

    return NextResponse.redirect(pricingUrl(req, { cdk: redemption.key }));
  } catch (error) {
    console.error("[mapay return]", error);
    return NextResponse.redirect(pricingUrl(req, { mapay: "cdk_failed" }));
  }
}
