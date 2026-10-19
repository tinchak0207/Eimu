// POST /api/agent/sessions/[id]/workflow-node-rerun —— 画布错误卡「重试」的
// workflow 重跑代理。此前前端 handleRerun 打的 /api/internal/workflow/node/rerun
// 在站点不存在（无路由无 rewrite，生产 404），真路由是网关 loopback-only 的
// /internal/workflow/node/rerun，外部不可达——站点必须代拨：body 原样透传，
// session 归属校验用画面同款 resolveAgentCaller（key 只能动自己的会话）。

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
    return fail(400, "请求体读取失败。", "invalid_request");
  }
  const payload = (body ?? {}) as Record<string, unknown>;
  if (typeof payload.session_id !== "string" || payload.session_id !== id) {
    return fail(400, "session_id 与会话不一致。", "session_mismatch");
  }
  if (typeof payload.workflow_id !== "string" || typeof payload.node_id !== "string") {
    return fail(400, "workflow_id 与 node_id 必填。", "invalid_request");
  }

  // 网关 /internal/* 是 loopback-only；站点经 agent-gateway 隧道（带 server key）
  // 打 /agent/v1 家族等价路由。gateway 的 workflow handler 用 endsWith 匹配，
  // 挂载块用 query 拿 session_id（Bun Request body 只能读一次，body 留给 handler）。
  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway(`/agent/v1/sessions/${id}/workflow/node/rerun?session_id=${encodeURIComponent(id)}`, {
      method: "POST",
      key: caller.key,
      body: {
        session_id: id,
        workflow_id: payload.workflow_id,
        node_id: payload.node_id,
        request_id: payload.request_id,
      },
    });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
