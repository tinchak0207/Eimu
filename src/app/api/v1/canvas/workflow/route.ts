// POST /api/v1/canvas/workflow —— B 端 API key 的「写回画布产线」端点（workflow_write 的落图面）。
//
// 背景：既有 `/api/v1/workflow/compile` 只做纯编译（DSL → ops），不落图——这是刻意的
// （编译端点零副作用）。但真正的「套用 ops 到画布」在站内是画布前端的 canvas_apply_ops
// 通道（gateway SSE 下发、前端 reducer 执行），外部 coding agent/MCP 到不了。
// 本端点补上那一段：把同一份编译结果用**同一套既有套用实现**套到 B 端 key 所属 user 的
// 画布专案上，让 MCP workflow_write 在 B-key 身分下能端到端驱动产线。
//
// 轮子（不另写一套）：
//   ① 鉴权＝/api/v1/workflow/compile 的 `authenticateBizApiKey`＋`readBearerToken`。
//   ② 编译＝`compileWorkflow`（与 compile 端点同一支，含全图校验）。
//   ③ 套用＝`canvasReducer` 的 `agent_ops` 分派（与前端 canvas_apply_ops 执行端同源：
//      add_node/update_node/connect_nodes/… 与版本落版语义全在该 reducer）。
//   ④ 持久化＝`mutateCanvasProject`＋`fromCanvasProject`/`toCanvasProject`（既有落盘白名单）。
//
// **owner 校验**：`readCanvasProject`/`mutateCanvasProject(auth.key.userId, projectId, …)`。
// 画布专案储存以 `canvas/<userId>/…` 为命名空间——别人的 projectId 在本 user 命名空间
// 不存在 ⇒ 404（不区分「不存在/无权」，防枚举）。B 端 key 只代表允许的服务身分，
// 不得让 A 用户的 key 改到 B 用户的画布。
import { NextRequest, NextResponse } from "next/server";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { readBearerToken } from "@/lib/biz-api-keys";
import { mutateCanvasProject, readCanvasProject } from "@/lib/canvas/project-store";
import { fromCanvasProject, toCanvasProject } from "@/lib/canvas/layout";
import { canvasReducer } from "@/hooks/canvas/canvas-reducer-adapter";
import { compileWorkflow, type WorkflowCompileInput } from "@/lib/workflow-dsl/compile";
import type { WorkflowDslSource } from "@/lib/workflow-dsl/schema";
import type { CanvasAgentOp } from "@/lib/canvas/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function POST(req: NextRequest) {
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) return fail(auth.status, auth.message, auth.code);
  const userId = auth.key.userId;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "请求体格式无效。", "invalid_request");
  }
  if (!body || typeof body !== "object") return fail(400, "请求体格式无效。", "invalid_request");
  const {
    projectId: rawProjectId,
    source,
    current: rawCurrent,
    label,
    dry_run: rawDryRun,
  } = body as {
    projectId?: unknown;
    source?: unknown;
    current?: unknown;
    label?: unknown;
    dry_run?: unknown;
  };

  const projectId = typeof rawProjectId === "string" ? rawProjectId : "";
  if (!projectId) return fail(400, "缺少 projectId。", "invalid_request");
  if (source === undefined || source === null) return fail(400, "缺少 source。", "invalid_request");

  // owner 校验 ①：只读本 user 命名空间的专案；跨 owner 找不到。
  const project = await readCanvasProject(userId, projectId);
  if (!project) return fail(404, "画布项目不存在。", "canvas_project_not_found");

  // current 预设＝该专案的真实现状（唯一真相是画布专案）；显式传入时以其为准（与 compile 端点同契约）。
  const currentObj =
    rawCurrent && typeof rawCurrent === "object"
      ? (rawCurrent as Record<string, unknown>)
      : { nodes: project.nodes, connections: project.connections };
  const current: WorkflowCompileInput = {
    nodes: Array.isArray(currentObj.nodes) ? (currentObj.nodes as WorkflowCompileInput["nodes"]) : [],
    connections: Array.isArray(currentObj.connections)
      ? (currentObj.connections as WorkflowCompileInput["connections"])
      : [],
  };

  const result = compileWorkflow(source as WorkflowDslSource, current);
  if (!result.ok) {
    // 与 compile 端点逐字同形：错误清单原样透传，模型照 errors 改 source 重交（画布未动）。
    return NextResponse.json(
      { success: false, code: "workflow_dsl_invalid", errors: result.errors },
      { status: 422 },
    );
  }

  const ops = result.ops as CanvasAgentOp[];
  if (rawDryRun === true) {
    return NextResponse.json(
      { success: true, dry_run: true, ops, summary: result.summary, projectId },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (ops.length === 0) {
    return NextResponse.json(
      { success: true, applied: 0, summary: result.summary, projectId, note: "声明与画布一致，无需改动" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  // owner 校验 ②＋套用：mutateCanvasProject 在 user 命名空间内读-改-写；找不到＝ null。
  const updated = await mutateCanvasProject(userId, projectId, (p) => {
    const state = fromCanvasProject(p);
    // 既有套用实现：与前端 canvas_apply_ops 同一个分派（add_node/update_node/connect_nodes/…）。
    const applied = canvasReducer(state, { type: "agent_ops", ops });
    return toCanvasProject(
      { id: p.id, title: p.title, createdAt: p.createdAt },
      applied,
      p.viewport ?? { x: 0, y: 0, k: 1 },
      p.backgroundMode ?? "dots",
      p.budget,
      p.cardIds,
      p.projectType,
      p.currentStep,
      p.episodes,
      p.styleId,
      p.scriptType,
      p.narrationVoice,
    );
  });
  if (!updated) return fail(404, "画布项目不存在。", "canvas_project_not_found");

  const createdNodeIds = ops
    .filter((op): op is Extract<CanvasAgentOp, { type: "add_node" }> => op.type === "add_node")
    .map((op) => op.node.id);
  return NextResponse.json(
    {
      success: true,
      applied: ops.length,
      created_node_ids: createdNodeIds,
      summary: result.summary,
      label: typeof label === "string" ? label : null,
      projectId,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
