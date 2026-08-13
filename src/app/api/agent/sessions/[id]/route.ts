// DELETE /api/agent/sessions/[id] —— 刪掉一個會話，釋放上游資源。
//
// 純代理：不本地校驗任何業務欄位，刪除結果（含閘道回的 4xx，例如找不到會話）
// 原樣透傳給客戶端。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
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

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
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
    resp = await callAgentGateway(`/agent/v1/sessions/${id}`, { method: "DELETE", key: caller.key });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
