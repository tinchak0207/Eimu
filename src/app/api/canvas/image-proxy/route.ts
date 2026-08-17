// GET /api/canvas/image-proxy?url=<encoded> — 登入用戶的同源圖片代理。
//
// 存在理由：畫布像素編輯（裁剪/切图/抠除/旋转）要把生成結果讀進 <canvas>，
// 上游 CDN（302 出圖域）不一定放 CORS 頭，直接 fetch 會 taint。這裡以同源
// 身份代讀，只服務登入用戶、只認 https 公網主機、只回 image/*、上限 25MB。
//
// SSRF 立場：拒 IP 字面量與 localhost/*.local/*.internal——這個代理只為
// 「把公網圖片變同源」存在，不提供內網探測面。

import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ ok: false, error: message, code }, { status });
}

/** 主機黑名單：IP 字面量（v4/v6）、localhost、內網尾綴。 */
function isForbiddenHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  // IPv4 字面量
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6 字面量（URL hostname 形如 [::1] 去掉中括號後含冒號）
  if (host.includes(":")) return true;
  return false;
}

export async function GET(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  const raw = req.nextUrl.searchParams.get("url");
  if (!raw) return fail(400, "缺少 url 参数", "invalid_url");

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return fail(400, "url 不是合法网址", "invalid_url");
  }
  if (target.protocol !== "https:" || isForbiddenHost(target.hostname)) {
    return fail(400, "仅支持 https 公网图片地址", "invalid_url");
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch {
    return fail(502, "上游图片获取失败", "upstream_failed");
  }
  if (!upstream.ok) return fail(502, `上游返回 ${upstream.status}`, "upstream_failed");

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    return fail(415, `不是图片（${contentType || "无 content-type"}）`, "not_an_image");
  }
  const declared = Number(upstream.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return fail(413, "图片超过 25MB", "too_large");
  }

  // 邊讀邊計數：上游沒報 Content-Length（chunked）時，實讀超限即中斷。
  if (!upstream.body) return fail(502, "上游未返回内容", "upstream_failed");
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BYTES) {
        await reader.cancel();
        return fail(413, "图片超过 25MB", "too_large");
      }
      chunks.push(value);
    }
  } catch {
    return fail(502, "上游读取中断", "upstream_failed");
  }

  return new NextResponse(new Blob(chunks as BlobPart[], { type: contentType }), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
