// Vercel 侧的 mPay 订单查询中继端点——付款对帐器的**上游取数来源**。
//
// 为什么需要它：付款对帐器（src/lib/generation-core/mapay-order-reconciliation.ts）跑在控制面
// （它需要控制面 DB 才算得了帐），但它查支付商订单时要 mPay 凭证 MAPAY_PID／MAPAY_KEY，而
// 这两个凭证**只存在于 Vercel**（且被标为 Sensitive，控制面拿不到）。生产实测控制面
// /image-control/api/payments/mapay/health 回 {"configured":false,...}——侦测器看不见。
//
// 拓扑修正：谁有凭证谁去问上游，谁有帐本谁判定。
//   控制面（有帐本、无凭证）→ HMAC 打本端点 → Vercel（有凭证）→ 直连支付商 → 原样回传订单。
// 本端点**只读**：不写我方帐本／额度，也不写任何其他地方；拿到的原始响应由既有客户端
// （mapay-orders.ts）在日志中遮蔽 pid/key 后落地，本端点不回显任何凭证。
//
// 鉴权复用 biz-key-sync 的 HMAC 通道，signatureDomain 用本用途专属的 "mapay-orders"
// （与 mapay-credit / mapay-intake / first-charge 同一骨架；不得沿用 "biz-key-sync"）。
// 这是 first-charge.ts「控制面无 DB → 问 Vercel」骨架的镜像：这里是
// 「控制面无凭证 → 问 Vercel」。

import { NextRequest, NextResponse } from "next/server";
import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  verifyBizKeySync,
} from "@/lib/biz-key-sync";
import { getMapayConfig } from "@/lib/mapay";
import {
  MAPAY_ORDERS_RELAY_SIGNATURE_DOMAIN,
  MapayOrdersError,
  fetchMapayOrder,
  fetchMapayOrders,
} from "@/lib/mapay-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游支付商与控制面都在矽谷，同区省一趟横跨美国

interface RelayBody {
  op?: unknown;
  since?: unknown;
  until?: unknown;
  outTradeNo?: unknown;
}

/** 时间参数只在可解析时透传；不可解析＝呼叫方给错，回 400 而不是静默忽略。 */
function parseWindow(body: RelayBody): { since?: string; until?: string } | null {
  const out: { since?: string; until?: string } = {};
  for (const key of ["since", "until"] as const) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw !== "string") return null;
    const date = new Date(raw);
    if (!Number.isFinite(date.getTime())) return null;
    out[key] = date.toISOString();
  }
  return out;
}

export async function POST(req: NextRequest) {
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!secret) return NextResponse.json({ ok: false, code: "relay_unconfigured" }, { status: 503 });

  // 签名覆盖的是位元组：必须读原文再解析。
  const rawBody = await req.text();
  const verified = verifyBizKeySync({
    secret,
    timestamp: req.headers.get(BIZ_KEY_SYNC_TIMESTAMP_HEADER),
    signature: req.headers.get(BIZ_KEY_SYNC_SIGNATURE_HEADER),
    rawBody,
    signatureDomain: MAPAY_ORDERS_RELAY_SIGNATURE_DOMAIN,
  });
  // 验签失败不回显任何细节（谁、为何）。
  if (!verified) return NextResponse.json({ ok: false, code: "unauthorized" }, { status: 401 });

  // 凭证就在本实例（Vercel）；缺失＝这个部署没有资格回答，明确回错误码、不泄漏细节。
  try {
    getMapayConfig();
  } catch {
    return NextResponse.json({ ok: false, code: "credentials_missing" }, { status: 503 });
  }

  let body: RelayBody;
  try {
    body = JSON.parse(rawBody) as RelayBody;
  } catch {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }

  if (body.op === "orders") {
    const window = parseWindow(body);
    if (!window) return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
    try {
      // 凭证由本机 process.env 解析（getMapayConfig 内）；只读查询。
      const result = await fetchMapayOrders(window);
      return NextResponse.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const kind = error instanceof MapayOrdersError ? error.kind : "upstream";
      // 只记 kind，不记凭证/原始响应（原始响应已由客户端遮蔽后自行落日志）。
      console.error(`[internal/mapay-orders] op=orders failed kind=${kind}`);
      return NextResponse.json({ ok: false, code: "upstream_error", kind }, { status: 502 });
    }
  }

  if (body.op === "order") {
    const outTradeNo = typeof body.outTradeNo === "string" ? body.outTradeNo.trim() : "";
    if (!outTradeNo || outTradeNo.length > 64) {
      return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
    }
    try {
      const order = await fetchMapayOrder(outTradeNo);
      return NextResponse.json({ ok: true, order }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const kind = error instanceof MapayOrdersError ? error.kind : "upstream";
      console.error(`[internal/mapay-orders] op=order failed kind=${kind}`);
      return NextResponse.json({ ok: false, code: "upstream_error", kind }, { status: 502 });
    }
  }

  return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
}