// GET  /api/v1/canvas/projects —— B 端 API key 的「列出本账号画布项目」端点。
// POST /api/v1/canvas/projects —— B 端 API key 的「建画布专案」端点（链首）。
//
// 动机（B 端从 0 起一条产线）：外部 coding agent 拿到 MCP 的 workflow_write / workflow_rollback
// 之后，必须先知道有哪些 project_id 可以写——否则「改产线」这条链在探索面就断了。GET 补上
// 「知道有哪些」那一步（回本 key 所属帐号的画布项目摘要：id／名称／时间／节点数）。
// 但 GET 只列**已存在**的专案：一个全新的 B 端帐号（0 专案）在此之前**没有任何建专案路径**，
// 实测回 `{count:0}`，拿不到任何可用 project_id ⇒ 端到端在探索面就断。POST 就是补上这个链首：
// 建一张空专案、回它的 id，拿返回的 id 交给同目录 `workflow/route.ts` 编译＋落图。
// （GET 注释里那句「必须先知道有哪些 project_id 可以写」＝链中段；POST 供上链首，两者合起来才闭环。）
//
// owner 边界（结构性，跨 owner 不可能）：owner 命名空间一律 `auth.key.userId`——POST 只在
// **本 key 所属 user** 的 `canvas/<userId>/…` 命名空间建（与 GET 同一命名空间），不采信任何
// 客户端传来的拥有者／teamId、不接受 body 传 id；不同 user 的命名空间在储存层互不可见，
// 因此 A 用户的 key 无法建到 B 用户的画布。
//
// 鉴权与 owner 校验逐字沿用同目录 `workflow/route.ts` 的既有轮子（不另写一套）：
//   ① 鉴权＝`authenticateBizApiKey`＋`readBearerToken`（B key 真源）。
//   ② 取值＝`listCanvasProjects(auth.key.userId)`——画布专案储存以 `canvas/<userId>/…`
//      为命名空间，本函式只读该 user 命名空间，**结构性**回不到他人专案（无 leak）。
//   ③ 投影＝`toCanvasProjectSummaryWire`（与站内 `GET /api/canvas/projects?view=summary`
//      同一份摘要形状，只挑 id/title/createdAt/updatedAt/nodeCount，不回节点内容）。
// 不区分「不存在/无权」：此端点本就只回自己的，没有可枚举的他人物件。
import { NextRequest, NextResponse } from "next/server";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { readBearerToken } from "@/lib/biz-api-keys";
import { listCanvasProjects } from "@/lib/canvas/project-store";
import { saveCanvasProjectWithTeamGate } from "@/lib/canvas/team-canvas-gate";
import { toCanvasProjectSummaryWire } from "@/lib/canvas/project-summary";
import type { CanvasProject } from "@/lib/canvas/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function GET(req: NextRequest) {
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) return fail(auth.status, auth.message, auth.code);

  try {
    // owner 命名空间＝auth.key.userId；只回本帐号的专案（newest 优先）。
    const projects = await listCanvasProjects(auth.key.userId);
    return NextResponse.json(
      {
        success: true,
        count: projects.length,
        projects: projects.map(toCanvasProjectSummaryWire),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[canvas] list biz projects failed:", error);
    return fail(500, "读取画布项目失败，请稍后再试", "internal_error");
  }
}

/**
 * 建画布专案（B 端链首）。
 *
 * 建专案调**站点侧同一个** create 轮子 `saveCanvasProjectWithTeamGate`——站内
 * `PUT /api/canvas/projects`（前端所有建立路径「新建画布／模板铺画布／debounce 存档」的
 * 唯一收敛点）调的就是这支；它内部再走 `saveCanvasProject` → `normalizeProject`
 * （同一份落盘白名单），本端点不重复实作清洗、不自己拼 `toCanvasProject` 之类。
 *
 * 默认值与 id 生成照站点侧（`src/hooks/use-canvas-chat.ts` 的 `newCanvasSession`）：
 *   id 形如 `canvas-<ts>-<rand>`；title 缺省「未命名画布」、trim 后截 200 字
 *   （与站点侧 PUT 的 `body.title?.trim()?.slice(0, 200) || "未命名画布"` 逐字同规则）。
 * body 可选：不带 body／空 body ＝ 直接用预设值建一张空画布（一个 POST 就从 0 起）。
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) return fail(auth.status, auth.message, auth.code);
  const userId = auth.key.userId;

  let raw: unknown = {};
  try {
    const text = await req.text();
    if (text.trim()) raw = JSON.parse(text);
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  if (raw === null || typeof raw !== "object") return fail(400, "请求体必须是 JSON 物件", "invalid_payload");
  const { title: rawTitle } = raw as { title?: unknown };

  const now = new Date().toISOString();
  const project: CanvasProject = {
    id: `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: (typeof rawTitle === "string" ? rawTitle.trim().slice(0, 200) : "") || "未命名画布",
    createdAt: now,
    updatedAt: now,
    nodes: [],
    connections: [],
    viewport: { x: 0, y: 0, k: 1 },
    backgroundMode: "dots",
  };

  try {
    // owner＝本 key 的 userId（不采信客户端）；不宣告 scope=team ⇒ 恒落本 user 的个人命名空间。
    const gate = await saveCanvasProjectWithTeamGate(userId, project);
    if (!gate.ok) return fail(gate.status, gate.message, gate.code);
    return NextResponse.json(
      { success: true, project: toCanvasProjectSummaryWire(project) },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[canvas] create biz project failed:", error);
    return fail(500, "建立画布项目失败，请稍后再试", "internal_error");
  }
}
