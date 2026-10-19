import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { generateBizApiKey, normalizeBizKeyDraft, toPublicBizApiKey } from "@/lib/biz-api-keys";
import { issueBizApiKey, listBizApiKeys } from "@/lib/biz-api-key-store";
import { SUPPORTED_IMAGE_MODEL_IDS } from "@/lib/image-model-ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : "操作失败。";
  return NextResponse.json({ success: false, message }, { status: 400 });
}

/** GET /api/admin/biz-keys — 列出全部 B 端密钥（不含哈希）。 */
export async function GET() {
  try {
    await requireAdminSession();
    const keys = await listBizApiKeys();
    return NextResponse.json({
      success: true,
      data: keys.map(toPublicBizApiKey),
      supportedModels: SUPPORTED_IMAGE_MODEL_IDS,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/admin/biz-keys — 签发新密钥。
 *
 * 明文密钥只在这一次响应里出现，之后无法再取回 —— 存储里只有 sha256。
 * 界面必须提示管理员立刻复制。
 */
export async function POST(req: NextRequest) {
  try {
    await requireAdminSession();

    const body = (await req.json()) as unknown;
    const draft = normalizeBizKeyDraft(body, [...SUPPORTED_IMAGE_MODEL_IDS]);
    if (!draft.ok) {
      return NextResponse.json({ success: false, message: draft.error }, { status: 400 });
    }

    const generated = generateBizApiKey();
    const issued = await issueBizApiKey(draft.draft, generated);

    return NextResponse.json({
      success: true,
      data: toPublicBizApiKey(issued.record),
      // 仅此一次
      key: issued.key,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
