// 控制面侧的代理池只读端点。只接受 HMAC 签名请求，不接受管理员会话 ——
// 调用方是 Vercel edge 上的 /api/admin/proxy-pool 中继，不是浏览器。
//
// 复用 biz-key-sync 的签名通道（同一把 GENERATION_BILLING_RELAY_SECRET），
// 但用自己的域前缀 "proxy-pool" 做域分隔：与密钥写入、计费中继的报文互不重放。

import { NextRequest, NextResponse } from "next/server";
import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  verifyBizKeySync,
} from "@/lib/biz-key-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

/** 本端点专属的域分隔前缀，勿与 biz-key-sync 混用。 */
const SIGNATURE_DOMAIN = "proxy-pool";

function fail(message: string, status: number) {
  return NextResponse.json({ ok: false, message }, { status });
}

export async function GET(req: NextRequest) {
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!secret) return fail("密钥同步通道未配置。", 503);

  // GET 没有请求体，签名覆盖空字符串载荷。
  const verified = verifyBizKeySync({
    secret,
    timestamp: req.headers.get(BIZ_KEY_SYNC_TIMESTAMP_HEADER),
    signature: req.headers.get(BIZ_KEY_SYNC_SIGNATURE_HEADER),
    rawBody: "",
    signatureDomain: SIGNATURE_DOMAIN,
  });
  if (!verified) return fail("签名校验失败。", 401);

  const apiKey = process.env.ADOBE2API_API_KEY ?? "";
  try {
    const response = await fetch("http://adobe2api:6001/api/v1/proxy-pool", {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!response.ok) {
      return NextResponse.json({ success: true, data: { available: false, reason: `upstream HTTP ${response.status}` } });
    }
    const upstream = (await response.json()) as { enabled?: boolean; proxies?: unknown };
    return NextResponse.json({ success: true, data: { available: true, enabled: upstream.enabled, proxies: upstream.proxies } });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "上游请求失败";
    return NextResponse.json({ success: true, data: { available: false, reason } });
  }
}
