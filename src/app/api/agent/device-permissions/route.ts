import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

export async function POST(req: NextRequest) {
  const caller = await resolveAgentCaller(req);
  if (!caller.ok) return NextResponse.json({ success: false, error: caller.message, code: agentCallerFailureCode(caller) }, { status: caller.status });
  const body = await req.json().catch(() => null);
  const mode = body?.mode;
  if (!["off", "ask", "auto", "full"].includes(mode)) {
    return NextResponse.json({ success: false, error: "无效的权限模式。", code: "bad_mode" }, { status: 400 });
  }
  try {
    // 身份只来自已鉴权caller；不透传body中的tenant或其它字段。
    const resp = await callAgentGateway("/agent/v1/device-bridge/permissions", { method: "POST", key: caller.key, body: { mode } });
    const data = resp.json as { ok?: boolean; mode?: string } | null;
    if (resp.status >= 200 && resp.status < 300 && data?.ok === true && data.mode === mode) {
      return NextResponse.json({ success: true, mode }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ success: false, error: "权限模式未同步，请重新登录或稍后重试。", code: "device_permissions_unsynced" }, { status: resp.status === 401 || resp.status === 403 ? resp.status : 502 });
  } catch {
    return NextResponse.json({ success: false, error: "权限模式同步失败，请检查网络后重试。", code: "device_permissions_unreachable" }, { status: 502 });
  }
}
