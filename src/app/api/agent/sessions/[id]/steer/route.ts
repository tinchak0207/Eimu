// POST /api/agent/sessions/[id]/steer —— REQ-D2：回合中追加一条指引（steer）。
//
// 纯代理（轮子＝ /messages 路由的透传段，只换网關路径与注释）：转发给网關的
// /agent/v1/sessions/:id/steer。语义与 /messages 不同——不终止当前回合、
// 不另起用户消息；网關回应 status=injected（已注入当前回合）或
// status=queued（已排队，本回合结束后生效），结果原样透传。
//
// D2b（2026-09-23）修復：**body 必須轉發**。舊版只送 `{ method, key }`——正文與
// steer_id 全部丟在站內，網關只會回 400 "content is required"，REQ-D2 在前端到網關
// 這段根本走不通（而且 steer_id 丟了，命令身份層也失去意義：網關只能自鑄 id，
// 重放偵測永遠對不上）。這裡只做形狀校驗後原樣透傳，長度上限的權威仍在校驗端
// （網關 STEER_MAX_CHARS），不在此處複製第二份常數。

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
    return fail(400, "请求体格式无效。", "invalid_request");
  }

  // 只攔空正文（本地 400 比走一趟外網快，也讓前端拿到同一個站內錯誤格式）；
  // 長度與內容語義的權威在網關（steer_too_long / steer_empty 由它裁決）。
  const raw = (body as { content?: unknown })?.content;
  const content = typeof raw === "string" ? raw.trim() : "";
  if (content.length === 0) return fail(400, "指引内容不能为空。", "empty_message");

  // steer_id 原樣轉發：它是命令身份（D2b 的持久 tombstone 靠它認重放），
  // 代理層不理解它，但絕不能把它吞掉——吞掉就等於每次都由網關自鑄新 id。
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
