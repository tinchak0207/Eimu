// POST /api/agent/sessions —— 建一个 agent 对话会话。
//
// 纯代理：身份与 key 由 resolveAgentCaller 统一解决，剩下就是把请求转给
// agent 闸道并原样回传结果。任何地方都不该自己再碰身份 —— 那是入口的事。
// 建立会话的 body 没有本地校验需求，把闸道当权威，原样透传。
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
import { isAssetUsable, projectIdFromBody } from "@/lib/asset-library";

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
  // REQ-B2：注入前过作用域裁决（不可见即不可用）——项目归属的包只有在请求带了
  // 相符的 projectId（或已显式分享到该项目）时才注入；无项目上下文＝不注入。
  // 个人包（无 scope，既有预设）逐位不变。
  let activeAssets: ReturnType<typeof buildAssetPackInjection> = null;
  try {
    const active = await getActiveAssetPack(caller.userId);
    const usable = active
      ? await isAssetUsable({
          userId: caller.userId,
          projectId: projectIdFromBody(body),
          assetKind: "pack",
          assetId: active.id,
        })
      : false;
    activeAssets = active && usable ? buildAssetPackInjection(active) : null;
  } catch {
    activeAssets = null;
  }

  // 记忆库注入（契约 §4）：私有 active docs（≤8，含 body）＋共享索引行，
  // 与 user_profile/lessons 同载并入 payload。ownerKey 与 gateway 同演算法且
  // 同正典化（B key 先收敛到属主派生 key 再 hash；非 B key 恒等 raw）；
  // blob 不可达时两栏给空值，不阻塞开新会话。
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

// GET /api/agent/sessions - 会话目录（对话历史 dropdown 的数据源）。
// 网关按 key 隔离，返回该 key 的历史会话元数据（id/时间/最后活动）。
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
