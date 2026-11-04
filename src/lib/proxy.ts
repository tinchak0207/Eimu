import { NextRequest, NextResponse } from "next/server";
import { getGatewayBaseUrl } from "@/lib/new-api-auth-server";

interface ProxyOptions {
  upstreamPath?: string;
  public?: boolean;
  revalidate?: number;
  /** 非 public 路由的 GET 成功响应加 `Cache-Control: private, max-age=<browserCache>`（秒）。 */
  browserCache?: number;
}

type RouteContext = { params: Promise<Record<string, string | string[]>> };

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

/**
 * S-16：用户可控的路径段拼进上游 URL 前的唯一闸。
 * 拒绝 ""、"."、".."（含 %2e 编码与多层编码后还原出的）、含 `/` `\\` 的段、控制字符。
 * 路由参数已被 Next 解码一次，故这里再迭代解码至多 3 次，任何一层现出危险形态即拒。
 */
export function isUnsafeUpstreamSegment(segment: string): boolean {
  let current = segment;
  for (let i = 0; i < 4; i += 1) {
    if (current === "" || /^\.+$/.test(current)) return true;
    if (/[\/\\\u0000-\u001f\u007f]/.test(current)) return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return true; // 残缺的 %xx：无法证明安全，按不安全处理
    }
    if (decoded === current) return false;
    current = decoded;
  }
  return true; // 超过 3 层编码仍在变化：拒绝
}

const UNSAFE_PATH_MESSAGE = "请求路径无效";

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
      const placeholder = `:${key}`;
      if (!upstreamPath.includes(placeholder)) continue;
      const segments = Array.isArray(val) ? val : [val];
      if (segments.some((seg) => typeof seg !== "string" || isUnsafeUpstreamSegment(seg))) {
        return NextResponse.json({ success: false, message: UNSAFE_PATH_MESSAGE }, { status: 400 });
      }
      const encoded = segments.map((seg) => encodeURIComponent(seg)).join("/");
      // 函式替换：避免 `$&` 等特殊替换样式；合法路径的上游 URL 形状不变。
      upstreamPath = upstreamPath.replace(placeholder, () => encoded);
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
