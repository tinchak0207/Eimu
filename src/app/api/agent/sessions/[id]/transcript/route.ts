// GET /api/agent/sessions/[id]/transcript —— 拉取会话转录（纯代理）。
//
// 真源是 opencode（gateway 不另存 messages）：这里不做本地组装，把 gateway
// 的回应原样透传。query 的 limit（可选）若存在则原样带上，缺省不带。
// 结构逐行复制自同目录 memory/route.ts（resolveAgentCaller 认证 + callAgentGateway
// 代理 + fail/gatewayResponse helper），唯独方法为 GET、不组 body。

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

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const caller = await resolveAgentCaller(req);
  if (!caller.ok) {
    return fail(caller.status, caller.message, agentCallerFailureCode(caller));
  }

  const { id } = await context.params;
  if (!SESSION_ID_PATTERN.test(id)) {
    return fail(400, "会话 id 无效。", "invalid_session_id");
  }

  // ?limit 透传：query 有 limit 才带上，缺省不拼，避免把空值也拼成 "?limit="。
  const limit = req.nextUrl.searchParams.get("limit");
  const path = `/agent/v1/sessions/${id}/transcript${limit ? `?limit=${encodeURIComponent(limit)}` : ""}`;

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway(path, { method: "GET", key: caller.key });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
