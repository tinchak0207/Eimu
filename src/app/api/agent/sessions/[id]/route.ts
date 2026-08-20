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

/**
 * DELETE 幂等化：閘道回 404 "session not found" 時視同刪除成功（目標已不存在）。
 * 網關 session 存在記憶體，進程重啟（如 CORS 修復部署）會讓舊 session 全數消失，
 * 前端 best-effort 清理舊存檔會打到這種 404 —— 若不吞掉，瀏覽器 console 持續噴
 * "Failed to load resource: 404" 噪音。只有 not_found 才吞；其他 4xx/5xx 原樣透傳。
 */
function isGatewaySessionNotFound(resp: AgentGatewayResponse): boolean {
  const json = resp.json as { code?: unknown } | null;
  return resp.status === 404 && typeof json?.code === "string" && json.code === "not_found";
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
  // 已回收的 session 視同刪除成功（冪等），不再向瀏覽器噴 404 噪音。
  if (isGatewaySessionNotFound(resp)) {
    return NextResponse.json({ success: true, already_gone: true }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }
  return gatewayResponse(resp);
}
