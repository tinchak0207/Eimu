// POST /api/agent/sessions/[id]/canvas-ops-result —— canvas.ops 執行結果回報。
//
// 前端執行（或用戶拒絕）agent 下發的批量畫布操作後，把結果送回 gateway，
// resolve 對應的 canvas_apply_ops 工具調用（否則 gateway 端 30s 超時）。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 與 VPS（閘道/控制面 DB，矽谷）同區：每次上游往返省一趟橫跨美國（2026-10-01 效能審計）

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "请求体格式无效。", "invalid_request");
  }
  const requestId = typeof (body as { request_id?: unknown })?.request_id === "string"
    ? (body as { request_id: string }).request_id.trim()
    : "";
  const ok = (body as { ok?: unknown })?.ok;
  if (!requestId || typeof ok !== "boolean") {
    return fail(400, "缺少 request_id 或 ok。", "invalid_request");
  }
  const error = typeof (body as { error?: unknown })?.error === "string" ? (body as { error: string }).error.slice(0, 400) : undefined;
  const createdRaw = (body as { created_node_ids?: unknown })?.created_node_ids;
  const createdNodeIds = Array.isArray(createdRaw)
    ? createdRaw.filter((v): v is string => typeof v === "string").slice(0, 100)
    : undefined;

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway(`/agent/v1/sessions/${id}/canvas/ops-result`, {
      method: "POST",
      key: caller.key,
      body: {
        request_id: requestId,
        ok,
        ...(error ? { error } : {}),
        ...(createdNodeIds?.length ? { created_node_ids: createdNodeIds } : {}),
      },
    });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
