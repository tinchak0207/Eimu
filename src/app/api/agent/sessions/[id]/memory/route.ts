// POST /api/agent/sessions/[id]/memory —— 会话记忆补注（resume 老会话时把帐户画像补进去）。
//
// 记忆注入原本只在建新会话时发生；resume/switch 到旧会话的老用户永远拿不到记忆。
// 这里在 resume 路径上补一针：读本站权威的 profile + lessons，推送给 gateway。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";
import { buildAgentMemoryInjection, listAgentLessons, loadAgentProfile } from "@/lib/agent-profile-store";
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

  // 记忆数据本站是权威：与建新会话时同一套读取与组装。
  let memoryInjection: { user_profile: Record<string, unknown>; lessons: string[] } | null = null;
  try {
    const [profile, lessons] = await Promise.all([
      loadAgentProfile(caller.userId),
      listAgentLessons(caller.userId),
    ]);
    memoryInjection = buildAgentMemoryInjection(profile, lessons);
  } catch {
    memoryInjection = null;
  }
  // 资产包激活注入（与记忆平行，缺省不阻塞）。
  // REQ-B2：注入前过作用域裁决（不可见即不可用）——项目归属的包只有在请求带了
  // 相符的 projectId（或已显式分享到该项目）时才注入；无项目上下文＝不注入。
  // 个人包（无 scope，既有预设）逐位不变。
  let activeAssets: ReturnType<typeof buildAssetPackInjection> = null;
  try {
    const body = await req.json().catch(() => ({}));
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
  // 与建新会话同一套读取与组装；ownerKey = hashKey(resolveCanonicalKey(key))
  // （B key 正典化为属主派生 key 后再 hash，与 gateway 注入/批次同空间）。
  const memoryLibrary = await buildMemoryInjectionPayload(await deriveMemoryOwnerKey(caller.key));

  if (!memoryInjection && !activeAssets) {
    return NextResponse.json({ patched: false, has_profile: false });
  }

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway("/agent/v1/sessions/memory-patch", {
      method: "POST",
      key: caller.key,
      body: {
        session_id: id,
        user_profile: memoryInjection?.user_profile,
        lessons: memoryInjection?.lessons,
        memory_docs: memoryLibrary.memory_docs,
        memory_index_md: memoryLibrary.memory_index_md,
        ...(activeAssets ? { active_assets: activeAssets.active_assets } : {}),
      },
    });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}
