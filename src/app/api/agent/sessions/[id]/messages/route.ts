// POST /api/agent/sessions/[id]/messages —— 送一條對話消息。
//
// 唯一本地校驗是 content 的形狀與長度：8,000 字是為了擋掉會把上游打爆的巨型消息，
// 也順便擋掉空串（空消息沒有代理意義）。其餘原樣透傳給閘道。
//
// 為什麼要先攔空串而不是透傳：gateway 對空消息也會回 4xx，但走一趟外網往返
// 才發現純屬浪費 —— 本地 400 更快，也讓前端拿到同一個站內錯誤格式。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 與 VPS（閘道/控制面 DB，矽谷）同區：每次上游往返省一趟橫跨美國（2026-10-01 效能審計）

const MAX_MESSAGE_LENGTH = 8_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/** gateway 響應原樣透傳：status 與 body 都不吞，好讓客戶端看到真實原因。 */
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

  // 畫布摘要（PRD §4）：前端每次 send 都會帶上「畫布上現在有什麼」的純 metadata
  // 摘要，閘道用它對齊上下文。這裡只做形狀與體積校驗後原樣透傳 ——
  // 摘要的語義屬於閘道，代理層不該理解它，但也不能把它吞掉（吞掉的話
  // 閘道 session 永遠拿不到 canvasSummary）。
  const rawCanvasState = (body as { canvas_state?: unknown })?.canvas_state;
  let canvasState: unknown;
  if (rawCanvasState !== undefined && rawCanvasState !== null) {
    if (typeof rawCanvasState !== "object") {
      return fail(400, "画布摘要格式无效。", "invalid_canvas_state");
    }
    // 體積上限：摘要是 metadata，正常在幾 KB 量級。超過 128KB 說明有人把
    // 圖片 base64 塞進來了 —— 那不是摘要，直接拒掉而不是替他轉發。
    if (JSON.stringify(rawCanvasState).length > 128 * 1024) {
      return fail(400, "画布摘要过大。", "canvas_state_too_large");
    }
    canvasState = rawCanvasState;
  }

  // 隱形引導詞（2026-08-25 模板卡）：點模板卡時前端隨首條訊息上送，
  // 閘道拼進 system 注入模型。同樣只做形狀/長度校驗後透傳——不吞不渲染。
  const rawDirective = (body as { session_directive?: unknown })?.session_directive;
  let sessionDirective: string | undefined;
  if (typeof rawDirective === "string" && rawDirective.trim().length > 0) {
    if (rawDirective.length > 4_000) {
      return fail(400, "引导指令过长。", "directive_too_long");
    }
    sessionDirective = rawDirective;
  }

  // 客戶端環境上報（型別化白名單）：只做形狀/體積校驗後原樣透傳，語義與淨化全在閘道
  // （sanitizeClientEnvironmentReport）；這裡只擋形狀明顯不對與超大的 payload。
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
