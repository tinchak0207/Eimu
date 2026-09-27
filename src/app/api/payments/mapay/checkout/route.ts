import { NextRequest, NextResponse } from "next/server";
import { resolvePricingPlan } from "@/lib/plans";
import {
  buildMapayCheckoutFields,
  createMapayOrderId,
  getMapayConfig,
  getMapaySubmitUrl,
  normalizeMapayPaymentType,
  renderMapaySubmitPage,
} from "@/lib/mapay";
import { buildMapayOrderParam, mapayOrderSecret } from "@/lib/mapay-order-param";
import { lookupUserIdByTokenViaRelay } from "@/lib/newapi-session-token";

export const runtime = "nodejs";

// 下單頁是 window.open 開的頂層導航，拿不到 localStorage 的 Bearer；唯一能帶上來的
// 憑證是登入寫的 napi_token cookie（見 new-api-client.ts）。用它反查 userId 走控面
// 穩定令牌表（authoritative），不是信前端自稱的 id。
//
// 這個反查只是**增值**：未登入／反查失敗／超時一律退回舊格式（param = plan.id），
// 舊流程一字不動。故預算壓到 2.5s，不讓它拖慢下單。
const ORDER_BINDING_BUDGET_MS = 2_500;

/** 登入 cookie 名（與 new-api-client.ts 的 TOKEN_KEY 同名；服務端只讀不寫）。 */
const TOKEN_COOKIE = "napi_token";

/**
 * 已登入 → `${planId}.${userId}.${hmac8}`（notify 可據此直接入帳）；
 * 未登入／查不到／超時 → null（呼叫方沿用舊格式）。
 */
async function boundOrderParam(req: NextRequest, planId: string): Promise<string | null> {
  const secret = mapayOrderSecret();
  const token = req.cookies.get(TOKEN_COOKIE)?.value?.trim();
  if (!secret || !token) return null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const userId = await Promise.race([
      lookupUserIdByTokenViaRelay(token),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ORDER_BINDING_BUDGET_MS);
      }),
    ]);
    if (!userId) return null;
    return buildMapayOrderParam(planId, userId, secret);
  } catch (error) {
    // 綁定失敗不擋下單（退回舊格式，用戶照樣能付）；日誌絕不印 token。
    console.warn("[mapay checkout] order binding skipped", error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  const planId = req.nextUrl.searchParams.get("plan") ?? "";
  const plan = resolvePricingPlan(planId);

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
      param: (await boundOrderParam(req, plan.id)) ?? undefined,
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