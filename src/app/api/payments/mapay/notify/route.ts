import { NextRequest, NextResponse } from "next/server";
import { FIRST_CHARGE_FALLBACK_COINS, FIRST_CHARGE_PLAN_ID, resolvePricingPlan } from "@/lib/plans";
import {
  getMapayConfig,
  isMapayPaymentSuccessful,
  mapayMoneyAcceptable,
  verifyMapaySignature,
  type MapayFields,
} from "@/lib/mapay";
import { fulfillMapayRedemption, type MapayRedemptionPlan } from "@/lib/mapay-redemption";
import { creditMapayOrderViaRelay, mapayDeliveryFor } from "@/lib/mapay-credit";
import { readFirstChargeEligibilityViaRelay } from "@/lib/first-charge";
import { resolveMapayOrderBinding } from "@/lib/mapay-order-param";

export const runtime = "nodejs";

function response(text: string, status = 200) {
  return new NextResponse(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * 首充专享档在发码兜底里的额度口径（直達入帳通道正不可用，所以另问一次只读资格）。
 * 带本单单号：名额若就是本单占的（入帐失败后重试/发码兜底），仍然是全额 300 币。
 * 三态处置（见 first-charge.ts）：确定没资格 → 按 ¥7 对应正价折算 70 币（不给 4 倍优惠）；
 * 资格不明（通道也挂了，没人能判）→ 照档位原价发——**钱必兑现优先于优惠守门**
 * （付了钱拿不到额度的代价比多发 230 币大得多，见 payment-must-fulfill-0920）。
 */
async function firstChargeRedemptionPlan(
  plan: MapayRedemptionPlan,
  userId: number,
  orderId: string,
): Promise<MapayRedemptionPlan> {
  const eligible = await readFirstChargeEligibilityViaRelay({ userId, outTradeNo: orderId });
  if (eligible === false) {
    console.warn("[mapay notify] first-charge ineligible, redemption uses standard-rate coins", {
      out_trade_no: orderId,
      coins: FIRST_CHARGE_FALLBACK_COINS,
    });
    return { ...plan, coins: FIRST_CHARGE_FALLBACK_COINS };
  }
  return plan;
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

    const redemptionPlan =
      plan.id === FIRST_CHARGE_PLAN_ID && bound
        ? await firstChargeRedemptionPlan(plan, bound.userId, params.out_trade_no)
        : plan;

    const redemption = await fulfillMapayRedemption({
      orderId: params.out_trade_no,
      plan: redemptionPlan,
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