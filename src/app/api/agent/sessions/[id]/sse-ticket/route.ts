// POST /api/agent/sessions/[id]/sse-ticket —— 取只讀事件流的門票。
//
// 閘道回 { ticket, expires_in_ms }，ticket 綁定單一 session、只讀、短時效，
// 適合交到瀏覽器去連 events_url 做 SSE。這裡在返回前補上 events_url，
// 讓前端少拼一次 URL。
//
// 安全：ticket 是為「只讀、短時」設計的，交出去無妨；但代理持有的 sk-biz- key
// 是長時效的完整帳戶憑證，絕不能出現在任何回應裡。這支路由的回應欄位只從
// gateway 的 resp.json 取值，key 只在 callAgentGateway 的參數裡流轉。

import { NextRequest, NextResponse } from "next/server";
import { agentGatewayOrigin, callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/** gateway 響應原樣透傳：status 與 body 都不吞，好讓客戶端看到真實原因。 */
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

  // 只回 gateway 給的欄位 + 補上的 events_url；絕不碰 caller.key。
  return NextResponse.json(
    {
      ticket,
      expires_in_ms: expiresInMs,
      events_url: `${agentGatewayOrigin()}/agent/v1/sessions/${id}/events`,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
