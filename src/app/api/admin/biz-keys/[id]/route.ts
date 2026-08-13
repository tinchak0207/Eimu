import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { normalizeBizKeyDraft, toPublicBizApiKey } from "@/lib/biz-api-keys";
import { revokeBizApiKey, updateBizApiKey } from "@/lib/biz-api-key-store";
import { SUPPORTED_IMAGE_MODEL_IDS } from "@/lib/image-model-ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

/** Next 15 的动态段是异步的，params 必须 await。 */
type RouteContext = { params: Promise<{ id: string }> };

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : "操作失败。";
  return NextResponse.json({ success: false, message }, { status: 400 });
}

/**
 * PATCH /api/admin/biz-keys/[id] — 修改密钥配置。
 *
 * 只支持停用/启用、改名、调限流、改模型白名单与改计费用户；
 * 密钥本身不可修改 —— 要换就吊销后重新签发，避免出现「同一个 key 换了主人」。
 */
export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    await requireAdminSession();
    const { id } = await context.params;

    const body = (await req.json()) as Record<string, unknown>;

    // 只改启用状态时不必带上完整表单。
    if (Object.keys(body).length === 1 && typeof body.enabled === "boolean") {
      const updated = await updateBizApiKey(id, { enabled: body.enabled });
      if (!updated) return NextResponse.json({ success: false, message: "密钥不存在。" }, { status: 404 });
      return NextResponse.json({ success: true, data: toPublicBizApiKey(updated) });
    }

    const draft = normalizeBizKeyDraft(body, [...SUPPORTED_IMAGE_MODEL_IDS]);
    if (!draft.ok) {
      return NextResponse.json({ success: false, message: draft.error }, { status: 400 });
    }

    const updated = await updateBizApiKey(id, draft.draft);
    if (!updated) return NextResponse.json({ success: false, message: "密钥不存在。" }, { status: 404 });

    return NextResponse.json({ success: true, data: toPublicBizApiKey(updated) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE /api/admin/biz-keys/[id] — 吊销密钥，立即失效。 */
export async function DELETE(_req: NextRequest, context: RouteContext) {
  try {
    await requireAdminSession();
    const { id } = await context.params;

    const removed = await revokeBizApiKey(id);
    if (!removed) return NextResponse.json({ success: false, message: "密钥不存在。" }, { status: 404 });

    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}
