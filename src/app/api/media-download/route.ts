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
import { AGENT_GATEWAY_DEFAULT_ORIGIN } from "@/lib/agent-gateway";
import { requireVerifiedUser } from "@/lib/server-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

/** 白名單主機：agent 媒體真源（store.tinchak0207.xyz）由 gateway origin 推導，不硬編第二份。 */
const ALLOWED_MEDIA_HOST = new URL(AGENT_GATEWAY_DEFAULT_ORIGIN).hostname;

/** 上游回應大小上限（先看 content-length；缺失時交由平台/串流自然中止）。 */
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
/** 上游 fetch 超時。 */
const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * 白名單判定（純函式，可直測）：只收 agent 媒體真源主機的 https URL。
 *  - 相對路徑／畸形字串／非 http(s) → 拒（`new URL` 無 base 會拋）；
 *  - `http://` → 拒（明文）；
 *  - 帶 userinfo（`u:p@host`）→ 拒（會把真實主機藏在 @ 前，是 SSRF/混淆常見手法）；
 *  - 非預設埠 → 拒（hostname 相同但連到別的服務）；
 *  - 主機不在白名單 → 拒。
 * 值域獨立於本路由的 fetch 實作——測試對每一類輸入獨立斷言。
 */
export function isAllowedMediaUrl(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const clean = raw.trim();
  if (!clean) return false;
  let parsed: URL;
  try {
    parsed = new URL(clean);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port !== "") return false;
  return parsed.hostname === ALLOWED_MEDIA_HOST;
}

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
