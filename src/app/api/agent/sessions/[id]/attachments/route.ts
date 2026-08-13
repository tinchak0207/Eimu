// POST /api/agent/sessions/[id]/attachments —— 上傳一組檔案附件。
//
// multipart/form-data 的「file」欄位（可多個）。站內代理不解析檔案內容本身，
// 只把它們原樣透傳給 agent 閘道，閘道回 `{ attachments: [{ name, path, size, mime }] }`。
//
// 為什麼不自己解析再重新組：檔案進出都會佔記憶體（base64 / buffer），
// multipart 有既有的 boundary 簽章，重組反而有機會改變內容。直接把 FormData
// 交給 callAgentGateway 的 form 通道，由它可以保持 boundary 與 Content-Type。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel 平台對單一請求 body 有 4.5MB 的硬上限；超過時由平台直接擋掉，
// 本地不另外做大檔繞過。這裡多個檔案合計就是總 body，注意別一次選爆。
// (Node runtime 沒有 per-route body limit 可配，靠平台層。)

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/** gateway 響應原樣透傳：status 與 body 都不吞。 */
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

  // 讀成 FormData 再照原樣重組轉送。檔案是二進位，不能先 JSON 化。
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

  // 重組一份新的 FormData 只帶 file 欄位，避免把瀏覽器夾帶的其他欄位一起丟給閘道。
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