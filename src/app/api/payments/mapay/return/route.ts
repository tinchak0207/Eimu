import { NextRequest, NextResponse } from "next/server";
import { resolvePricingPlan } from "@/lib/plans";
import {
  getMapayConfig,
  isMapayPaymentSuccessful,
  mapayMoneyAcceptable,
  verifyMapaySignature,
} from "@/lib/mapay";
import { fulfillMapayRedemption } from "@/lib/mapay-redemption";
import { creditMapayOrderViaRelay, mapayDeliveryFor } from "@/lib/mapay-credit";
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

  // param 有两种：已登入下单的三段自签值、未登入的旧格式（只有 planId）。
  // 与 notify 同源：自定义档 custom:<coins> 也要能解析。
  const bound = resolveMapayOrderBinding(params.param);

  const plan = resolvePricingPlan(bound?.planId ?? params.param);
  if (!plan || !mapayMoneyAcceptable(params.money, plan.price)) {
    return NextResponse.redirect(pricingUrl(req, { mapay: "mismatch" }));
  }

  // 已绑用户：这里也走同一条幂等入帐（不是只读状态）——用户可能比网关回调先回到站点，
  // 若此刻退回旧流程生成兑换码，稍后 notify 的直达入帐就会叠成双份额度。
  // 入帐通道明确失败（上游没动）才退回兑换码；通道不可用时只显示「处理中」，
  // 把发放权交给 notify（它记帐失败时仍会发码兜底），保证一张单只有一条发放通道。
  if (bound) {
    const outcome = await creditMapayOrderViaRelay({
      orderId: params.out_trade_no,
      userId: bound.userId,
      planId: plan.id,
    });
    const channel = mapayDeliveryFor(outcome);

    // 回跳页的通道选择与 notify 有一处刻意不同：unavailable 一律显示「处理中」、不放行兑换码。
    // 通道不可用可能是「请求已到控面但回应丢了」——那一刻上游可能已经加额，再发一张码就会双发；
    // 发放权留给 notify（它会依占位状态决定直达或发码），回跳页只保证一张单不会出现第二条通道。
    if (channel === "hold" || channel === "none" || outcome === "unavailable") {
      console.warn("[mapay return] direct credit not settled, notify owns delivery", {
        out_trade_no: params.out_trade_no,
        user_id: bound.userId,
        credit: outcome,
      });
      return NextResponse.redirect(pricingUrl(req, { mapay: "pending" }));
    }
    if (channel === "direct") {
      console.info("[mapay return]", {
        out_trade_no: params.out_trade_no,
        user_id: bound.userId,
        credit: outcome,
      });
      return NextResponse.redirect(pricingUrl(req, { mapay: "credited" }));
    }
    // channel === "redemption"（=上游明确没动，占位已终态 failed：notify 永不可能再直达加额）
    // → 退回旧流程发码，保证钱能落地。
    console.warn("[mapay return] direct credit declined, falling back to redemption", {
      out_trade_no: params.out_trade_no,
      user_id: bound.userId,
      credit: outcome,
    });
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