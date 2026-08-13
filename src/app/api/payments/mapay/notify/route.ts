import { NextRequest, NextResponse } from "next/server";
import { PLANS } from "@/lib/plans";
import {
  getMapayConfig,
  isMapayPaymentSuccessful,
  mapayMoneyMatches,
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
      return response("fail", 400);
    }

    if (!isMapayPaymentSuccessful(params)) {
      return response("success");
    }

    const plan = PLANS.find((item) => item.id === params.param);
    if (!plan || !mapayMoneyMatches(params.money, plan.price)) {
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
