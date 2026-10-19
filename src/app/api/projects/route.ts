// 创作项目 API：云端持久化（list / create / rename-archive / delete）。
// 认证：requireVerifiedUser（上游 /api/user/self 验证，不信任 x-user-id）。
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { requireVerifiedUser } from "@/lib/server-user";
import {
  deleteCreativeProjects,
  ensureLegacyProjectMigration,
  mutateCreativeProject,
  saveCreativeProject,
} from "@/lib/creative-project/store";
import type { CreativeProject } from "@/lib/creative-project/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

function ok(payload: Record<string, unknown>): NextResponse {
  return NextResponse.json({ success: true, ...payload }, { status: 200, headers: { "Cache-Control": "no-store" } });
}

function newProjectId(): string {
  return `prj_${randomBytes(12).toString("hex")}`;
}

export async function GET(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");
  try {
    // 读项目面＝迁移入口：首次读取即把存量画布收进「我的项目」（幂等，见 store）。
    const projects = await ensureLegacyProjectMigration(caller.user.id);
    return ok({ projects });
  } catch (error) {
    console.error("[projects] list projects failed:", error);
    return fail(500, "读取项目失败，请稍后再试", "internal_error");
  }
}

export async function POST(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  // body 可选：不带 body／空 body ＝ 直接用预设值建默认项目。
  // 非物件 body（数组／字符串／null／数字）一律拒收——判定逐字照抄兄弟端点
  // `src/app/api/v1/canvas/projects/route.ts:79-88`（commit dbb0abc9 硬化过同一问题：
  // `typeof [] === "object"` 会穿透）。只「送了 body 但它不是物件」才 400。
  let raw: unknown = {};
  try {
    const text = await req.text();
    if (text.trim()) raw = JSON.parse(text);
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail(400, "请求体必须是 JSON 物件（不可为数组）", "invalid_payload");
  }
  const body = raw as { title?: unknown };

  try {
    const now = new Date().toISOString();
    const title = typeof body?.title === "string" ? body.title.trim().slice(0, 200) : "";
    const project: CreativeProject = {
      id: newProjectId(),
      title: title || "未命名项目",
      createdAt: now,
      updatedAt: now,
      chats: [],
    };
    // 清洗一律交给 store 的逐栏白名单（normalizeCreativeProject），本路由不重复实作。
    await saveCreativeProject(caller.user.id, project);
    return ok({ project });
  } catch (error) {
    console.error("[projects] create project failed:", error);
    return fail(500, "创建项目失败，请稍后再试", "internal_error");
  }
}

export async function PATCH(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: { id?: unknown; title?: unknown; archived?: unknown } | null = null;
  try {
    body = (await req.json()) as { id?: unknown; title?: unknown; archived?: unknown };
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  const payload = body;
  if (!payload || typeof payload.id !== "string" || payload.id.length === 0) {
    return fail(400, "缺少 id", "invalid_payload");
  }
  if (payload.title !== undefined && typeof payload.title !== "string") {
    return fail(400, "title 必须是字符串", "invalid_payload");
  }
  if (payload.archived !== undefined && typeof payload.archived !== "boolean") {
    return fail(400, "archived 必须是布尔值", "invalid_payload");
  }
  const id = payload.id;
  const title = typeof payload.title === "string" ? payload.title.trim().slice(0, 200) : undefined;
  const archived = payload.archived;

  try {
    // 改名／归档走 mutateCreativeProject（读-改-写在同一串行区内）；清洗交给 normalize。
    const updated = await mutateCreativeProject(caller.user.id, id, (project) => {
      const next: CreativeProject = { ...project };
      if (title) next.title = title;
      if (archived === true) next.archivedAt = new Date().toISOString();
      // archived:false → 清键（不写预设值冒充「已归档」）。
      if (archived === false) delete next.archivedAt;
      return next;
    });
    if (!updated) return fail(404, "项目不存在", "not_found");
    return ok({ project: updated });
  } catch (error) {
    console.error("[projects] update project failed:", error);
    return fail(500, "更新项目失败，请稍后再试", "internal_error");
  }
}

export async function DELETE(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let ids: string[] = [];
  try {
    const body = (await req.json()) as { ids?: unknown };
    ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }
  if (!ids.length) return fail(400, "缺少 ids", "invalid_payload");

  try {
    const deleted = await deleteCreativeProjects(caller.user.id, ids);
    return ok({ deleted });
  } catch (error) {
    console.error("[projects] delete projects failed:", error);
    return fail(500, "删除项目失败，请稍后再试", "internal_error");
  }
}
