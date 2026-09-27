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

  // param 有兩種：已登入下單的三段自簽值、未登入的舊格式（只有 planId）。
  // 與 notify 同源：自定义档 custom:<coins> 也要能解析。
  const bound = resolveMapayOrderBinding(params.param);

  const plan = resolvePricingPlan(bound?.planId ?? params.param);
  if (!plan || !mapayMoneyAcceptable(params.money, plan.price)) {
    return NextResponse.redirect(pricingUrl(req, { mapay: "mismatch" }));
  }

  // 已綁用戶：這裡也走同一條冪等入帳（不是只讀狀態）——用戶可能比網關回調先回到站點，
  // 若此刻退回舊流程生成兌換碼，稍後 notify 的直達入帳就會疊成雙份額度。
  // 入帳通道明確失敗（上游沒動）才退回兌換碼；通道不可用時只顯示「處理中」，
  // 把發放權交給 notify（它記帳失敗時仍會發碼兜底），保證一張單只有一條發放通道。
  if (bound) {
    const outcome = await creditMapayOrderViaRelay({
      orderId: params.out_trade_no,
      userId: bound.userId,
      planId: plan.id,
    });
    const channel = mapayDeliveryFor(outcome);

    // 回跳頁的通道選擇與 notify 有一處刻意不同：unavailable 一律顯示「處理中」、不放行兌換碼。
    // 通道不可用可能是「請求已到控面但回應丟了」——那一刻上游可能已經加額，再發一張碼就會雙發；
    // 發放權留給 notify（它會依占位狀態決定直達或發碼），回跳頁只保證一張單不會出現第二條通道。
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
    // channel === "redemption"（=上游明確沒動，占位已終態 failed：notify 永不可能再直達加額）
    // → 退回舊流程發碼，保證錢能落地。
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