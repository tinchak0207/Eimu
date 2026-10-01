// GET /api/agent/sessions/[id]/memory-trace —— 注入觀測點代理（契約 §3.6，R2 尺依賴）。
//
// 【路徑決策】採「現成輪子逐行複用」，不建最小代理：repo→gateway 的 server-side
// fetch 先例已在同目錄存在——`[id]/transcript/route.ts` 與 `[id]/memory/route.ts`
// 都用 `src/lib/agent-gateway.ts` 的 `callAgentGateway`（Bearer 換服務端 sk-biz- key、
// 10s 硬超時、JSON/文本透傳）＋ `resolveAgentCaller`（既有 agent key 認證）。
// 本檔結構逐行複製自 transcript/route.ts，白名單只改一件事：上游路徑
// `/agent/v1/sessions/${id}/memory-trace`（transcript 的 ?limit 透傳不屬於
// memory-trace 契約欄位，隨路徑一併移除）。
//
// 真源是 gateway（它才知道本回合注入了哪些 doc id）：這裡不做本地組裝，原樣透傳。

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
    resp = await callAgentGateway(`/agent/v1/sessions/${id}/memory-trace`, {
      method: "GET",
      key: caller.key,
    });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
