// 创作项目 · 聊天条目 API：把网关会话挂到项目上（upsert / 解绑）。
// 认证：requireVerifiedUser（上游 /api/user/self 验证，不信任 x-user-id）。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { MAX_CHAT_SESSION_ID_LENGTH, mutateCreativeProject } from "@/lib/creative-project/store";
import type { ProjectChat } from "@/lib/creative-project/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

function ok(payload: Record<string, unknown>): NextResponse {
  return NextResponse.json({ success: true, ...payload }, { status: 200, headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: { projectId?: unknown; chat?: unknown } | null = null;
  try {
    body = (await req.json()) as { projectId?: unknown; chat?: unknown };
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
  const chat = body?.chat;
  if (!projectId) return fail(400, "缺少 projectId", "invalid_payload");
  // 外部入口拒收空 sessionId（fail-closed）：空串是**存量迁移内部**构造「默认画布」条目的
  // 合法形状（见 types.ts 注释，迁移不经路由），但绝不允许外部写入造出幽灵条目或覆写默认画布。
  // 同时拒收超长 sessionId：store 的 normalizeChat 会 `slice(0, MAX_CHAT_SESSION_ID_LENGTH)`
  // 截断，而本路由的 find/filter 用全串比对 —— 放行超长串会造成往返不对称
  // （PUT 落盘被截断但回 success ⇒ 同串 DELETE 删不掉、同串 PUT 两次落两条）。入口 fail-closed 消除落差。
  const incomingSessionId =
    chat && typeof chat === "object" ? (chat as { sessionId?: unknown }).sessionId : undefined;
  if (
    typeof incomingSessionId !== "string" ||
    incomingSessionId.length === 0 ||
    incomingSessionId.length > MAX_CHAT_SESSION_ID_LENGTH
  ) {
    return fail(400, "chat.sessionId 必须是非空且不超过 200 字的字符串", "invalid_payload");
  }
  const incoming = chat as {
    sessionId: string;
    title?: unknown;
    titleSource?: unknown;
    canvasIds?: unknown;
    primaryCanvasId?: unknown;
    archived?: unknown;
  };

  try {
    // 同 sessionId 已存在 → 合并；不存在 → 追加。清洗/值域一律交给 store 的
    // 逐栏白名单（normalizeCreativeProject → normalizeChat），本路由不重复实作
    // （避免两处白名单漂移，同 canvas 专案 PUT 的既有范式）。
    const updated = await mutateCreativeProject(caller.user.id, projectId, (project) => {
      const now = new Date().toISOString();
      const existing = project.chats.find((c) => c.sessionId === incoming.sessionId);
      const merged: ProjectChat = existing
        ? { ...existing }
        : {
            sessionId: incoming.sessionId,
            title: "新聊天",
            titleSource: "default",
            canvasIds: [],
            createdAt: now,
            updatedAt: now,
          };
      // 只覆盖 body 里有值的栏位；canvasIds 显式给了才替换（没给保留既有）。
      if (typeof incoming.title === "string") merged.title = incoming.title;
      if (typeof incoming.titleSource === "string") {
        merged.titleSource = incoming.titleSource as ProjectChat["titleSource"];
      }
      if (Array.isArray(incoming.canvasIds)) {
        merged.canvasIds = incoming.canvasIds.filter((id): id is string => typeof id === "string");
      }
      if (typeof incoming.primaryCanvasId === "string") merged.primaryCanvasId = incoming.primaryCanvasId;
      if (incoming.archived === true) merged.archivedAt = now;
      if (incoming.archived === false) delete merged.archivedAt;
      merged.updatedAt = now;
      const others = project.chats.filter((c) => c.sessionId !== incoming.sessionId);
      return { ...project, chats: [...others, merged] };
    });
    if (!updated) return fail(404, "项目不存在", "not_found");
    return ok({ project: updated });
  } catch (error) {
    console.error("[projects] upsert chat failed:", error);
    return fail(500, "更新聊天失败，请稍后再试", "internal_error");
  }
}

export async function DELETE(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: { projectId?: unknown; sessionId?: unknown } | null = null;
  try {
    body = (await req.json()) as { projectId?: unknown; sessionId?: unknown };
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
  // 外部入口拒收空 sessionId（fail-closed 邻位）：`sessionId:""` 是**存量迁移内部**构造
  // 「默认画布」条目的合法形状（见 types.ts 注释，迁移不经路由），必须保留在 store 层；
  // 但绝不允许外部用空串把它 DELETE 掉。判定形状与同档 PUT 分支一致（非 string／零长／超长 → 拒收）；
  // 超长同样拒收：store 落盘会截断，放行会让 DELETE 全串比对永远落空（回 200 却没删）。
  if (
    !projectId ||
    !body ||
    typeof body.sessionId !== "string" ||
    body.sessionId.length === 0 ||
    body.sessionId.length > MAX_CHAT_SESSION_ID_LENGTH
  ) {
    return fail(400, "缺少 projectId 或 sessionId 非法", "invalid_payload");
  }
  const sessionId = body.sessionId;

  try {
    // 只解绑本项目的该聊天条目，**不删会话本体**（会话归网关）。
    const updated = await mutateCreativeProject(caller.user.id, projectId, (project) => ({
      ...project,
      chats: project.chats.filter((c) => c.sessionId !== sessionId),
    }));
    if (!updated) return fail(404, "项目不存在", "not_found");
    return ok({ project: updated });
  } catch (error) {
    console.error("[projects] delete chat failed:", error);
    return fail(500, "解绑聊天失败，请稍后再试", "internal_error");
  }
}
