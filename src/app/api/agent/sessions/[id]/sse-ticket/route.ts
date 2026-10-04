// POST /api/agent/sessions/[id]/sse-ticket —— 取只读事件流的门票。
//
// 闸道回 { ticket, expires_in_ms }，ticket 绑定单一 session、只读、短时效，
// 适合交到浏览器去连 events_url 做 SSE。这里在返回前补上 events_url，
// 让前端少拼一次 URL。
//
// 安全：ticket 是为「只读、短时」设计的，交出去无妨；但代理持有的 sk-biz- key
// 是长时效的完整帐户凭证，绝不能出现在任何回应里。这支路由的回应栏位只从
// gateway 的 resp.json 取值，key 只在 callAgentGateway 的参数里流转。

import { NextRequest, NextResponse } from "next/server";
import { agentGatewayOrigin, callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 与 VPS（闸道/控制面 DB，矽谷）同区：每次上游往返省一趟横跨美国（2026-10-01 效能审计）

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/** gateway 响应原样透传：status 与 body 都不吞，好让客户端看到真实原因。 */
function gatewayResponse(resp: AgentGatewayResponse): NextResponse {
  if (resp.status >= 200 && resp.status < 300) {
    return NextResponse.json(resp.json ?? {}, { status: resp.status, headers: { "Cache-Control": "no-store" } });
  }
  return resp.json !== null
    ? NextResponse.json(resp.json, { status: resp.status })
    : new NextResponse(resp.text || "", { status: resp.status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const caller = await resolveAgentCaller(req);
  if (!caller.ok) {
    return fail(caller.status, caller.message, agentCallerFailureCode(caller));
  }

  const { id } = await context.params;
  if (!SESSION_ID_PATTERN.test(id)) {
    return fail(400, "会话 id 无效。", "invalid_session_id");
  }

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway(`/agent/v1/sessions/${id}/sse-ticket`, { method: "POST", key: caller.key });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }

  if (resp.status < 200 || resp.status >= 300) {
    return gatewayResponse(resp);
  }

  const ticket = (resp.json as { ticket?: unknown })?.ticket;
  const expiresInMs = (resp.json as { expires_in_ms?: unknown })?.expires_in_ms;
  if (typeof ticket !== "string" || !ticket) {
    return fail(502, "Agent 网关未返回有效 ticket。", "agent_gateway_bad_response");
  }

  // 只回 gateway 给的栏位 + 补上的 events_url；绝不碰 caller.key。
  return NextResponse.json(
    {
      ticket,
      expires_in_ms: expiresInMs,
      events_url: `${agentGatewayOrigin()}/agent/v1/sessions/${id}/events`,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
