// GET /api/agent/sessions/[id]/subagents/[runId] —— 读一页子代理转录（纯代理）。
//
// 结构逐行同构自同目录 steer/route.ts；query 的 offset 存在就原样带上，
// 缺省不拼（避免把空值拼成 "?offset="）。分页语义（next_offset/eof）属网关，
// 本层不解释、不重算。

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

function gatewayResponse(resp: AgentGatewayResponse): NextResponse {
  if (resp.status >= 200 && resp.status < 300) {
    return NextResponse.json(resp.json ?? {}, { status: resp.status, headers: { "Cache-Control": "no-store" } });
  }
  return resp.json !== null
    ? NextResponse.json(resp.json, { status: resp.status })
    : new NextResponse(resp.text || "", { status: resp.status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string; runId: string }> }) {
  const caller = await resolveAgentCaller(req);
  if (!caller.ok) {
    return fail(caller.status, caller.message, agentCallerFailureCode(caller));
  }

  const { id, runId } = await context.params;
  if (!SESSION_ID_PATTERN.test(id)) {
    return fail(400, "会话 id 无效。", "invalid_session_id");
  }
  if (!SESSION_ID_PATTERN.test(runId)) {
    return fail(400, "子代理 id 无效。", "invalid_run_id");
  }

  const offset = req.nextUrl.searchParams.get("offset");
  const path = `/agent/v1/sessions/${id}/subagents/${runId}${offset ? `?offset=${encodeURIComponent(offset)}` : ""}`;

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway(path, { method: "GET", key: caller.key });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
