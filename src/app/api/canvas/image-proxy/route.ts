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
import { ImageTooLargeError, SsrfBlockedError, isForbiddenHost, safeFetchPublicImage } from "@/lib/ssrf-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const MAX_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ ok: false, error: message, code }, { status });
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

  // 逐跳校验（≤3 跳）+ DNS 解析后 IP 校验 + 连接钉 IP，全在共享守卫里（@/lib/ssrf-guard）。
  let upstream: Response;
  try {
    upstream = await safeFetchPublicImage(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), maxBytes: MAX_BYTES });
  } catch (error) {
    if (error instanceof SsrfBlockedError) return fail(400, "目标不是 https 公网图片地址", "invalid_url");
    return fail(502, "上游图片获取失败", "upstream_failed");
  }
  // 网络错误、非 2xx、非图片对外同一文案同一状态码（不泄露状态码/content-type 侧信道）。
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !contentType.startsWith("image/")) {
    await upstream.body?.cancel().catch(() => {});
    return fail(502, "上游图片获取失败", "upstream_failed");
  }
  const declared = Number(upstream.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return fail(413, "图片超过 25MB", "too_large");
  }

  // 边读边计数：上游没报 Content-Length（chunked）时，实读超限即中断。
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
  } catch (error) {
    if (error instanceof ImageTooLargeError) return fail(413, "图片超过 25MB", "too_large");
    return fail(502, "上游图片获取失败", "upstream_failed");
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
