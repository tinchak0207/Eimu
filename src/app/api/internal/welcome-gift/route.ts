// 控制面侧的新人礼端点。调用方：
//   - Vercel 上 /api/auth/me（src/lib/welcome-gift-login.ts）：op=grant 发放；
//     站内通知写完后 op=noticed 回执（占位表 noticed_at）
//   - 运维回溯（在控制面容器内签名后打本端点）：op=backfill，可带 dryRun
//
// 鉴权复用 biz-key-sync 的 HMAC 通道（signatureDomain "welcome-gift"），
// 与 newapi-session-token / pwa-handoff 同一骨架；不回显任何密钥或内部错误细节。

import { NextRequest, NextResponse } from "next/server";
import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  verifyBizKeySync,
} from "@/lib/biz-key-sync";
import { generationDatabaseConfigured } from "@/lib/generation-core/database";
import {
  WELCOME_GIFT_RELAY_SIGNATURE_DOMAIN,
  backfillWelcomeGifts,
  grantWelcomeGift,
  createPostgresWelcomeGiftStore,
  productionWelcomeGiftDeps,
} from "@/lib/welcome-gift";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WelcomeGiftBody {
  op?: unknown;
  userId?: unknown;
  dryRun?: unknown;
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
    signatureDomain: WELCOME_GIFT_RELAY_SIGNATURE_DOMAIN,
  });
  if (!verified) return NextResponse.json({ ok: false, message: "签名校验失败。" }, { status: 401 });

  let body: WelcomeGiftBody;
  try {
    body = JSON.parse(rawBody) as WelcomeGiftBody;
  } catch {
    return NextResponse.json({ ok: false, message: "请求体不是合法 JSON。" }, { status: 400 });
  }

  if (!generationDatabaseConfigured()) {
    return NextResponse.json({ ok: false, message: "帐本储存层未配置。" }, { status: 503 });
  }

  try {
    if (body.op === "backfill") {
      const summary = await backfillWelcomeGifts(productionWelcomeGiftDeps(), { dryRun: body.dryRun === true });
      return NextResponse.json({ ok: true, summary });
    }

    const userId = typeof body.userId === "number" ? body.userId : Number.NaN;
    const op = body.op ?? "grant";
    if ((op !== "grant" && op !== "noticed") || !Number.isInteger(userId) || userId <= 0) {
      return NextResponse.json({ ok: false, message: "缺少合法的 op 或 userId。" }, { status: 400 });
    }
    if (op === "noticed") {
      const updated = await createPostgresWelcomeGiftStore().markNoticed(userId);
      return NextResponse.json({ ok: true, updated });
    }
    const result = await grantWelcomeGift(userId, productionWelcomeGiftDeps());
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    console.error("[internal/welcome-gift] failed", error);
    return NextResponse.json({ ok: false, message: "新人礼处理失败。" }, { status: 500 });
  }
}
