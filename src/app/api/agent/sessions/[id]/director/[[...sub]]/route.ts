// GET/POST /api/agent/sessions/[id]/director —— 導演台工程代理（二期全屏導演台用）。
//
// 照 canvas-state/route.ts 慣例：驗人（resolveAgentCaller）→ 換服務端 B 端 key
// → callAgentGateway 轉發 gateway /agent/v1/director/<sid>/... 六路由（spec §3）。
// 體積上限 512KB：director project.json 含 SVG 示意，超限屬異常（正常 ≤百 KB）。
// 支援子路徑：state / op / proposals / apply_proposal / schematic / reset——
// GET 只透傳 state 與 schematic；POST 其餘按子路徑白名單轉發，非白名單 404。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 與 VPS（閘道/控制面 DB，矽谷）同區：每次上游往返省一趟橫跨美國（2026-10-01 效能審計）

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
/** 請求體體積上限：op/proposals 載荷含 SVG 對照也不該超 512KB。 */
const MAX_BODY_BYTES = 512 * 1024;

/** POST 子路徑白名單：與 gateway director.ts 六路由對齊（reset 無 body 也走 POST）。 */
const POST_SUBPATHS = new Set(["op", "proposals", "apply_proposal", "reset"]);
/** GET 子路徑白名單：state（工程全文）與 schematic（示意圖查詢）。 */
const GET_SUBPATHS = new Set(["state", "schematic"]);

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

/** 解析 URL 中的子路徑：/director、/director/state、/director/schematic… */
function subPath(req: NextRequest): string {
  const path = req.nextUrl.pathname.replace(/\/+$/, "");
  const tail = path.split("/").pop() ?? "";
  return tail === "director" ? "" : tail;
}

function gatewayPath(id: string, sub: string): string {
  return `/agent/v1/director/${id}/${sub}`;
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
  const sub = subPath(req);
  if (!GET_SUBPATHS.has(sub)) {
    return fail(404, "不支持的导演台查询。", "unsupported_subpath");
  }
  // schematic 查询参数原样透传（?plan=&shot=）。
  const query = req.nextUrl.searchParams.toString();

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway(gatewayPath(id, sub) + (query ? `?${query}` : ""), {
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
  const sub = subPath(req);
  if (!POST_SUBPATHS.has(sub)) {
    return fail(404, "不支持的导演台操作。", "unsupported_subpath");
  }

  // reset 无请求体；op/proposals/apply_proposal 读 JSON 透传（gateway 自己做形状校验）。
  let body: unknown;
  if (sub !== "reset") {
    let raw: string;
    try {
      raw = await req.text();
    } catch {
      return fail(400, "请求体读取失败。", "invalid_request");
    }
    if (raw.length > MAX_BODY_BYTES) {
      return fail(413, "请求体过大。", "request_too_large");
    }
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(400, "请求体格式无效。", "invalid_request");
    }
  }

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway(gatewayPath(id, sub), {
      method: "POST",
      key: caller.key,
      ...(body !== undefined ? { body } : {}),
    });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
