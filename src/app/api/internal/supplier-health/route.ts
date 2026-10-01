// 控制面侧的 supplier 健康读取端点。调用方是 Vercel 上的 /v1/model-status：
// Vercel 连不上控制面 Postgres 端口（与 biz-keys 同一约束），于是走这条签名通道。
//
// 2026-08-30 片六：model-status 探测与执行同源——执行侧可用性只认控制面
// supplier_capability + supplier/account health + cooldown（scheduler 同一把尺）。
// Vercel 经 GENERATION_CONTROL_PLANE_PROXY_ORIGIN 调这里拿真信号，探测与执行对齐。
//
// 鉴权复用 biz-key-sync 的 HMAC 通道（自定义 signatureDomain），不回显任何密钥。

import { NextRequest, NextResponse } from "next/server";
import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  verifyBizKeySync,
} from "@/lib/biz-key-sync";
import { readSupplierHealthSignal } from "@/lib/supplier-health-signal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

const SIGNATURE_DOMAIN = "supplier-health";

export async function POST(req: NextRequest) {
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!secret) return NextResponse.json({ ok: false, message: "签名通道未配置。" }, { status: 503 });

  // 签名覆盖的是字节：必须读原文再解析，且 body 应为空对象（本端点无参数）。
  const rawBody = await req.text();
  const verified = verifyBizKeySync({
    secret,
    timestamp: req.headers.get(BIZ_KEY_SYNC_TIMESTAMP_HEADER),
    signature: req.headers.get(BIZ_KEY_SYNC_SIGNATURE_HEADER),
    rawBody,
    signatureDomain: SIGNATURE_DOMAIN,
  });
  if (!verified) return NextResponse.json({ ok: false, message: "签名校验失败。" }, { status: 401 });

  const signal = await readSupplierHealthSignal();
  return NextResponse.json({ ok: true, signal });
}
