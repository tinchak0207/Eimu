// GET/POST /api/agent/settings —— 当前用户的 agent 设定（中途输入/模型性格/成本需求）。
//
// 纯代理：身份由 resolveAgentCaller 统一解决，设定的权威数据在网关
// /agent/v1/settings（默认 steer/efficient/balanced，非法值网关自己回 400），
// 本站不存副本，GET 原样透传；POST 把 JSON body 原样转交，字段校验归网关。
//
// 唯一例外：beast_mode（野兽模式 / MOE 改革波 1）在转交前做布尔把关——
// 带该键时非 true 一律强制为 false（缺键 = 网关默认 OFF，零迁移零破坏）。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";
import { BEAST_MODE_SETTINGS_KEY } from "@/lib/expert-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 与 VPS（闸道/控制面 DB，矽谷）同区：每次上游往返省一趟横跨美国（2026-10-01 效能审计）

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/** gateway 响应原样透传：status 与 body 都不吞，好让客户端看到真实原因。 */
function gatewayResponse(resp: AgentGatewayResponse): NextResponse {
  if (resp.status >= 200 && resp.status < 300) {
    return NextResponse.json(resp.json ?? {}, { status: resp.status, headers: { "Cache-Control": "no-store" } });
  }
  return resp.json !== null
    ? NextResponse.json(resp.json, { status: resp.status })
    : new NextResponse(resp.text || "", { status: resp.status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export async function GET(req: NextRequest) {
  const caller = await resolveAgentCaller(req);
  if (!caller.ok) {
    return fail(caller.status, caller.message, agentCallerFailureCode(caller));
  }

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway("/agent/v1/settings", { method: "GET", key: caller.key });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}

export async function POST(req: NextRequest) {
  const caller = await resolveAgentCaller(req);
  if (!caller.ok) {
    return fail(caller.status, caller.message, agentCallerFailureCode(caller));
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "请求体格式无效。", "invalid_request");
  }

  // 野兽模式布尔把关（仅当请求带该键时规整；其他字段原样透传给网关）。
  if (typeof body === "object" && body !== null && BEAST_MODE_SETTINGS_KEY in body) {
    (body as Record<string, unknown>)[BEAST_MODE_SETTINGS_KEY] =
      (body as Record<string, unknown>)[BEAST_MODE_SETTINGS_KEY] === true;
  }

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway("/agent/v1/settings", { method: "POST", key: caller.key, body });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
