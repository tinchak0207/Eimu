// POST /api/agent/sessions/[id]/project/patch —— 工程图人手回写代理（S10b 画布 → S9 网关公开面）。
//
// 形状照抄 workflow-node-update：resolveAgentCaller 验人 → session_id 与会话 id 必须一致 →
// callAgentGateway 代拨 POST /agent/v1/sessions/:id/project/patch（网关侧 Actor 强制 user）。
// 只转发契约字段（ops/baseVersion/atomic），不转 session_id（它只用于本站的身份一致性校验）。

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
  // S10b 现役 client（src/hooks/canvas/project-sync.ts）只发 {ops, baseVersion?}，不带 session_id；
  // 带了就必须与会话一致（防串会话）。不强制存在：会话身份由路径 id + Bearer 主人校验决定，
  // 请求体里的 session_id 不是身份来源。
  if (payload.session_id !== undefined && payload.session_id !== id) {
    return fail(400, "session_id 与会话不一致。", "session_mismatch");
  }
  if (!Array.isArray(payload.ops)) {
    return fail(400, "ops 必须是数组。", "invalid_request");
  }

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway(`/agent/v1/sessions/${id}/project/patch`, {
      method: "POST",
      key: caller.key,
      body: {
        ops: payload.ops,
        ...(payload.baseVersion !== undefined ? { baseVersion: payload.baseVersion } : {}),
        ...(payload.atomic !== undefined ? { atomic: payload.atomic } : {}),
      },
    });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
