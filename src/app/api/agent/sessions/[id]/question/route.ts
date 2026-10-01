// POST /api/agent/sessions/[id]/question —— 回覆一次 opencode question。
//
// request_id 必須是 que_*；answers 是依題目順序的 string[][]（選中的標籤）。
// 缺欄位直接 400，不透傳給閘道去踩 4xx。

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

function isAnswers(value: unknown): value is string[][] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string" && cell.length > 0));
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
  const answers = (body as { answers?: unknown })?.answers;
  if (!requestId || !isAnswers(answers)) {
    return fail(400, "缺少 request_id 或 answers。", "invalid_request");
  }

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway(`/agent/v1/sessions/${id}/question`, {
      method: "POST",
      key: caller.key,
      body: { request_id: requestId, answers },
    });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
