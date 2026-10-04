// 控制面侧的 mPay 回调落地存证端点（履约副作用之前先写一笔，见 src/lib/mapay-intake.ts）。
//
// 呼叫方：Vercel 上 /api/payments/mapay/notify
//   op=record    upsert 一条 intake（state='received'）
//   op=fulfilled 履约成功后回标 fulfilled + delivery
//
// 鉴权复用 biz-key-sync 的 HMAC 通道（signatureDomain "mapay-intake"），
// 与 mapay-credit / welcome-gift / user-attribution 同一骨架；不回显任何内部错误细节。

import { NextRequest, NextResponse } from "next/server";
import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  verifyBizKeySync,
} from "@/lib/biz-key-sync";
import { generationDatabaseConfigured, getGenerationSql } from "@/lib/generation-core/database";
import {
  MAPAY_INTAKE_RELAY_SIGNATURE_DOMAIN,
  createPostgresMapayIntakeStore,
  type MapayIntakeDelivery,
} from "@/lib/mapay-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
    signatureDomain: MAPAY_INTAKE_RELAY_SIGNATURE_DOMAIN,
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

  const body = parsed as {
    op?: unknown;
    orderId?: unknown;
    rawParams?: unknown;
    money?: unknown;
    planId?: unknown;
    param?: unknown;
    userId?: unknown;
    delivery?: unknown;
    detail?: unknown;
  } | null;

  const orderId = typeof body?.orderId === "string" ? body.orderId.trim() : "";
  if (!orderId || orderId.length > 64) {
    return NextResponse.json({ ok: false, message: "缺少合法的 orderId。" }, { status: 400 });
  }

  try {
    const store = createPostgresMapayIntakeStore(getGenerationSql());

    if (body?.op === "record") {
      const rawParams =
        body.rawParams && typeof body.rawParams === "object" && !Array.isArray(body.rawParams)
          ? (body.rawParams as Record<string, string>)
          : {};
      const userIdRaw = body.userId;
      const userId =
        userIdRaw === null || userIdRaw === undefined
          ? null
          : Number.isInteger(Number(userIdRaw)) && Number(userIdRaw) > 0
            ? Number(userIdRaw)
            : null;
      const state = await store.record({
        orderId,
        rawParams,
        money: asNullableString(body.money),
        planId: asNullableString(body.planId),
        param: asNullableString(body.param),
        userId,
      });
      return NextResponse.json({ ok: true, outcome: "recorded", state });
    }

    if (body?.op === "fulfilled") {
      const delivery = body.delivery;
      if (delivery !== "direct_credit" && delivery !== "redemption_code") {
        return NextResponse.json({ ok: false, message: "缺少合法的 delivery。" }, { status: 400 });
      }
      await store.markFulfilled(orderId, delivery as MapayIntakeDelivery, asNullableString(body.detail) ?? undefined);
      return NextResponse.json({ ok: true, outcome: "fulfilled" });
    }

    return NextResponse.json({ ok: false, message: "未知的操作。" }, { status: 400 });
  } catch (error) {
    console.error(
      `[internal/mapay-intake] failed order=${orderId} op=${String(body?.op)}：${error instanceof Error ? error.message : String(error)}`,
    );
    return NextResponse.json({ ok: false, message: "落地失败。" }, { status: 500 });
  }
}