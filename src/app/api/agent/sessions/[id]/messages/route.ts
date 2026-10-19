// POST /api/agent/sessions/[id]/messages —— 送一条对话消息。
//
// 唯一本地校验是 content 的形状与长度：8,000 字是为了挡掉会把上游打爆的巨型消息，
// 也顺便挡掉空串（空消息没有代理意义）。其余原样透传给闸道。
//
// 为什么要先拦空串而不是透传：gateway 对空消息也会回 4xx，但走一趟外网往返
// 才发现纯属浪费 —— 本地 400 更快，也让前端拿到同一个站内错误格式。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 与 VPS（闸道/控制面 DB，矽谷）同区：每次上游往返省一趟横跨美国（2026-10-01 效能审计）

const MAX_MESSAGE_LENGTH = 8_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

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

  const raw = (body as { content?: unknown })?.content;
  const content = typeof raw === "string" ? raw.trim() : "";
  if (content.length === 0) return fail(400, "消息内容不能为空。", "empty_message");
  if (content.length > MAX_MESSAGE_LENGTH) {
    return fail(400, `消息内容过长，上限 ${MAX_MESSAGE_LENGTH} 字。`, "message_too_long");
  }

  // 画布摘要（PRD §4）：前端每次 send 都会带上「画布上现在有什么」的纯 metadata
  // 摘要，闸道用它对齐上下文。这里只做形状与体积校验后原样透传 ——
  // 摘要的语义属于闸道，代理层不该理解它，但也不能把它吞掉（吞掉的话
  // 闸道 session 永远拿不到 canvasSummary）。
  const rawCanvasState = (body as { canvas_state?: unknown })?.canvas_state;
  let canvasState: unknown;
  if (rawCanvasState !== undefined && rawCanvasState !== null) {
    if (typeof rawCanvasState !== "object") {
      return fail(400, "画布摘要格式无效。", "invalid_canvas_state");
    }
    // 体积上限：摘要是 metadata，正常在几 KB 量级。超过 128KB 说明有人把
    // 图片 base64 塞进来了 —— 那不是摘要，直接拒掉而不是替他转发。
    if (JSON.stringify(rawCanvasState).length > 128 * 1024) {
      return fail(400, "画布摘要过大。", "canvas_state_too_large");
    }
    canvasState = rawCanvasState;
  }

  // 隐形引导词（2026-08-25 模板卡）：点模板卡时前端随首条讯息上送，
  // 闸道拼进 system 注入模型。同样只做形状/长度校验后透传——不吞不渲染。
  const rawDirective = (body as { session_directive?: unknown })?.session_directive;
  let sessionDirective: string | undefined;
  if (typeof rawDirective === "string" && rawDirective.trim().length > 0) {
    if (rawDirective.length > 4_000) {
      return fail(400, "引导指令过长。", "directive_too_long");
    }
    sessionDirective = rawDirective;
  }

  // 客户端环境上报（型别化白名单）：只做形状/体积校验后原样透传，语义与净化全在闸道
  // （sanitizeClientEnvironmentReport）；这里只挡形状明显不对与超大的 payload。
  const rawClientEnvironment = (body as { client_environment?: unknown })?.client_environment;
  let clientEnvironment: unknown;
  if (rawClientEnvironment !== undefined && rawClientEnvironment !== null) {
    if (typeof rawClientEnvironment !== "object" || Array.isArray(rawClientEnvironment)) {
      return fail(400, "客户端环境上报格式无效。", "invalid_client_environment");
    }
    if (JSON.stringify(rawClientEnvironment).length > 8 * 1024) {
      return fail(400, "客户端环境上报过大。", "client_environment_too_large");
    }
    clientEnvironment = rawClientEnvironment;
  }

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway(`/agent/v1/sessions/${id}/messages`, {
      method: "POST",
      key: caller.key,
      body: {
        content,
        ...(canvasState !== undefined ? { canvas_state: canvasState } : {}),
        ...(sessionDirective !== undefined ? { session_directive: sessionDirective } : {}),
        ...(clientEnvironment !== undefined ? { client_environment: clientEnvironment } : {}),
      },
    });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
