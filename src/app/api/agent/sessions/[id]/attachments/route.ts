// POST /api/agent/sessions/[id]/attachments —— 上传一组档案附件。
//
// multipart/form-data 的「file」栏位（可多个）。站内代理不解析档案内容本身，
// 只把它们原样透传给 agent 闸道，闸道回 `{ attachments: [{ name, path, size, mime }] }`。
//
// 为什么不自己解析再重新组：档案进出都会占记忆体（base64 / buffer），
// multipart 有既有的 boundary 签章，重组反而有机会改变内容。直接把 FormData
// 交给 callAgentGateway 的 form 通道，由它可以保持 boundary 与 Content-Type。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 与 VPS（闸道/控制面 DB，矽谷）同区：每次上游往返省一趟横跨美国（2026-10-01 效能审计）

// Vercel 平台对单一请求 body 有 4.5MB 的硬上限；超过时由平台直接挡掉，
// 本地不另外做大档绕过。这里多个档案合计就是总 body，注意别一次选爆。
// (Node runtime 没有 per-route body limit 可配，靠平台层。)

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/** gateway 响应原样透传：status 与 body 都不吞。 */
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

  // 读成 FormData 再照原样重组转送。档案是二进位，不能先 JSON 化。
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "请求体不是有效的 multipart/form-data。", "invalid_request");
  }

  const files = form.getAll("file").filter((v) => v instanceof File) as File[];
  if (files.length === 0) {
    return fail(400, "没有找到要上传的文件。", "no_file");
  }
  if (files.some((f) => f.size === 0)) {
    return fail(400, "存在空文件。", "empty_file");
  }

  // 重组一份新的 FormData 只带 file 栏位，避免把浏览器夹带的其他栏位一起丢给闸道。
  const forward = new FormData();
  for (const file of files) forward.append("file", file);

  let resp: AgentGatewayResponse;
  try {
    resp = await callAgentGateway(`/agent/v1/sessions/${id}/attachments`, {
      method: "POST",
      key: caller.key,
      form: forward,
    });
  } catch {
    return fail(502, "Agent 网关连接失败，请稍后重试。", "agent_gateway_unreachable");
  }
  return gatewayResponse(resp);
}