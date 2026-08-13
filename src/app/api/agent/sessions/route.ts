// POST /api/agent/sessions —— 建一個 agent 對話會話。
//
// 純代理：身份與 key 由 resolveAgentCaller 統一解決，剩下就是把請求轉給
// agent 閘道並原樣回傳結果。任何地方都不該自己再碰身份 —— 那是入口的事。
// 建立會話的 body 沒有本地校驗需求，把閘道當權威，原樣透傳。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function POST(req: NextRequest) {
  const caller = await resolveAgentCaller(req);
  if (!caller.ok) {
    return fail(caller.status, caller.message, agentCallerFailureCode(caller));
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway("/agent/v1/sessions", { method: "POST", key: caller.key, body: body ?? {} });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
