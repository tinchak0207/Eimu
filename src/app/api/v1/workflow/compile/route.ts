// POST /v1/workflow/compile —— AI 笔（workflow_write）的 DSL 纯编译端点（B key 鉴权）。
//
// 2026-09-02：VPS harness 的 workflow_write 工具把整份 DSL 连同自 gateway 读到的
// 当前画布（current）交来，这里调 workflow-dsl 编译器 diff 出原子 ops 原样回包。
// 本 route 是纯函数端点：不调 gateway、不写画布、不发 SSE、不读 DB、零扣费零上游——
// 套用另走既有 canvas_apply_ops 通道（画布图=唯一运行时真相），回包语义只有
// 「编译结果」，没有「已应用/已上画布」。鉴权骨架照抄 /v1/upscale（B key 链）。

import { NextRequest, NextResponse } from "next/server";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { readBearerToken } from "@/lib/biz-api-keys";
import { jsonWithTrace, pixaiAuthError } from "@/lib/pixai-proxy";
import { getOrCreateTraceId } from "@/lib/request-trace";
import { compileWorkflow, type WorkflowCompileInput } from "@/lib/workflow-dsl/compile";
import type { WorkflowDslSource } from "@/lib/workflow-dsl/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

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

  // 宽松解析：非物件/缺 source → 400 invalid_request；current 缺席或栏位非阵列
  // → 以空图续算（首次编译是常态，不是错误）。
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
    // DSL 编译失败：错误清单原样透传，模型可直接读改重交。
    return NextResponse.json(
      { success: false, code: "workflow_dsl_invalid", errors: result.errors },
      { status: 422 },
    );
  }
  // 纯编译器：只回 ops/summary，绝不在此套用——套用走既有 canvas_apply_ops 通道。
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
