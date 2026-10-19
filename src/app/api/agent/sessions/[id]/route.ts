// DELETE /api/agent/sessions/[id] —— 删掉一个会话，释放上游资源。
//
// 纯代理：不本地校验任何业务栏位，删除结果（含闸道回的 4xx，例如找不到会话）
// 原样透传给客户端。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
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

/**
 * DELETE 幂等化：闸道回 404 "session not found" 时视同删除成功（目标已不存在）。
 * 网关 session 存在记忆体，进程重启（如 CORS 修复部署）会让旧 session 全数消失，
 * 前端 best-effort 清理旧存档会打到这种 404 —— 若不吞掉，浏览器 console 持续喷
 * "Failed to load resource: 404" 噪音。只有 not_found 才吞；其他 4xx/5xx 原样透传。
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
  // 已回收的 session 视同删除成功（幂等），不再向浏览器喷 404 噪音。
  if (isGatewaySessionNotFound(resp)) {
    return NextResponse.json({ success: true, already_gone: true }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }
  return gatewayResponse(resp);
}

// GET /api/agent/sessions/[id] - 中继闸道 GET /agent/v1/sessions/:id/messages，
// 取回该会话的全量聊天历史。纯代理：opencode messages 阵列原样透传，
// 本层不改形不落地；阵列/包装物件与栏位映射的归一化由前端负责。
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
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
    resp = await callAgentGateway(`/agent/v1/sessions/${id}/messages`, { method: "GET", key: caller.key });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
