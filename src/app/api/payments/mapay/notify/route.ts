import { NextRequest, NextResponse } from "next/server";
import { resolvePricingPlan } from "@/lib/plans";
import {
  getMapayConfig,
  isMapayPaymentSuccessful,
  mapayMoneyAcceptable,
  verifyMapaySignature,
  type MapayFields,
} from "@/lib/mapay";
import { fulfillMapayRedemption } from "@/lib/mapay-redemption";
import { creditMapayOrderViaRelay, mapayDeliveryFor } from "@/lib/mapay-credit";
import { resolveMapayOrderBinding } from "@/lib/mapay-order-param";

export const runtime = "nodejs";

function response(text: string, status = 200) {
  return new NextResponse(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function readParams(req: NextRequest): Promise<MapayFields> {
  if (req.method === "POST") {
    const form = await req.formData();
    return Object.fromEntries(
      Array.from(form.entries()).map(([key, value]) => [key, String(value)]),
    );
  }

  return Object.fromEntries(req.nextUrl.searchParams.entries());
}

async function handleNotify(req: NextRequest) {
  try {
    const config = getMapayConfig();
    const params = await readParams(req);

    if (!verifyMapaySignature(params, config.key)) {
      // 驗簽失敗時欄位不可信，只回傳原值供排障。
      console.warn("[mapay notify] rejected", {
        reason: "signature",
        out_trade_no: params.out_trade_no,
        money: params.money,
        param: params.param,
      });
      return response("fail", 400);
    }

    if (!isMapayPaymentSuccessful(params)) {
      console.info("[mapay notify] non-success status", {
        out_trade_no: params.out_trade_no,
        trade_status: params.trade_status,
      });
      return response("success");
    }

    // param 有兩種：已登入下單的三段自簽值（planId.userId.hmac8，可直達入帳），
    // 以及未登入的舊格式（只有 planId，只能發兌換碼）。驗簽失敗／舊格式＝完全走舊流程。
    const bound = resolveMapayOrderBinding(params.param);

    // 自定义档（custom:<coins>）与静态档共用一个解析器：价格一律服务端重算，
    // 回调里的 money 只用于比对，客户端传价不参与任何计价。
    const plan = resolvePricingPlan(bound?.planId ?? params.param);
    if (!plan || !mapayMoneyAcceptable(params.money, plan.price)) {
      console.warn("[mapay notify] rejected", {
        reason: "plan_or_money",
        out_trade_no: params.out_trade_no,
        money: params.money,
        param: params.param,
      });
      return response("fail", 400);
    }

    // ① 已綁用戶：直接加額（冪等鍵＝out_trade_no），成功就不再發兌換碼。
    if (bound) {
      const outcome = await creditMapayOrderViaRelay({
        orderId: params.out_trade_no,
        userId: bound.userId,
        planId: plan.id,
      });
      const channel = mapayDeliveryFor(outcome);

      if (channel === "direct") {
        console.info("[mapay notify]", {
          out_trade_no: params.out_trade_no,
          trade_no: params.trade_no,
          money: params.money,
          user_id: bound.userId,
          credit: outcome,
        });
        return response("success");
      }

      if (channel === "hold") {
        // 已占位但結果未定（pending/unknown）：上游調額不冪等，再發一張兌換碼
        // 可能疊成雙份。回 success 讓網關停止重投，留 warn 交人工核對（mapay_credit 表）。
        console.warn("[mapay notify] credit in flight, no second delivery channel", {
          out_trade_no: params.out_trade_no,
          user_id: bound.userId,
        });
        return response("success");
      }

      // redemption＝上游明確沒動／通道或網路不可用 → 退回舊流程（生成兌換碼），
      // 保證錢一定能落地（寧可讓用戶手動兌一次，也不能付了沒額度）。
      console.warn("[mapay notify] direct credit unavailable, falling back to redemption", {
        out_trade_no: params.out_trade_no,
        user_id: bound.userId,
        credit: outcome,
      });
    }

    const redemption = await fulfillMapayRedemption({
      orderId: params.out_trade_no,
      plan,
    });

    console.info("[mapay notify]", {
      out_trade_no: params.out_trade_no,
      trade_no: params.trade_no,
      trade_status: params.trade_status,
      money: params.money,
      type: params.type,
      redemption_created: redemption.created,
    });
    return response("success");
  } catch (error) {
    console.error("[mapay notify]", error);
    return response("fail", 500);
  }
}

export const GET = handleNotify;
export const POST = handleNotify;