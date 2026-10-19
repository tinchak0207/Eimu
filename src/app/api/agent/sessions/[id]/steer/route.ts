// POST /api/agent/sessions/[id]/steer —— REQ-D2：回合中追加一条指引（steer）。
//
// 纯代理（轮子＝ /messages 路由的透传段，只换网关路径与注释）：转发给网关的
// /agent/v1/sessions/:id/steer。语义与 /messages 不同——不终止当前回合、
// 不另起用户消息；网关回应 status=injected（已注入当前回合）或
// status=queued（已排队，本回合结束后生效），结果原样透传。
//
// D2b（2026-09-23）修复：**body 必须转发**。旧版只送 `{ method, key }`——正文与
// steer_id 全部丢在站内，网关只会回 400 "content is required"，REQ-D2 在前端到网关
// 这段根本走不通（而且 steer_id 丢了，命令身份层也失去意义：网关只能自铸 id，
// 重放侦测永远对不上）。这里只做形状校验后原样透传，长度上限的权威仍在校验端
// （网关 STEER_MAX_CHARS），不在此处复制第二份常数。

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
    return fail(400, "请求体格式无效。", "invalid_request");
  }

  // 只拦空正文（本地 400 比走一趟外网快，也让前端拿到同一个站内错误格式）；
  // 长度与内容语义的权威在网关（steer_too_long / steer_empty 由它裁决）。
  const raw = (body as { content?: unknown })?.content;
  const content = typeof raw === "string" ? raw.trim() : "";
  if (content.length === 0) return fail(400, "指引内容不能为空。", "empty_message");

  // steer_id 原样转发：它是命令身份（D2b 的持久 tombstone 靠它认重放），
  // 代理层不理解它，但绝不能把它吞掉——吞掉就等于每次都由网关自铸新 id。
  const rawSteerId = (body as { steer_id?: unknown })?.steer_id;
  const steerId = typeof rawSteerId === "string" && rawSteerId.length > 0 ? rawSteerId : undefined;

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway(`/agent/v1/sessions/${id}/steer`, {
      method: "POST",
      key: caller.key,
      body: {
        content,
        ...(steerId !== undefined ? { steer_id: steerId } : {}),
      },
    });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
