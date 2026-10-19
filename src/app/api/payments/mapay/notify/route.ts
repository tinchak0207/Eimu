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
import { markMapayIntakeFulfilledViaRelay, recordMapayIntakeViaRelay, type MapayIntakeDelivery } from "@/lib/mapay-intake";
import { readFirstChargeEligibilityViaRelay } from "@/lib/first-charge";
import { resolveMapayOrderBinding } from "@/lib/mapay-order-param";
import { parseSeatOrderParam } from "@/lib/team-seat-order";
import { fulfillSeatOrder } from "@/lib/team-seat-fulfillment";

export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function response(text: string, status = 200) {
  return new NextResponse(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * 履约落地后回标 intake=fulfilled（带 delivery）。回标失败不改履约结果——
 * cron sweep 会按幂等键补；只记一条结构化告警。
 */
async function markIntake(orderId: string, delivery: MapayIntakeDelivery, detail: string): Promise<void> {
  const outcome = await markMapayIntakeFulfilledViaRelay({ orderId, delivery, detail });
  if (outcome !== "fulfilled") {
    console.error("[mapay notify] intake mark fulfilled failed（不改履约结果，sweep 会幂等补）", {
      out_trade_no: orderId,
      delivery,
      outcome,
    });
  }
}

/**
 * 首充专享档在发码兜底里的额度口径（直达入帐通道正不可用，所以另问一次只读资格）。
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
      // 验签失败时栏位不可信，只回传原值供排障。
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

    // A1 落地存证：验签通过且支付成功之后、**任何履约副作用之前**先写一笔 intake。
    // 2026-09-19 真实订单 IMGMU7UH9SFF9A21D 被推送 6 次全回 500——旧流程履约前
    // 零落地记录，履约一炸订单在库里零痕迹，只能靠支付商后台才发现。存证失败**不得**
    // 阻挡履约（钱必兑现优先），但必须留一条结构化告警（沿用既有 console.error 告警风格）。
    const bound = resolveMapayOrderBinding(params.param);
    const seatIdentity = parseSeatOrderParam(params.param);
    const intake = await recordMapayIntakeViaRelay({
      orderId: params.out_trade_no,
      rawParams: params,
      money: params.money,
      planId: bound?.planId ?? params.param,
      param: params.param,
      userId: seatIdentity?.teamUserId ?? bound?.userId ?? null,
    });
    if (intake !== "recorded") {
      console.error("[mapay notify] intake record failed（继续履约，钱必兑现优先）", {
        out_trade_no: params.out_trade_no,
        money: params.money,
        param: params.param,
        outcome: intake,
      });
    }

    // 席位订单不走 plan 流程：`seat:` 前缀者走席位履约分支（同源价表重算 → 比对 money
    // → 记下席位意图并把配额加到团队主帐，幂等键＝out_trade_no）。金额不符/参数不合法
    // → 拒且不履约。**绝不**落 fulfillMapayRedemption（那条发金币兑换码，席位不是金币套餐）。
    const seat = await fulfillSeatOrder({
      param: params.param,
      money: params.money,
      orderId: params.out_trade_no,
    });
    if (seat.handled) {
      if (!seat.ok) {
        console.warn("[mapay notify] seat rejected", {
          reason: seat.code,
          out_trade_no: params.out_trade_no,
          money: params.money,
          param: params.param,
        });
        return response("fail", 400);
      }
      console.info("[mapay notify] seat", {
        out_trade_no: params.out_trade_no,
        trade_no: params.trade_no,
        money: params.money,
        team_user_id: seat.teamUserId,
        tier: seat.tier,
        cycle: seat.cycle,
        seats: seat.seats,
        target_coins: seat.targetCoins,
        outcome: seat.outcome,
      });
      // 钱必落地：已入帐（credited/already_credited）→ success；通道不可用/结果未定
      // → fail 让网关重投（不发兑换码兜底——席位没有兑换码可发）。
      if (seat.credited) await markIntake(params.out_trade_no, "direct_credit", "seat");
      return seat.credited ? response("success") : response("fail", 500);
    }

    // param 有两种：已登入下单的三段自签值（planId.userId.hmac8，可直达入帐），
    // 以及未登入的旧格式（只有 planId，只能发兑换码）。验签失败／旧格式＝完全走旧流程。
    // （bound / seatIdentity 已在存证段解析，见上。）

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

    // ① 已绑用户：直接加额（幂等键＝out_trade_no），成功就不再发兑换码。
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
        await markIntake(params.out_trade_no, "direct_credit", `direct:${outcome}`);
        return response("success");
      }

      if (channel === "hold") {
        // 已占位但结果未定（pending/unknown）：上游调额不幂等，再发一张兑换码
        // 可能叠成双份。回 success 让网关停止重投，留 warn 交人工核对（mapay_credit 表）。
        console.warn("[mapay notify] credit in flight, no second delivery channel", {
          out_trade_no: params.out_trade_no,
          user_id: bound.userId,
        });
        return response("success");
      }

      if (channel === "retry") {
        // unavailable 把「环境缺失」和「8 秒超时」收成同一个词。超时那时上游可能已经加额。
        // 再发兑换码就是双倍到账。回 fail，支付网关重投；重投若已入账会走 direct。
        console.warn("[mapay notify] direct credit indeterminate, refusing redemption", {
          out_trade_no: params.out_trade_no,
          user_id: bound.userId,
          credit: outcome,
        });
        return response("fail", 500);
      }

      // failed＝上游明确没动，才退回兑换码。未绑定用户的旧 param 不进这个分支。
      console.warn("[mapay notify] direct credit declined, falling back to redemption", {
        out_trade_no: params.out_trade_no,
        user_id: bound.userId,
        credit: outcome,
      });
    }

    const redemptionPlan =
      plan.id === FIRST_CHARGE_PLAN_ID && bound
        ? await firstChargeRedemptionPlan(plan, bound.userId, params.out_trade_no)
        : plan;

    // 兑换码只在 notify 创建。回跳只读，不再并行发码。
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
    await markIntake(params.out_trade_no, "redemption_code", `cdk:${redemption.key}`);
    return response("success");
  } catch (error) {
    console.error("[mapay notify]", error);
    return response("fail", 500);
  }
}

export const GET = handleNotify;
export const POST = handleNotify;