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

    // 自定义档（custom:<coins>）与静态档共用一个解析器：价格一律服务端重算，
    // 回调里的 money 只用于比对，客户端传价不参与任何计价。
    const plan = resolvePricingPlan(params.param);
    if (!plan || !mapayMoneyAcceptable(params.money, plan.price)) {
      console.warn("[mapay notify] rejected", {
        reason: "plan_or_money",
        out_trade_no: params.out_trade_no,
        money: params.money,
        param: params.param,
      });
      return response("fail", 400);
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
