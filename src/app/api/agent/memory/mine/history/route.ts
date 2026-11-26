// GET/DELETE /api/agent/memory/mine/history —— 历史对话索引的状态／清空。
// 索引在 gateway 的 sessions.db，本站不存副本：身份用 resolveAgentCaller，其余原样转交。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway } from "@/lib/agent/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent/agent-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

async function proxy(req: NextRequest, method: "GET" | "DELETE"): Promise<NextResponse> {
  const caller = await resolveAgentCaller(req);
  if (!caller.ok) {
    return NextResponse.json(
      { success: false, error: caller.message, code: agentCallerFailureCode(caller) },
      { status: caller.status },
    );
  }
  try {
    const path = method === "GET" ? "/agent/v1/memory/history/status" : "/agent/v1/memory/history";
    const resp = await callAgentGateway(path, { method, key: caller.key });
    return NextResponse.json(resp.json ?? {}, { status: resp.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "agent_gateway_unreachable" }, { status: 502 });
  }
}

export const GET = (req: NextRequest) => proxy(req, "GET");
export const DELETE = (req: NextRequest) => proxy(req, "DELETE");
