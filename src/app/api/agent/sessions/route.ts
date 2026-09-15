// POST /api/agent/sessions —— 建一個 agent 對話會話。
//
// 純代理：身份與 key 由 resolveAgentCaller 統一解決，剩下就是把請求轉給
// agent 閘道並原樣回傳結果。任何地方都不該自己再碰身份 —— 那是入口的事。
// 建立會話的 body 沒有本地校驗需求，把閘道當權威，原樣透傳。
//
// L0 账户画像注入：本站是「账户级记忆」的权威（profile + lessons 落本站存储）。
// 每次开新会话时把已确认的画像 + 最近教训带进网关 —— 模型开聊就认识用户，
// 不再从零问「你的行业/规格/风格」。空画像则什么都不带，不占上下文。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";
import {
  buildAgentMemoryInjection,
  listAgentLessons,
  loadAgentProfile,
} from "@/lib/agent-profile-store";
import {
  buildMemoryInjectionPayload,
  deriveMemoryOwnerKey,
} from "@/lib/agent-memory-injection";
import { getActiveAssetPack } from "@/lib/asset-pack-store";
import { buildAssetPackInjection } from "@/lib/agent-assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function POST(req: NextRequest) {
  const caller = await resolveAgentCaller(req);
  if (!caller.ok) {
    return fail(caller.status, caller.message, agentCallerFailureCode(caller));
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // L0：账户级记忆注入（静默，不占上下文除非真有画像）。
  let memoryInjection: { user_profile: Record<string, unknown>; lessons: string[] } | null = null;
  try {
    const [profile, lessons] = await Promise.all([
      loadAgentProfile(caller.userId),
      listAgentLessons(caller.userId),
    ]);
    memoryInjection = buildAgentMemoryInjection(profile, lessons);
  } catch {
    memoryInjection = null; // 画像存储失败不阻塞开新会话
  }

  // 资产包激活注入（静默，缺省不阻塞）。
  let activeAssets: ReturnType<typeof buildAssetPackInjection> = null;
  try {
    const active = await getActiveAssetPack(caller.userId);
    activeAssets = buildAssetPackInjection(active);
  } catch {
    activeAssets = null;
  }

  // 記憶庫注入（契約 §4）：私有 active docs（≤8，含 body）＋共享索引行，
  // 與 user_profile/lessons 同載併入 payload。ownerKey 與 gateway 同演算法且
  // 同正典化（B key 先收斂到屬主派生 key 再 hash；非 B key 恆等 raw）；
  // blob 不可達時兩欄給空值，不阻塞開新會話。
  const memoryLibrary = await buildMemoryInjectionPayload(await deriveMemoryOwnerKey(caller.key));

  const payload: Record<string, unknown> =
    typeof body === "object" && body !== null ? { ...(body as Record<string, unknown>) } : {};
  if (memoryInjection) {
    payload.user_profile = memoryInjection.user_profile;
    payload.lessons = memoryInjection.lessons;
  } else {
    // 账户还没有画像：告知网关，首条消息时引导 agent 用选择题做 onboarding。
    payload.memory_empty = true;
  }
  payload.memory_docs = memoryLibrary.memory_docs;
  payload.memory_index_md = memoryLibrary.memory_index_md;
  if (activeAssets) {
    payload.active_assets = activeAssets.active_assets;
  }

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway("/agent/v1/sessions", { method: "POST", key: caller.key, body: payload });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}

// GET /api/agent/sessions - 會話目錄（對話歷史 dropdown 的數據源）。
// 網關按 key 隔離，返回該 key 的歷史會話元數據（id/時間/最後活動）。
export async function GET(req: NextRequest) {
  const caller = await resolveAgentCaller(req);
  if (!caller.ok) {
    return fail(caller.status, caller.message, agentCallerFailureCode(caller));
  }

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway("/agent/v1/sessions", { method: "GET", key: caller.key });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
