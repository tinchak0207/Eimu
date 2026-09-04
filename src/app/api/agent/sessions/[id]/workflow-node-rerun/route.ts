// POST /api/agent/sessions/[id]/workflow-node-rerun —— 畫布錯誤卡「重试」的
// workflow 重跑代理。此前前端 handleRerun 打的 /api/internal/workflow/node/rerun
// 在站點不存在（無路由無 rewrite，生產 404），真路由是網關 loopback-only 的
// /internal/workflow/node/rerun，外部不可達——站點必須代撥：body 原樣透傳，
// session 歸屬校驗用畫面同款 resolveAgentCaller（key 只能動自己的會話）。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  // 網關 /internal/* 是 loopback-only；站點經 agent-gateway 隧道（帶 server key）
  // 打 /agent/v1 家族等價路由。gateway 的 workflow handler 用 endsWith 匹配，
  // 掛載塊用 query 拿 session_id（Bun Request body 只能讀一次，body 留給 handler）。
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
