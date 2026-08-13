import { NextRequest, NextResponse } from "next/server";
import { PLANS } from "@/lib/plans";
import {
  buildMapayCheckoutFields,
  createMapayOrderId,
  getMapayConfig,
  getMapaySubmitUrl,
  normalizeMapayPaymentType,
  renderMapaySubmitPage,
} from "@/lib/mapay";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const planId = req.nextUrl.searchParams.get("plan") ?? "";
  const plan = PLANS.find((item) => item.id === planId);

  if (!plan) {
    return NextResponse.json({ success: false, message: "套餐不存在" }, { status: 400 });
  }

  try {
    const config = getMapayConfig();
    const fields = buildMapayCheckoutFields({
      config,
      orderId: createMapayOrderId(),
      paymentType: normalizeMapayPaymentType(req.nextUrl.searchParams.get("type")),
      plan,
    });

    return new NextResponse(renderMapaySubmitPage(getMapaySubmitUrl(config.gatewayUrl), fields), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : "MaPay 配置错误" },
      { status: 500 },
    );
  }
}
