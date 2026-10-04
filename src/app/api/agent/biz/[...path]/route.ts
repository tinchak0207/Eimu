// /api/agent/biz/[...path] —— B 端密钥代理：把插件（emu_wish 等）的 agent
// 网关请求并入调用者的「用户派生 key」空间。
//
// 背景：插件直连 store.tinchak0207.xyz/agent/v1/* 时带的是 B 端 key 本身，
// 网关 getOwnedSession 按 key 字符串隔离 —— wish 会话与用户在网页端 AI 助理
// （getOrCreateAgentKeyForUser 派生的专属 key）是两个互不可见的隔离空间。
// 这条路由做 key 换发：B 端密钥 → userId → 派生 key → 网关。零网关改动。
//
// 安全不变量：
// - B 端密钥与派生 key 只出现在发往网关的 Authorization 头里，
//   任何 log / 错误响应都不准夹带（错误一律固定文案）。
// - SSE（GET .../events）流式透传：直接把 upstream.body 交给 Response，
//   绝不 await text()（那会把长连接缓冲成一次性大响应，事件流就死了）。
// - 网关的 404（session not found，防枚举语义）原样透传，不改写、不吞掉。

import { NextRequest, NextResponse } from "next/server";
import { agentGatewayOrigin } from "@/lib/agent-gateway";
import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { AgentKeyConfigError, getOrCreateAgentKeyForUser } from "@/lib/agent-user-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 与 VPS（闸道/控制面 DB，矽谷）同区：每次上游往返省一趟横跨美国（2026-10-01 效能审计）

/** JSON 路径的硬超时：与 callAgentGateway 的 10s 约定一致；SSE 不适用。 */
const BIZ_PROXY_JSON_TIMEOUT_MS = 10_000;

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

type DerivedKeyResult = { ok: true; key: string } | { ok: false; response: NextResponse };

/** B 端密钥 → userId → 派生 key。失败分支返回可直接回给客户端的响应（固定文案）。 */
async function resolveDerivedKey(req: NextRequest): Promise<DerivedKeyResult> {
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")), {
    // 限流记在 B 端密钥上：这条路由的调用方是插件（低频、串行），但绕过限流
    // 等于给一把 key 无限转速，不值得。
    consumeRateLimit: true,
  });
  if (!auth.ok) {
    return {
      ok: false,
      response: fail(auth.status, auth.message, auth.code),
    };
  }

  let derivedKey: string;
  try {
    derivedKey = await getOrCreateAgentKeyForUser(auth.key.userId);
  } catch (error) {
    // 漏配 env 与临时故障是两件事（与 agent-session-guard 同一套语义），
    // 但都不回传错误细节——这里只要区分 code，文案保持固定。
    if (error instanceof AgentKeyConfigError) {
      return { ok: false, response: fail(503, "服务暂不可用，请稍后重试。", "agent_key_not_configured") };
    }
    return { ok: false, response: fail(503, "服务暂不可用，请稍后重试。", "agent_key_unavailable") };
  }
  return { ok: true, key: derivedKey };
}

type RouteContext = { params: Promise<{ path?: string[] }> };

async function proxy(req: NextRequest, context: RouteContext, method: "GET" | "POST" | "DELETE"): Promise<Response> {
  const resolved = await resolveDerivedKey(req);
  if (!resolved.ok) return resolved.response;

  const { path } = await context.params;
  // catch-all 的段已被 Next 解码；逐段重新编码再拼接，防止路径里的特殊字符
  // 改变上游路由语义。空路径直接 404（不是网关语义，是本路由不存在）。
  // 插件 baseUrl 可能带 agent/v1 前缀（.../biz/agent/v1），拼接时剥掉重复段，
  // 两种写法（.../biz/sessions 与 .../biz/agent/v1/sessions）都归一到同一上游路径。
  const segs = (path ?? []).map((segment) => encodeURIComponent(segment))
  while (segs.length >= 2 && segs[0] === "agent" && segs[1] === "v1") segs.splice(0, 2)
  const subPath = segs.join("/");
  if (!subPath) {
    return fail(404, "路径不存在。", "not_found");
  }
  const upstreamUrl = `${agentGatewayOrigin()}/agent/v1/${subPath}${req.nextUrl.search}`;

  // SSE 特判：GET 且末段是 events（/agent/v1/sessions/:id/events）。
  // 不带超时（事件流可以合法地静默数分钟），流式透传。
  const segments = subPath.split("/");
  if (method === "GET" && segments[segments.length - 1] === "events") {
    let events: Response;
    try {
      events = await fetch(upstreamUrl, {
        headers: { Authorization: `Bearer ${resolved.key}`, Accept: "text/event-stream" },
        cache: "no-store",
      });
    } catch {
      return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
    }
    // 直接把上游流交给 Response —— 绝不在这里读 body（缓冲会杀死事件流）。
    return new Response(events.body, {
      status: events.status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // JSON 路径：body 原样转（读一次 req.json() 再序列化，不解析业务字段），
  // 方法透传，响应保 status + body。
  let body: string | undefined;
  if (method !== "GET") {
    try {
      body = JSON.stringify(await req.json());
    } catch {
      body = undefined; // 空/坏 body 当无 body 转发，让网关按自己的契约回应。
    }
  }
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers: {
        Authorization: `Bearer ${resolved.key}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(BIZ_PROXY_JSON_TIMEOUT_MS),
    });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(req: NextRequest, context: RouteContext) {
  return proxy(req, context, "GET");
}

export async function POST(req: NextRequest, context: RouteContext) {
  return proxy(req, context, "POST");
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  return proxy(req, context, "DELETE");
}
