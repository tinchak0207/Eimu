import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";

export const preferredRegion = "sfo1";

// worker 的动态 QR：每次请求触发产生全新 QR（扫码即建立新 bot 实体，必须最新）。
const WORKER_NEW_QR_URL =
  process.env.WECHAT_WORKER_NEW_QR_URL?.trim() || "http://43.172.85.76:8780/new-qr";
// 无 worker 时的兜底（通常留空，确保 QR 永远来自 worker）。
const FALLBACK_QR_URL = process.env.WECHAT_BOT_QR_URL?.trim() || "";

async function fetchFreshQrUrl(): Promise<string | null> {
  try {
    const res = await fetch(WORKER_NEW_QR_URL, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { success?: boolean; url?: string | null };
    return data.url || null;
  } catch {
    // 尝试 GET 兜底拿目前 QR
    try {
      const res = await fetch(WORKER_NEW_QR_URL.replace("/new-qr", "/qr"), {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { url?: string | null };
      return data.url || null;
    } catch {
      return null;
    }
  }
}

export async function GET(req: NextRequest) {
  const size = Math.min(Number(req.nextUrl.searchParams.get("size")) || 240, 480);

  const url = (await fetchFreshQrUrl()) || FALLBACK_QR_URL;
  if (!url) {
    return NextResponse.json({ success: false, message: "bot_qr_unavailable" }, { status: 503 });
  }

  try {
    const svg = await QRCode.toString(url, {
      type: "svg",
      margin: 1,
      width: size,
      errorCorrectionLevel: "M",
    });
    return new NextResponse(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[wechat/qr]", err);
    return NextResponse.json({ success: false, message: "qr_failed" }, { status: 500 });
  }
}