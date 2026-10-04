// POST /api/agent/sessions/[id]/canvas-state —— 画布压缩快照上行（agent 的眼睛）。
//
// 前端每次画布变更（300ms 防抖）把压缩快照推给 gateway 暂存，
// agent 的 canvas_get_state 工具零往返读取。快照是尽力而为：失败不重试。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 与 VPS（闸道/控制面 DB，矽谷）同区：每次上游往返省一趟横跨美国（2026-10-01 效能审计）

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
/** 快照体积上限：压缩后仍超 512KB 属异常（前端已截断 content）。 */
const MAX_STATE_BYTES = 512 * 1024;

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

// GET /api/agent/sessions/[id]/canvas-state —— 画布快照下行（resume 回填）。
//
// 2026-08-26：此前快照只有上行（POST）没有下行——刷新/重进后左聊天续上，
// 右画布却永远空白。闸道本就存有最新上行快照，这里原样代理 GET 让前端
// 恢复画布。新会话/从未上行时闸道回 404，原样透传由前端按 null 处理。

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
    resp = await callAgentGateway(`/agent/v1/sessions/${id}/canvas/state`, {
      method: "GET",
      key: caller.key,
    });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
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

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return fail(400, "请求体读取失败。", "invalid_request");
  }
  if (raw.length > MAX_STATE_BYTES) {
    return fail(413, "画布快照过大。", "state_too_large");
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "请求体格式无效。", "invalid_request");
  }
  const state = (body as { state?: unknown })?.state;
  if (!state || typeof state !== "object") {
    return fail(400, "缺少 state。", "invalid_request");
  }

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway(`/agent/v1/sessions/${id}/canvas/state`, {
      method: "POST",
      key: caller.key,
      body: { state },
    });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
