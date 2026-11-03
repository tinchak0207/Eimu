import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";

export const preferredRegion = "sfo1";

// worker 的动态 QR：每次请求触发产生全新 QR（扫码即建立新 bot 实体，必须最新）。
// 不再写死公网 IP 默认值（S-07 审计）：未配置 WECHAT_WORKER_NEW_QR_URL 时直接 503，不外呼。
// 风险备注：上游若仍是明文 http（非 https），QR 内容与调用在链路上可被窥探／篡改；
// 部署环境未知故不强制改协议，建议把 worker 放到 https 或内网后再配置该变量。
const WORKER_NEW_QR_URL = process.env.WECHAT_WORKER_NEW_QR_URL?.trim() || "";
// 无 worker 时的兜底（通常留空，确保 QR 永远来自 worker）。
const FALLBACK_QR_URL = process.env.WECHAT_BOT_QR_URL?.trim() || "";

// 进程内简单限流（每次 GET 会在 worker 上新建 bot 实体）：
//   - 单来源：同一 key 每分钟最多 RATE_LIMIT 次；
//   - 全局：所有 key 合计每分钟最多 GLOBAL_RATE_LIMIT 次（XFF 被伪造时对 worker 仍有上界）；
//   - Map 硬上限 MAX_KEYS，清理最多每 SWEEP_INTERVAL_MS 一次，满了仍满时对新 key 直接拒绝（不再扫描）。
// 来源 key 取 XFF 的**最后一段**：nginx `$proxy_add_x_forwarded_for` 会把真实 IP 追加在末段，
// 首段是客户端可伪造的；Vercel 则覆写为单值，末段同样正确。
// serverless 多实例下是尽力而为。
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 6;
const GLOBAL_RATE_LIMIT = 60;
const MAX_KEYS = 5000;
const SWEEP_INTERVAL_MS = 60_000;
const ipHits = new Map<string, number[]>();
let globalHits: number[] = [];
let lastSweepAt = 0;

function clientKey(req: NextRequest): string {
  const parts = (req.headers.get("x-forwarded-for") ?? "").split(",");
  return parts[parts.length - 1]?.trim() || "unknown";
}

function allowRequest(ip: string, now: number): boolean {
  const cutoff = now - RATE_WINDOW_MS;

  if (now - lastSweepAt >= SWEEP_INTERVAL_MS) {
    lastSweepAt = now;
    for (const [key, list] of ipHits) {
      if (!list.some((timestamp) => timestamp > cutoff)) ipHits.delete(key);
    }
  }

  globalHits = globalHits.filter((timestamp) => timestamp > cutoff);
  if (globalHits.length >= GLOBAL_RATE_LIMIT) return false;

  const existing = ipHits.get(ip);
  if (!existing && ipHits.size >= MAX_KEYS) return false;
  const hits = (existing ?? []).filter((timestamp) => timestamp > cutoff);
  if (hits.length >= RATE_LIMIT) {
    ipHits.set(ip, hits);
    return false;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  globalHits.push(now);
  return true;
}

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
  // 先判配置再计数：未配置的 503 不占限流额度。
  if (!WORKER_NEW_QR_URL && !FALLBACK_QR_URL) {
    return NextResponse.json({ success: false, message: "bot_qr_not_configured" }, { status: 503 });
  }
  if (!allowRequest(clientKey(req), Date.now())) {
    return NextResponse.json(
      { success: false, message: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } },
    );
  }

  const size = Math.min(Number(req.nextUrl.searchParams.get("size")) || 240, 480);

  const url = (WORKER_NEW_QR_URL ? await fetchFreshQrUrl() : null) || FALLBACK_QR_URL;
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