// /api/admin/announcements — 公告的创建 / 列表 / 修改。
//
// 鉴权与管理端其余路由同一套：requireAdminSession()（admin session cookie），
// 逐字照抄 admin/templates 与 admin/biz-keys 的错误映射（UNAUTHORIZED → 401）。
//
//   GET   ?page=&pageSize=&includeDisabled=0|1
//   POST  { title, body, surfaces?, enabled?, startsAt?, endsAt?, audienceUserIds? }
//   PATCH { id, ...patch }
//
// **本路由只交付机制**：标题与正文一律由调用方给出，本档与服务端不内置任何
// 运营内容（不预置「征稿」「大赛」这类文案），也没有自动生成文案的路径。
// 生效规则＝enabled + 时间窗（startsAt/endsAt，含端点）+ 可选 audienceUserIds；
// 三者都由管理端显式设定，缺省＝立即生效、不限受众。

import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import {
  createAnnouncement,
  listAnnouncements,
  updateAnnouncement,
  type AnnouncementInput,
  type AnnouncementPatch,
} from "@/lib/notification-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : "操作失败。";
  return NextResponse.json({ success: false, message }, { status: 500 });
}

function badRequest(message: string) {
  return NextResponse.json({ success: false, message }, { status: 400 });
}

/** 只把白名单栏位从请求体里挑出来，多余字段不落库。 */
function readAnnouncementInput(body: Record<string, unknown>): AnnouncementInput {
  const input: AnnouncementInput = {
    title: typeof body.title === "string" ? body.title : "",
    body: typeof body.body === "string" ? body.body : "",
  };
  if (Array.isArray(body.surfaces)) input.surfaces = body.surfaces as AnnouncementInput["surfaces"];
  if (typeof body.enabled === "boolean") input.enabled = body.enabled;
  if (typeof body.startsAt === "string") input.startsAt = body.startsAt;
  if (typeof body.endsAt === "string") input.endsAt = body.endsAt;
  if (Array.isArray(body.audienceUserIds)) {
    input.audienceUserIds = body.audienceUserIds as number[];
  }
  return input;
}

function readAnnouncementPatch(body: Record<string, unknown>): AnnouncementPatch {
  const patch: AnnouncementPatch = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.body === "string") patch.body = body.body;
  if (Array.isArray(body.surfaces)) patch.surfaces = body.surfaces as AnnouncementInput["surfaces"];
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.startsAt === "string") patch.startsAt = body.startsAt;
  if (typeof body.endsAt === "string") patch.endsAt = body.endsAt;
  if (Array.isArray(body.audienceUserIds)) patch.audienceUserIds = body.audienceUserIds as number[];
  return patch;
}

/** GET /api/admin/announcements — 列出公告（默认含停用，便于后台回看）。 */
export async function GET(req: NextRequest) {
  try {
    await requireAdminSession();
    const params = req.nextUrl.searchParams;
    const includeDisabled = params.get("includeDisabled") !== "0";
    const page = await listAnnouncements({
      page: params.get("page"),
      pageSize: params.get("pageSize"),
      includeDisabled,
    });

    return NextResponse.json({
      success: true,
      data: {
        announcements: page.items,
        total: page.total,
        page: page.page,
        pageSize: page.pageSize,
        hasMore: page.hasMore,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/admin/announcements — 创建公告。 */
export async function POST(req: NextRequest) {
  try {
    await requireAdminSession();

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return badRequest("请求体格式不正确。");
    }

    const input = readAnnouncementInput(body);
    if (!input.title.trim() || !input.body.trim()) return badRequest("公告标题与正文不能为空。");

    const created = await createAnnouncement(input);
    return NextResponse.json({ success: true, data: created }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/** PATCH /api/admin/announcements — 修改公告（body.id 指定；找不到回 404，不静默创建）。 */
export async function PATCH(req: NextRequest) {
  try {
    await requireAdminSession();

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return badRequest("请求体格式不正确。");
    }

    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return badRequest("缺少公告 id。");

    const patch = readAnnouncementPatch(body);
    if (typeof patch.title === "string" && !patch.title.trim()) return badRequest("公告标题不能为空。");
    if (typeof patch.body === "string" && !patch.body.trim()) return badRequest("公告正文不能为空。");

    const updated = await updateAnnouncement(id, patch);
    if (!updated) {
      return NextResponse.json({ success: false, message: "公告不存在。" }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    return errorResponse(error);
  }
}
