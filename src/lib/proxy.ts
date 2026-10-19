import { NextRequest, NextResponse } from "next/server";
import { getGatewayBaseUrl } from "@/lib/new-api-auth-server";

interface ProxyOptions {
  upstreamPath?: string;
  public?: boolean;
  revalidate?: number;
  /** 非 public 路由的 GET 成功响应加 `Cache-Control: private, max-age=<browserCache>`（秒）。 */
  browserCache?: number;
}

type RouteContext = { params: Promise<Record<string, string>> };

// 脱敏实作已抽到 `@/lib/upstream-sanitizer`（纯函式、零依赖，Edge middleware 可引用）；
// 本档 re-export 以维持既有 import 面（各路由 import from "@/lib/proxy"）。
// 方法论、指纹清单与历史破口见该档头部注释。
import {
  SANITIZED_MESSAGE,
  containsInternalLeak,
  isErrorShapedPayload,
  sanitizeUpstreamBody,
  sanitizeUpstreamMessage,
  sanitizeUpstreamValue,
  stripInternalSuccessKeys,
} from "@/lib/upstream-sanitizer";

export {
  SANITIZED_MESSAGE,
  containsInternalLeak,
  sanitizeUpstreamBody,
  sanitizeUpstreamMessage,
  sanitizeUpstreamValue,
};

export function makeProxy(opts: ProxyOptions = {}) {
  return async function handler(
    req: NextRequest,
    context: RouteContext,
  ): Promise<NextResponse> {
    const auth = req.headers.get("authorization") ?? "";
    const userId = req.headers.get("x-user-id") ?? "";

    if (!opts.public && !auth) {
      return NextResponse.json({ success: false, message: "未登录" }, { status: 401 });
    }

    const params = context?.params ? await context.params : {};

    let upstreamPath = opts.upstreamPath ?? req.nextUrl.pathname;
    for (const [key, val] of Object.entries(params)) {
      upstreamPath = upstreamPath.replace(`:${key}`, val);
    }

    const qs = req.nextUrl.searchParams.toString();
    const url = `${getGatewayBaseUrl()}${upstreamPath}${qs ? `?${qs}` : ""}`;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth) headers["Authorization"] = auth;
    if (userId) headers["New-Api-User"] = userId;

    const fetchOpts: RequestInit = {
      method: req.method,
      headers,
      ...(opts.revalidate !== undefined
        ? { next: { revalidate: opts.revalidate } }
        : { cache: "no-store" }),
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      const body = await req.text();
      if (body) fetchOpts.body = body;
    }

    try {
      const upstream = await fetch(url, fetchOpts);
      const data = await upstream.json();
      // 出站前统一脱敏（见上方 INTERNAL_LEAK_*）。判为错误形状时额外洗键名：
      // 非 2xx，或 HTTP 200 但 payload 形状是错误（内部头名/栏位名键本身就是泄漏面）。
      // 成功体功能面不变（只洗值），但再套同一道**栏位闸**清内部基础设施键名
      // （`stripInternalSuccessKeys`，与 middleware 共用；红队 2026-10-05：成功信封曾原样穿过）。
      const errorShaped = !upstream.ok || isErrorShapedPayload(data);
      const sanitized = sanitizeUpstreamValue(data, { cleanKeys: errorShaped });
      const payload = errorShaped ? sanitized : stripInternalSuccessKeys(sanitized).value;
      const response = NextResponse.json(payload, { status: upstream.status });

      if (req.method === "GET" && upstream.ok) {
        if (opts.public && opts.revalidate !== undefined && !auth) {
          // 仅对不带 Authorization 的公开响应启用 CDN 共享缓存。
          response.headers.set(
            "Cache-Control",
            "public, s-maxage=600, stale-while-revalidate=86400",
          );
        } else if (!opts.public && opts.browserCache !== undefined) {
          response.headers.set("Cache-Control", `private, max-age=${opts.browserCache}`);
        }
      }

      return response;
    } catch (err) {
      console.error(`[proxy ${upstreamPath}]`, err);
      return NextResponse.json({ success: false, message: "服务暂时不可用" }, { status: 503 });
    }
  };
}
