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
import { buildSeatPendingOrder, parseSeatOrderParam, seatOrderEntitlementCoins, type SeatOrderIdentity } from "@/lib/team-seat-order";
import { quoteSeatOrder } from "@/lib/team-seat-pricing";
import { readFirstChargeEligibilityViaRelay } from "@/lib/first-charge";
import { lookupUserIdByTokenViaRelay } from "@/lib/newapi-session-token";

export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

// 下单页是 window.open 开的顶层导航，拿不到 localStorage 的 Bearer；唯一能带上来的
// 凭证是登入写的 napi_token cookie（见 new-api-client.ts）。用它反查 userId 走控面
// 稳定令牌表（authoritative），不是信前端自称的 id。
//
// 这个反查只是**增值**：未登入／反查失败／超时一律退回旧格式（param = plan.id），
// 旧流程一字不动。故预算压到 2.5s，不让它拖慢下单。首充专享档唯一例外——那档没有
// 「看不懂身分也照卖」的选项（限一次的优惠），查不出身分＝不符合资格。
const ORDER_BINDING_BUDGET_MS = 2_500;

/** 登入 cookie 名（与 new-api-client.ts 的 TOKEN_KEY 同名；服务端只读不写）。 */
const TOKEN_COOKIE = "napi_token";

/** 登入 cookie → userId（控面稳定令牌表反查）。未登入／查不到／超时／通道挂 → null。 */
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
    // 反查失败不挡下单（退回旧格式，用户照样能付）；日志绝不印 token。
    console.warn("[mapay checkout] order binding skipped", error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 已登入 → 新签名（含本次 out_trade_no 与时间戳，至少 32 hex）。
 * 未登入／查不到／没有签名密钥 → null（呼叫方沿用旧格式）。
 */
function boundOrderParam(planId: string, userId: number | null, outTradeNo: string): string | null {
  const secret = mapayOrderSecret();
  if (!secret || !userId || !outTradeNo) return null;
  return buildMapayOrderParam(planId, userId, secret, { outTradeNo, timestamp: Date.now() });
}

/**
 * 首充专享档的资格闸：只有确认有资格（控面帐本判准）才放行。
 * 未登入／确定没资格／资格查不到（通道不可用）一律拒——那档是 4 倍划
 * 算的一次性优惠，宁可少卖一次，也不能给不该给的人（fail-closed）。
 * 钱那头还有第二道闸：notify 入帐时资格不符只按正价折算（见 first-charge.ts）。
 */
async function firstChargeAllowed(userId: number | null): Promise<boolean> {
  if (!userId) return false;
  return (await readFirstChargeEligibilityViaRelay({ userId })) === true;
}

/**
 * 席位订单收银台：`?plan=seat:<team>:<tier>:<cycle>:<seats>` → mapay 收款页。
 * 金额来自同源价表。out_trade_no 每次打开收银台都新生成，避免同规格续费被当成重放。
 * 只有团队主帐本人（登入 cookie 反查 userId ＝订单团队）
 * 可发起支付。复用 mapay 既有签名与栏位口径（buildMapayCheckoutFields），不造第二套支付。
 */
async function seatCheckout(req: NextRequest, identity: SeatOrderIdentity) {
  const userId = await resolveUserId(req);
  if (!userId || userId !== identity.teamUserId) {
    console.warn("[mapay checkout] seat rejected", { reason: "not_team_owner" });
    return NextResponse.json(
      { success: false, message: "席位订单只能由团队主账号本人支付。" },
      { status: 403 },
    );
  }

  const quote = quoteSeatOrder({ tier: identity.tier, cycle: identity.cycle, seats: identity.seats });
  if (!quote.ok) {
    return NextResponse.json(
      { success: false, message: quote.message },
      { status: quote.reason === "price_not_configured" ? 409 : 400 },
    );
  }

  try {
    const config = getMapayConfig();
    const pending = buildSeatPendingOrder({ teamUserId: identity.teamUserId, quote });
    const coins = seatOrderEntitlementCoins(identity) ?? 0;
    const fields = buildMapayCheckoutFields({
      config,
      orderId: pending.out_trade_no,
      paymentType: normalizeMapayPaymentType(req.nextUrl.searchParams.get("type")),
      plan: { id: pending.param, name: pending.name, price: quote.totalPrice, coins },
      param: pending.param,
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

export async function GET(req: NextRequest) {
  const planId = req.nextUrl.searchParams.get("plan") ?? "";

  // 席位订单（`seat:` 前缀）走席位收银台分支；其余维持既有 plan 流程一字不动。
  const seatIdentity = parseSeatOrderParam(planId);
  if (seatIdentity) {
    return seatCheckout(req, seatIdentity);
  }

  const plan = resolvePricingPlan(planId);

  if (!plan) {
    return NextResponse.json({ success: false, message: "套餐不存在" }, { status: 400 });
  }

  // 反查一次，绑单与首充资格闸共用（同一趟控面往返，不重复打）。
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
    const orderId = createMapayOrderId();
    const fields = buildMapayCheckoutFields({
      config,
      orderId,
      paymentType: normalizeMapayPaymentType(req.nextUrl.searchParams.get("type")),
      plan,
      param: boundOrderParam(plan.id, userId, orderId) ?? undefined,
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