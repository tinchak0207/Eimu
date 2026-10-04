// 控制面侧的 mPay 直达入帐端点（付款直接绑用户加额，不再发兑换码）。
//
// 呼叫方：Vercel 上
//   - /api/payments/mapay/notify（mPay 回调验签通过后直接入帐）
//   - /api/payments/mapay/return（回跳页只读状态，决定显示「已到账」还是走旧兑换码流程）
//
// 鉴权复用 biz-key-sync 的 HMAC 通道（signatureDomain "mapay-credit"），
// 与 welcome-gift / user-attribution / newapi-session-token 同一骨架；不回显任何内部错误细节。
//
// 金额口径一律由控面自己重算（planId → plans.ts），**不接受呼叫方传来的额度**；
// 上游调额不幂等，幂等键是 mPay 的 out_trade_no（mapay_credit 主键）。
//
// 首充专享档（plan id `first-charge`）的额度例外地不是标价函数：有资格才给 300 币，
// 资格不符按正价折算（见 src/lib/first-charge.ts 的 resolveFirstChargeGrant）。

import { NextRequest, NextResponse } from "next/server";
import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  verifyBizKeySync,
} from "@/lib/biz-key-sync";
import { generationDatabaseConfigured, getGenerationSql } from "@/lib/generation-core/database";
import {
  MAPAY_CREDIT_RELAY_SIGNATURE_DOMAIN,
  createPostgresMapayCreditStore,
  runMapayCreditWithSql,
  type MapayCreditOutcome,
} from "@/lib/mapay-credit";
import { mapayPlanQuota } from "@/lib/mapay-redemption";
import { FIRST_CHARGE_PLAN_ID, resolvePricingPlan } from "@/lib/plans";
import { resolveFirstChargeGrantWithSql } from "@/lib/first-charge";
import { parseSeatOrderParam, seatOrderEntitlementCoins } from "@/lib/team-seat-order";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

/** 已占位记录 → 只读回报用结果词（applied 以外的状态呼叫方不得再发一次）。 */
function outcomeOfStatus(status: string | null): MapayCreditOutcome {
  if (status === "applied") return "already_credited";
  if (status === "pending" || status === "unknown") return "in_flight";
  if (status === "failed") return "failed";
  return "none";
}

export async function POST(req: NextRequest) {
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!secret) return NextResponse.json({ ok: false, message: "签名通道未配置。" }, { status: 503 });

  // 签名覆盖的是字节：必须读原文再解析。
  const rawBody = await req.text();
  const verified = verifyBizKeySync({
    secret,
    timestamp: req.headers.get(BIZ_KEY_SYNC_TIMESTAMP_HEADER),
    signature: req.headers.get(BIZ_KEY_SYNC_SIGNATURE_HEADER),
    rawBody,
    signatureDomain: MAPAY_CREDIT_RELAY_SIGNATURE_DOMAIN,
  });
  if (!verified) return NextResponse.json({ ok: false, message: "签名校验失败。" }, { status: 401 });

  if (!generationDatabaseConfigured()) {
    return NextResponse.json({ ok: false, message: "储存层未配置。" }, { status: 503 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, message: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const body = parsed as { op?: unknown; orderId?: unknown; userId?: unknown; planId?: unknown } | null;
  const orderId = typeof body?.orderId === "string" ? body.orderId.trim() : "";
  if (!orderId || orderId.length > 64) {
    return NextResponse.json({ ok: false, message: "缺少合法的 orderId。" }, { status: 400 });
  }

  // 只读：回跳页据此决定显示「已到账」还是退回兑换码流程。
  if (body?.op === "status") {
    try {
      const record = await createPostgresMapayCreditStore(getGenerationSql()).get(orderId);
      return NextResponse.json({ ok: true, outcome: outcomeOfStatus(record?.status ?? null) });
    } catch (error) {
      console.error(
        `[internal/mapay-credit] status failed order=${orderId}：${error instanceof Error ? error.message : String(error)}`,
      );
      return NextResponse.json({ ok: false, message: "查询失败。" }, { status: 500 });
    }
  }

  if (body?.op !== "credit") {
    return NextResponse.json({ ok: false, message: "未知的操作。" }, { status: 400 });
  }

  const userId = Number(body.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ ok: false, message: "缺少合法的 userId。" }, { status: 400 });
  }
  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  // 席位订单（`seat:` 前缀）：额度由 param 的 (team,tier,cycle,seats) 在同源价表重算
  // （seats × 档位含币额 × QUOTA_PER_COIN），team 身分也以 param 为准——一律不接受
  // 呼叫方传来的额度；其余维持既有 plan 解析（静态档 / custom:<coins> / 首充）。
  const seatIdentity = parseSeatOrderParam(planId);
  if (seatIdentity && seatIdentity.teamUserId !== userId) {
    return NextResponse.json({ ok: false, message: "席位订单团队与调用方不一致。" }, { status: 400 });
  }
  const plan = seatIdentity ? null : planId ? resolvePricingPlan(planId) : null;
  if (!seatIdentity && !plan) {
    return NextResponse.json({ ok: false, message: "缺少合法的 planId。" }, { status: 400 });
  }

  try {
    const sql = getGenerationSql();
    let amountQuota: number;
    let detail: string | undefined;
    if (seatIdentity) {
      const seatCoins = seatOrderEntitlementCoins(seatIdentity);
      if (seatCoins === null) {
        return NextResponse.json({ ok: false, message: "缺少合法的席位订单参数。" }, { status: 400 });
      }
      amountQuota = seatCoins * QUOTA_PER_COIN;
      detail = `团队席位 ${seatIdentity.tier}/${seatIdentity.cycle} × ${seatIdentity.seats} 席（${seatCoins} 币）`;
    } else {
      // 首充专享档的额度不是标价函数：有资格才给 300 币；资格不符（并发第二单 / 已有充值记录 /
      // 资格判不了）按 ¥7 对应正价折算（约 70 币）入帐，原因写进 mapay_credit.detail。
      // 「每帐号限一次」的并发执法点是 first_charge_claim 的 user_id 主键（见 src/lib/first-charge.ts）。
      amountQuota = mapayPlanQuota(plan!);
      if (plan!.id === FIRST_CHARGE_PLAN_ID) {
        const grant = await resolveFirstChargeGrantWithSql(sql, { userId, outTradeNo: orderId });
        amountQuota = grant.amountQuota;
        detail = grant.detail;
      }
    }

    const outcome = await runMapayCreditWithSql(sql, {
      orderId,
      userId,
      planId: seatIdentity ? planId : plan!.id,
      amountQuota,
      detail,
    });
    console.info("[internal/mapay-credit]", {
      order_id: orderId,
      user_id: userId,
      plan_id: seatIdentity ? planId : plan!.id,
      coins: amountQuota / QUOTA_PER_COIN,
      outcome,
    });
    return NextResponse.json({ ok: true, outcome });
  } catch (error) {
    console.error(
      `[internal/mapay-credit] credit failed order=${orderId} user=${userId}：${error instanceof Error ? error.message : String(error)}`,
    );
    return NextResponse.json({ ok: false, message: "入账失败。" }, { status: 500 });
  }
}