// GET /api/canvas/image-proxy?url=<encoded> — 登入用户的同源图片代理。
//
// 存在理由：画布像素编辑（裁剪/切图/抠除/旋转）要把生成结果读进 <canvas>，
// 上游 CDN（302 出图域）不一定放 CORS 头，直接 fetch 会 taint。这里以同源
// 身份代读，只服务登入用户、只认 https 公网主机、只回 image/*、上限 25MB。
//
// SSRF 立场：拒 IP 字面量与 localhost/*.local/*.internal——这个代理只为
// 「把公网图片变同源」存在，不提供内网探测面。

import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const MAX_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ ok: false, error: message, code }, { status });
}

/** 主机黑名单：IP 字面量（v4/v6）、localhost、内网尾缀。 */
function isForbiddenHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  // IPv4 字面量
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6 字面量（URL hostname 形如 [::1] 去掉中括号后含冒号）
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
      redirect: "manual",
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location");
      if (!location) return fail(400, "重定向地址缺失", "invalid_url");
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        return fail(400, "重定向地址不合法", "invalid_url");
      }
      if (next.protocol !== "https:" || isForbiddenHost(next.hostname)) {
        return fail(400, "重定向目标不是 https 公网图片地址", "invalid_url");
      }
      upstream = await fetch(next, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "manual",
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        return fail(400, "重定向目标不合法", "invalid_url");
      }
    }
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

  // 边读边计数：上游没报 Content-Length（chunked）时，实读超限即中断。
  if (!upstream.body) return fail(502, "上游未返回内容", "upstream_failed");
  let received = 0;
  // 立即交付第一块数据，避免弱网下必须等整张原图下载完才开始显示。
  // TransformStream 保留背压；超限会取消上游，不在函数内保留整图副本。
  const body = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > MAX_BYTES) {
        controller.error(new Error("图片超过 25MB"));
        return;
      }
      controller.enqueue(chunk);
    },
  }));

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      ...((!upstream.headers.get("content-encoding") || upstream.headers.get("content-encoding") === "identity")
        && upstream.headers.has("content-length") && Number.isFinite(declared) && declared >= 0
        ? { "Content-Length": String(declared) } : {}),
    },
  });
}
