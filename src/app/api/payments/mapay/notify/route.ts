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
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

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

    // A1 落地存證：驗簽通過且支付成功之後、**任何履約副作用之前**先寫一筆 intake。
    // 2026-09-19 真實訂單 IMGMU7UH9SFF9A21D 被推送 6 次全回 500——旧流程履约前
    // 零落地记录，履约一炸订单在库里零痕迹，只能靠支付商后台才发现。存證失敗**不得**
    // 阻擋履約（錢必兌現優先），但必須留一條結構化告警（沿用既有 console.error 告警風格）。
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

    // 席位訂單不走 plan 流程：`seat:` 前綴者走席位履約分支（同源價表重算 → 比對 money
    // → 記下席位意圖並把配額加到團隊主帳，冪等鍵＝out_trade_no）。金額不符/參數不合法
    // → 拒且不履約。**絕不**落 fulfillMapayRedemption（那條發金幣兌換碼，席位不是金幣套餐）。
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
      // 錢必落地：已入帳（credited/already_credited）→ success；通道不可用/結果未定
      // → fail 讓網關重投（不發兌換碼兜底——席位沒有兌換碼可發）。
      if (seat.credited) await markIntake(params.out_trade_no, "direct_credit", "seat");
      return seat.credited ? response("success") : response("fail", 500);
    }

    // param 有兩種：已登入下單的三段自簽值（planId.userId.hmac8，可直達入帳），
    // 以及未登入的舊格式（只有 planId，只能發兌換碼）。驗簽失敗／舊格式＝完全走舊流程。
    // （bound / seatIdentity 已在存證段解析，見上。）

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
        await markIntake(params.out_trade_no, "direct_credit", `direct:${outcome}`);
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
    await markIntake(params.out_trade_no, "redemption_code", `cdk:${redemption.key}`);
    return response("success");
  } catch (error) {
    console.error("[mapay notify]", error);
    return response("fail", 500);
  }
}

export const GET = handleNotify;
export const POST = handleNotify;