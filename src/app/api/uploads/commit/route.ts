// POST /api/uploads/commit —— 两段式上传【第二段】：把 objectKey 回写入库。
//
// 对称差 D36（Dramagic 全站 286 行）：`UpdateImageImage{ImageId, TosKey, ImageTitle}`
//   ⇒ 上传的图要回写 TosKey 才算入库。
//
// 契约：
//   请求 { objectKey: string, title?: string }
//   回应 { success, alreadyCommitted, record, assetPackId, assetPackTitle }
//
// 回写目标（两处，皆为呼叫者私有）：
//   ① 拥有者纪录 `upload-records/<userId>/`（物件键＋伺服器验过的 sha256＋大小＋mime）
//   ② 资产库包 `uploaded-assets`（kind:"image" 项目）→ `GET /api/assets` 清单可见
//      ＝ UI 资产库面板（ProjectAssetLibraryPanel）的消费路径
//
// 诚实纪律：伺服器亲自 `get` 回位元组、串流算 sha256；物件不存在即 404，不写纪录、
// 不入库（不宣称未验证的成功）。objectKey 不属呼叫者即 403。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { UploadSignError, commitUploadedObject } from "@/lib/two-phase-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function POST(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  let body: Record<string, unknown> | null = null;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }

  try {
    const result = await commitUploadedObject({
      userId: caller.user.id,
      objectKey: body?.objectKey,
      title: typeof body?.title === "string" ? body.title : undefined,
    });
    return NextResponse.json({ success: true, ...result }, { status: 200 });
  } catch (error) {
    if (error instanceof UploadSignError) return fail(error.status, error.message, error.code);
    console.error("[uploads/commit] 回写入库失败。", error);
    return fail(500, "回写入库失败，请稍后再试。", "internal_error");
  }
}
