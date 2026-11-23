import { NextRequest, NextResponse } from "next/server";
import { completeMiniappLogin } from "@/lib/miniapp-login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 游客登录：评委/他人在开发者工具里用 touristappid（或无该 AppID 权限）导入时，wx.login 换不到可用 code，
 * 小程序改走本端点。身份＝客户端生成并保存的随机 deviceId；注册礼与微信登录同一 50 币、同一幂等占位。
 * 防刷：同 IP 每小时 20 次、全站每天 600 次（进程内计数，重启归零；超限回 429，不静默放行）。
 */
const DEVICE_ID_RE = /^[a-f0-9]{32}$/;
const PER_IP_PER_HOUR = 20;
const GLOBAL_PER_DAY = 600;
const ipHits = new Map<string, number[]>();
let globalDay = "";
let globalCount = 0;

function allow(ip: string, now: number): boolean {
  const day = new Date(now).toISOString().slice(0, 10);
  if (day !== globalDay) { globalDay = day; globalCount = 0; }
  if (globalCount >= GLOBAL_PER_DAY) return false;
  const recent = (ipHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= PER_IP_PER_HOUR) { ipHits.set(ip, recent); return false; }
  recent.push(now);
  ipHits.set(ip, recent);
  if (ipHits.size > 5000) for (const [k, v] of ipHits) if (!v.some((t) => now - t < 3_600_000)) ipHits.delete(k);
  globalCount += 1;
  return true;
}

export async function POST(req: NextRequest) {
  const passwordSeed = process.env.WECHAT_CALLBACK_SECRET?.trim();
  if (!passwordSeed) return NextResponse.json({ success: false, message: "not_configured" }, { status: 503 });
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, message: "bad_json" }, { status: 400 });
  }
  const deviceId = body && typeof body === "object" && typeof (body as { deviceId?: unknown }).deviceId === "string"
    ? (body as { deviceId: string }).deviceId.trim().toLowerCase() : "";
  if (!DEVICE_ID_RE.test(deviceId)) return NextResponse.json({ success: false, message: "invalid_device" }, { status: 400 });
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!allow(ip, Date.now())) return NextResponse.json({ success: false, message: "rate_limited" }, { status: 429 });
  try {
    return await completeMiniappLogin(`miniguest:${deviceId}`, passwordSeed);
  } catch {
    return NextResponse.json({ success: false, message: "guest_login_unavailable" }, { status: 502 });
  }
}
