// 控制面側的 mPay 直達入帳端點（付款直接綁用戶加額，不再發兌換碼）。
//
// 呼叫方：Vercel 上
//   - /api/payments/mapay/notify（mPay 回調驗簽通過後直接入帳）
//   - /api/payments/mapay/return（回跳頁只讀狀態，決定顯示「已到账」還是走舊兌換碼流程）
//
// 鑑權復用 biz-key-sync 的 HMAC 通道（signatureDomain "mapay-credit"），
// 與 welcome-gift / user-attribution / newapi-session-token 同一骨架；不回顯任何內部錯誤細節。
//
// 金額口徑一律由控面自己重算（planId → plans.ts），**不接受呼叫方傳來的額度**；
// 上游調額不冪等，冪等鍵是 mPay 的 out_trade_no（mapay_credit 主鍵）。

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
import { resolvePricingPlan } from "@/lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 已佔位記錄 → 只讀回報用結果詞（applied 以外的狀態呼叫方不得再發一次）。 */
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

  // 只讀：回跳頁據此決定顯示「已到账」還是退回兌換碼流程。
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
  const plan = planId ? resolvePricingPlan(planId) : null;
  if (!plan) return NextResponse.json({ ok: false, message: "缺少合法的 planId。" }, { status: 400 });

  try {
    const outcome = await runMapayCreditWithSql(getGenerationSql(), {
      orderId,
      userId,
      planId: plan.id,
      amountQuota: mapayPlanQuota(plan),
    });
    console.info("[internal/mapay-credit]", { order_id: orderId, user_id: userId, plan_id: plan.id, outcome });
    return NextResponse.json({ ok: true, outcome });
  } catch (error) {
    console.error(
      `[internal/mapay-credit] credit failed order=${orderId} user=${userId}：${error instanceof Error ? error.message : String(error)}`,
    );
    return NextResponse.json({ ok: false, message: "入账失败。" }, { status: 500 });
  }
}