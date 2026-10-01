// POST /v1/workflow/compile —— AI 筆（workflow_write）的 DSL 純編譯端點（B key 鑑權）。
//
// 2026-09-02：VPS harness 的 workflow_write 工具把整份 DSL 連同自 gateway 讀到的
// 當前畫布（current）交來，這裡調 workflow-dsl 編譯器 diff 出原子 ops 原樣回包。
// 本 route 是純函數端點：不調 gateway、不寫畫布、不發 SSE、不讀 DB、零扣費零上游——
// 套用另走既有 canvas_apply_ops 通道（畫布圖=唯一運行時真相），回包語義只有
// 「編譯結果」，沒有「已應用/已上畫布」。鑑權骨架照抄 /v1/upscale（B key 鏈）。

import { NextRequest, NextResponse } from "next/server";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { readBearerToken } from "@/lib/biz-api-keys";
import { jsonWithTrace, pixaiAuthError } from "@/lib/pixai-proxy";
import { getOrCreateTraceId } from "@/lib/request-trace";
import { compileWorkflow, type WorkflowCompileInput } from "@/lib/workflow-dsl/compile";
import type { WorkflowDslSource } from "@/lib/workflow-dsl/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

export async function POST(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);

  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) {
    return jsonWithTrace(
      pixaiAuthError(auth.status, auth.message, auth.code, traceId),
      auth.status,
      traceId,
      auth.retryAfterSeconds ? { "Retry-After": String(auth.retryAfterSeconds) } : undefined,
    );
  }

  // 寬鬆解析：非物件/缺 source → 400 invalid_request；current 缺席或欄位非陣列
  // → 以空圖續算（首次編譯是常態，不是錯誤）。
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "请求体格式无效。", code: "invalid_request" },
      { status: 400 },
    );
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { success: false, error: "请求体格式无效。", code: "invalid_request" },
      { status: 400 },
    );
  }
  const { source, current: rawCurrent, label } = body as {
    source?: unknown;
    current?: unknown;
    label?: unknown;
  };
  if (source === undefined || source === null) {
    return NextResponse.json(
      { success: false, error: "缺少 source。", code: "invalid_request" },
      { status: 400 },
    );
  }

  const currentObj =
    rawCurrent && typeof rawCurrent === "object" ? (rawCurrent as Record<string, unknown>) : {};
  const current: WorkflowCompileInput = {
    nodes: Array.isArray(currentObj.nodes) ? (currentObj.nodes as WorkflowCompileInput["nodes"]) : [],
    connections: Array.isArray(currentObj.connections)
      ? (currentObj.connections as WorkflowCompileInput["connections"])
      : [],
  };

  const result = compileWorkflow(source as WorkflowDslSource, current);
  if (!result.ok) {
    // DSL 編譯失敗：錯誤清單原樣透傳，模型可直接讀改重交。
    return NextResponse.json(
      { success: false, code: "workflow_dsl_invalid", errors: result.errors },
      { status: 422 },
    );
  }
  // 純編譯器：只回 ops/summary，絕不在此套用——套用走既有 canvas_apply_ops 通道。
  return NextResponse.json(
    {
      success: true,
      ops: result.ops,
      summary: result.summary,
      label: typeof label === "string" ? label : null,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
