// GET /api/media-download?url=<encoded https URL> — 助理媒體（圖／影片／音頻）真下載通道（2026-10-03）。
//
// 存在理由：媒體卡的「下載」原本直接 <a download href=上游URL>：跨源時瀏覽器忽略
// download 屬性、只會打開附件連結（暴君點名的病徵）。本路由以站內同源身份代理位元組，
// 前端 fetch → blob → <a download> 才是真下載。
//
// 安全立場（防 SSRF）：只准上游 agent 媒體真源主機（由 AGENT_GATEWAY_DEFAULT_ORIGIN 推導，
// 不硬編第二份）；只認 https、拒絕 userinfo 與非預設埠；上游 fetch 用 redirect:"manual"
// （不跟隨重定向，避免白名單主機被誘導跳內網）。大小上限 ~100MB（先看 content-length），
// 超時 ~30s，body 以 stream 回傳、沿用上游 content-type。登入用戶限定（requireVerifiedUser，
// NEXT_PUBLIC_LOCAL_TEST_MODE=true 時按站內慣例放行）。骨架照 src/app/api/blender-artifact/route.ts。

import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { isAllowedMediaUrl } from "./media-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

/** 上游回應大小上限（先看 content-length；缺失時交由平台/串流自然中止）。 */
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
/** 上游 fetch 超時。 */
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
  let upstream: Response;
  try {
    // redirect:"manual"：不跟隨重定向。白名單主機若回 3xx，就當上游失敗——
    // 跟隨等於把 SSRF 白名單交給上游的 Location 決定。
    upstream = await fetch(target, { signal: controller.signal, redirect: "manual", cache: "no-store" });
  } catch {
    return fail(504, "上游媒体读取超时或不可达", "upstream_timeout");
  } finally {
    // 只給「取 header」這一段超時；body 串流期間不 abort（否則大檔會在 30s 被腰斬）。
    clearTimeout(timer);
  }

  if (!upstream.ok || !upstream.body) {
    return fail(502, `上游媒体读取失败（${upstream.status}）`, "upstream_error");
  }

  const contentLength = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_BYTES) {
    return fail(413, "媒体文件超过大小上限", "too_large");
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(Number.isFinite(contentLength) ? { "Content-Length": String(contentLength) } : {}),
    },
  });
}
