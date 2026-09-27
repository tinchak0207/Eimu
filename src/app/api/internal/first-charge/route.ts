// 控制面侧的首充专享（first-charge）端点——只读资格查询。
//
// 调用方（都在 Vercel 上）：
//   - GET /api/payments/first-charge/eligibility：定价页首充卡要不要显示；
//   - /api/payments/mapay/checkout：无资格的人下单首充档 → 403（限一次的优惠不容许无资格下单）；
//   - /api/payments/mapay/notify：直达入帐通道不可用、退回旧兑换码流程时，按「本单是否就是名额
//     持有单」决定发 300 币还是按正价折算的 70 币（带 outTradeNo 的那一路就是这个用途）。
//
// 判准唯一权威在 src/lib/first-charge.ts（帐本无 recharge 行 + 从未买过本档）；本端点只做
// 参数校验与转发，不回显内部错误细节。鉴权复用 biz-key-sync 的 HMAC 通道
// （signatureDomain "first-charge"），与 welcome-gift / user-attribution 同一骨架。
//
// 写侧不在这里：放额（与名额登记）长在 mapay-credit 的入帐通道上，因为那是钱真正落地、
// 也是 notify 的必经之路（见 src/app/api/internal/mapay-credit/route.ts）。

import { NextRequest, NextResponse } from "next/server";
import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  verifyBizKeySync,
} from "@/lib/biz-key-sync";
import { generationDatabaseConfigured, getGenerationSql } from "@/lib/generation-core/database";
import {
  FIRST_CHARGE_RELAY_SIGNATURE_DOMAIN,
  checkFirstChargeEligibilityWithSql,
} from "@/lib/first-charge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FirstChargeBody {
  op?: unknown;
  userId?: unknown;
  outTradeNo?: unknown;
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
    signatureDomain: FIRST_CHARGE_RELAY_SIGNATURE_DOMAIN,
  });
  if (!verified) return NextResponse.json({ ok: false, message: "签名校验失败。" }, { status: 401 });

  if (!generationDatabaseConfigured()) {
    return NextResponse.json({ ok: false, message: "帐本储存层未配置。" }, { status: 503 });
  }

  let body: FirstChargeBody;
  try {
    body = JSON.parse(rawBody) as FirstChargeBody;
  } catch {
    return NextResponse.json({ ok: false, message: "请求体不是合法 JSON。" }, { status: 400 });
  }

  if (body.op !== "eligibility") {
    return NextResponse.json({ ok: false, message: "未知的操作。" }, { status: 400 });
  }

  const userId = Number(body.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ ok: false, message: "缺少合法的 userId。" }, { status: 400 });
  }
  // 单号只用于「名额是不是本单占的」判定；长度按 mPay 单号上限收敛。
  const outTradeNo = typeof body.outTradeNo === "string" ? body.outTradeNo.trim() : "";
  if (outTradeNo.length > 64) {
    return NextResponse.json({ ok: false, message: "缺少合法的 outTradeNo。" }, { status: 400 });
  }

  try {
    const result = await checkFirstChargeEligibilityWithSql(getGenerationSql(), {
      userId,
      ...(outTradeNo ? { outTradeNo } : {}),
    });
    console.info("[internal/first-charge]", { user_id: userId, status: result.status });
    return NextResponse.json({ ok: true, eligible: result.eligible, status: result.status });
  } catch (error) {
    console.error(
      `[internal/first-charge] eligibility failed user=${userId}：${error instanceof Error ? error.message : String(error)}`,
    );
    return NextResponse.json({ ok: false, message: "资格查询失败。" }, { status: 500 });
  }
}