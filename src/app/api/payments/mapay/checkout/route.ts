import { NextRequest, NextResponse } from "next/server";
import { FIRST_CHARGE_PLAN_ID, resolvePricingPlan } from "@/lib/plans";
import {
  buildMapayCheckoutFields,
  createMapayOrderId,
  getMapayConfig,
  getMapaySubmitUrl,
  normalizeMapayPaymentType,
  renderMapaySubmitPage,
} from "@/lib/mapay";
import { buildMapayOrderParam, mapayOrderSecret } from "@/lib/mapay-order-param";
import { readFirstChargeEligibilityViaRelay } from "@/lib/first-charge";
import { lookupUserIdByTokenViaRelay } from "@/lib/newapi-session-token";

export const runtime = "nodejs";

// 下單頁是 window.open 開的頂層導航，拿不到 localStorage 的 Bearer；唯一能帶上來的
// 憑證是登入寫的 napi_token cookie（見 new-api-client.ts）。用它反查 userId 走控面
// 穩定令牌表（authoritative），不是信前端自稱的 id。
//
// 這個反查只是**增值**：未登入／反查失敗／超時一律退回舊格式（param = plan.id），
// 舊流程一字不動。故預算壓到 2.5s，不讓它拖慢下單。首充專享檔唯一例外——那檔沒有
// 「看不懂身分也照賣」的選項（限一次的優惠），查不出身分＝不符合資格。
const ORDER_BINDING_BUDGET_MS = 2_500;

/** 登入 cookie 名（與 new-api-client.ts 的 TOKEN_KEY 同名；服務端只讀不寫）。 */
const TOKEN_COOKIE = "napi_token";

/** 登入 cookie → userId（控面穩定令牌表反查）。未登入／查不到／超時／通道掛 → null。 */
async function resolveUserId(req: NextRequest): Promise<number | null> {
  const token = req.cookies.get(TOKEN_COOKIE)?.value?.trim();
  if (!token) return null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookupUserIdByTokenViaRelay(token),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ORDER_BINDING_BUDGET_MS);
      }),
    ]);
  } catch (error) {
    // 反查失敗不擋下單（退回舊格式，用戶照樣能付）；日誌絕不印 token。
    console.warn("[mapay checkout] order binding skipped", error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 已登入 → `${planId}.${userId}.${hmac8}`（notify 可據此直接入帳）；
 * 未登入／查不到／沒有簽名密鑰 → null（呼叫方沿用舊格式）。
 */
function boundOrderParam(planId: string, userId: number | null): string | null {
  const secret = mapayOrderSecret();
  if (!secret || !userId) return null;
  return buildMapayOrderParam(planId, userId, secret);
}

/**
 * 首充專享檔的資格閘：只有確認有資格（控面帳本判準）才放行。
 * 未登入／確定沒資格／資格查不到（通道不可用）一律拒——那檔是 4 倍划
 * 算的一次性優惠，寧可少賣一次，也不能給不該給的人（fail-closed）。
 * 錢那頭還有第二道閘：notify 入帳時資格不符只按正價折算（見 first-charge.ts）。
 */
async function firstChargeAllowed(userId: number | null): Promise<boolean> {
  if (!userId) return false;
  return (await readFirstChargeEligibilityViaRelay({ userId })) === true;
}

export async function GET(req: NextRequest) {
  const planId = req.nextUrl.searchParams.get("plan") ?? "";
  const plan = resolvePricingPlan(planId);

  if (!plan) {
    return NextResponse.json({ success: false, message: "套餐不存在" }, { status: 400 });
  }

  // 反查一次，綁單與首充資格閘共用（同一趟控面往返，不重複打）。
  const userId = await resolveUserId(req);

  if (plan.id === FIRST_CHARGE_PLAN_ID && !(await firstChargeAllowed(userId))) {
    console.warn("[mapay checkout] first-charge rejected", {
      plan_id: plan.id,
      user: userId ? "resolved" : "anonymous",
    });
    return NextResponse.json(
      {
        success: false,
        message: "首充专享每个账号限购一次，且仅限从未充值过的账号。请选择常规套餐，或登录后重试。",
      },
      { status: 403 },
    );
  }

  try {
    const config = getMapayConfig();
    const fields = buildMapayCheckoutFields({
      config,
      orderId: createMapayOrderId(),
      paymentType: normalizeMapayPaymentType(req.nextUrl.searchParams.get("type")),
      plan,
      param: boundOrderParam(plan.id, userId) ?? undefined,
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