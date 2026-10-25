// GET /api/media-download?url=<encoded https URL> — 助理媒体（图／影片／音频）真下载通道（2026-10-03）。
//
// 存在理由：媒体卡的「下载」原本直接 <a download href=上游URL>：跨源时浏览器忽略
// download 属性、只会打开附件连结（暴君点名的病征）。本路由以站内同源身份代理位元组，
// 前端 fetch → blob → <a download> 才是真下载。
//
// 安全立场（防 SSRF）：只准上游 agent 媒体真源主机（由 AGENT_GATEWAY_DEFAULT_ORIGIN 推导，
// 不硬编第二份）；只认 https、拒绝 userinfo 与非预设埠；上游 fetch 用 redirect:"manual"
// （不跟随重定向，避免白名单主机被诱导跳内网）。大小上限 ~100MB（先看 content-length），
// 超时 ~30s，body 以 stream 回传、沿用上游 content-type。登入用户限定（requireVerifiedUser，
// NEXT_PUBLIC_LOCAL_TEST_MODE=true 时按站内惯例放行）。骨架照 src/app/api/blender-artifact/route.ts。

import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { isAllowedMediaUrl } from "./media-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

/** 上游回应大小上限（先看 content-length；缺失时交由平台/串流自然中止）。 */
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
/** 上游 fetch 超时。 */
const UPSTREAM_TIMEOUT_MS = 30_000;

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ ok: false, error: message, code }, { status });
}

export async function GET(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  const target = (req.nextUrl.searchParams.get("url") ?? "").trim();
  if (!target) return fail(400, "缺少 url 参数", "invalid_url");
  if (!isAllowedMediaUrl(target)) {
    return fail(400, "url 不在允许的媒体来源内", "invalid_url");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const headers = new Headers({ "Accept-Encoding": "identity" });
  // 播放器拖动和断点续传只请求所需区间，不能退化成重新下载整个文件。
  for (const name of ["range", "if-range"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  let upstream: Response;
  try {
    // redirect:"manual"：不跟随重定向。白名单主机若回 3xx，就当上游失败——
    // 跟随等于把 SSRF 白名单交给上游的 Location 决定。
    upstream = await fetch(target, { headers, signal: controller.signal, redirect: "manual", cache: "no-store" });
  } catch {
    return fail(504, "上游媒体读取超时或不可达", "upstream_timeout");
  } finally {
    // 只给「取 header」这一段超时；body 串流期间不 abort（否则大档会在 30s 被腰斩）。
    clearTimeout(timer);
  }

  if (upstream.status === 416) {
    await upstream.body?.cancel();
    return new NextResponse(null, {
      status: 416,
      headers: {
        "Cache-Control": "no-store",
        ...(upstream.headers.has("content-range")
          ? { "Content-Range": upstream.headers.get("content-range")! } : {}),
      },
    });
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel();
    return fail(502, `上游媒体读取失败（${upstream.status}）`, "upstream_error");
  }

  const rawContentLength = upstream.headers.get("content-length");
  const contentLength = rawContentLength === null ? NaN : Number(rawContentLength);
  if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_BYTES) {
    await upstream.body.cancel();
    return fail(413, "媒体文件超过大小上限", "too_large");
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...Object.fromEntries(["accept-ranges", "content-range", "etag", "last-modified"]
        .flatMap((name) => {
          const value = upstream.headers.get(name);
          return value === null ? [] : [[name, value]];
        })),
      ...((!upstream.headers.get("content-encoding") || upstream.headers.get("content-encoding") === "identity")
        && Number.isFinite(contentLength) && contentLength >= 0
        ? { "Content-Length": String(contentLength) } : {}),
    },
  });
}
