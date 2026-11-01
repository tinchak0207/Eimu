// GET /api/agent/sessions/[id]/project —— 工程图读面代理（S9 网关公开面 → S10b 画布）。
//
// 浏览器不持有 B 端 key，网关公开读面要 Bearer sk-biz-*：站点必须代拨。
// 形状照抄 workflow-node-update：resolveAgentCaller 验人 → callAgentGateway 代拨 → gatewayResponse 透传。
// query 只转发契约里的五个参数（view/node/since/detail/wait_sec），与 S10b client 的请求逐字一致；
// 不整串透传，避免把任意查询带进网关。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 与 VPS（闸道/控制面 DB，矽谷）同区：每次上游往返省一趟横跨美国（2026-10-01 效能审计）

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
/** 网关 S9 公开读面认的 query 键（ProjectGetArgs）。 */
const PROJECT_QUERY_KEYS = ["view", "node", "since", "detail", "wait_sec"] as const;

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

  const incoming = req.nextUrl.searchParams;
  const forwarded = new URLSearchParams();
  // 按客户端原顺序保留（S10b 发的是 view=node&detail=summary&node=…）：只做白名单过滤，不重排。
  for (const [key, value] of incoming.entries()) {
    if ((PROJECT_QUERY_KEYS as readonly string[]).includes(key)) forwarded.append(key, value);
  }
  const suffix = forwarded.toString() ? `?${forwarded.toString()}` : "";

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway(`/agent/v1/sessions/${id}/project${suffix}`, {
      method: "GET",
      key: caller.key,
    });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
