// Vercel 側的 mPay 訂單查詢中繼端點——付款對帳器的**上游取數來源**。
//
// 為什麼需要它：付款對帳器（src/lib/generation-core/mapay-order-reconciliation.ts）跑在控制面
// （它需要控制面 DB 才算得了帳），但它查支付商訂單時要 mPay 憑證 MAPAY_PID／MAPAY_KEY，而
// 這兩個憑證**只存在於 Vercel**（且被標為 Sensitive，控制面拿不到）。生產實測控制面
// /image-control/api/payments/mapay/health 回 {"configured":false,...}——偵測器看不見。
//
// 拓撲修正：誰有憑證誰去問上游，誰有帳本誰判定。
//   控制面（有帳本、無憑證）→ HMAC 打本端點 → Vercel（有憑證）→ 直連支付商 → 原樣回傳訂單。
// 本端點**只讀**：不寫我方帳本／額度，也不寫任何其他地方；拿到的原始響應由既有客戶端
// （mapay-orders.ts）在日誌中遮蔽 pid/key 後落地，本端點不回顯任何憑證。
//
// 鑑權復用 biz-key-sync 的 HMAC 通道，signatureDomain 用本用途專屬的 "mapay-orders"
// （與 mapay-credit / mapay-intake / first-charge 同一骨架；不得沿用 "biz-key-sync"）。
// 這是 first-charge.ts「控制面無 DB → 問 Vercel」骨架的鏡像：這裡是
// 「控制面無憑證 → 問 Vercel」。

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
export const preferredRegion = "sfo1"; // 上游支付商與控制面都在矽谷，同區省一趟橫跨美國

interface RelayBody {
  op?: unknown;
  since?: unknown;
  until?: unknown;
  outTradeNo?: unknown;
}

/** 時間參數只在可解析時透傳；不可解析＝呼叫方給錯，回 400 而不是靜默忽略。 */
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

  // 簽名覆蓋的是位元組：必須讀原文再解析。
  const rawBody = await req.text();
  const verified = verifyBizKeySync({
    secret,
    timestamp: req.headers.get(BIZ_KEY_SYNC_TIMESTAMP_HEADER),
    signature: req.headers.get(BIZ_KEY_SYNC_SIGNATURE_HEADER),
    rawBody,
    signatureDomain: MAPAY_ORDERS_RELAY_SIGNATURE_DOMAIN,
  });
  // 驗簽失敗不回顯任何細節（誰、為何）。
  if (!verified) return NextResponse.json({ ok: false, code: "unauthorized" }, { status: 401 });

  // 憑證就在本實例（Vercel）；缺失＝這個部署沒有資格回答，明確回錯誤碼、不洩漏細節。
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
      // 憑證由本機 process.env 解析（getMapayConfig 內）；只讀查詢。
      const result = await fetchMapayOrders(window);
      return NextResponse.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const kind = error instanceof MapayOrdersError ? error.kind : "upstream";
      // 只記 kind，不記憑證/原始響應（原始響應已由客戶端遮蔽後自行落日誌）。
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