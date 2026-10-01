// POST /api/agent/sessions/[id]/workflow-node-update —— 畫布節點「编辑」的
// workflow 節點更新代理。此前前端 handleEditWorkflowNode 打的
// /api/internal/workflow/node/update 在站點不存在（無路由無 rewrite，生產 404），
// 真路由是網關 loopback-only 的 /internal/workflow/node/update，外部不可達——
// 站點必須代撥：patch 原樣透傳，session 歸屬校驗用畫面同款 resolveAgentCaller。

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
    return fail(400, "请求体读取失败。", "invalid_request");
  }
  const payload = (body ?? {}) as Record<string, unknown>;
  if (typeof payload.session_id !== "string" || payload.session_id !== id) {
    return fail(400, "session_id 与会话不一致。", "session_mismatch");
  }
  if (typeof payload.workflow_id !== "string" || typeof payload.node_id !== "string") {
    return fail(400, "workflow_id 与 node_id 必填。", "invalid_request");
  }
  if (!payload.patch || typeof payload.patch !== "object") {
    return fail(400, "patch 必填。", "invalid_request");
  }

  // 網關 workflow handler 用 endsWith 匹配；/internal/ 家族 loopback-only，
  // 站點必須走 Bearer 家族等價路徑；session_id 走 query（Bun body 只能讀一次）。
  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway(`/agent/v1/sessions/${id}/workflow/node/update?session_id=${encodeURIComponent(id)}`, {
      method: "POST",
      key: caller.key,
      body: {
        session_id: id,
        workflow_id: payload.workflow_id,
        node_id: payload.node_id,
        patch: payload.patch,
        request_id: payload.request_id,
      },
    });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
