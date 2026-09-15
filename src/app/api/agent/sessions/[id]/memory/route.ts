// POST /api/agent/sessions/[id]/memory —— 會話記憶補注（resume 老會話時把帳戶畫像補進去）。
//
// 記憶注入原本只在建新會話時發生；resume/switch 到舊會話的老用戶永遠拿不到記憶。
// 這裡在 resume 路徑上補一針：讀本站權威的 profile + lessons，推送給 gateway。

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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  // 記憶數據本站是權威：與建新會話時同一套讀取與組裝。
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
  // 資產包激活注入（與記憶平行，缺省不阻塞）。
  let activeAssets: ReturnType<typeof buildAssetPackInjection> = null;
  try {
    activeAssets = buildAssetPackInjection(await getActiveAssetPack(caller.userId));
  } catch {
    activeAssets = null;
  }

  // 記憶庫注入（契約 §4）：私有 active docs（≤8，含 body）＋共享索引行，
  // 與建新會話同一套讀取與組裝；ownerKey = hashKey(resolveCanonicalKey(key))
  // （B key 正典化為屬主派生 key 後再 hash，與 gateway 注入/批次同空间）。
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
