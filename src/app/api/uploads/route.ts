// GET /api/uploads —— 已入库（第二段回写过）的直传物件清单。
//
// 存在的意义：证明「commit 之后在清单可见」——没有这条，第二段就只是写了一张看不见的纸。
// 消费路径另有 `GET /api/assets`（资产库包 `uploaded-assets`）。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { listUploadedObjects } from "@/lib/upload-record-store";
import { resolveDirectUploadBackend, publicObjectUrl } from "@/lib/two-phase-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

export async function GET(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) {
    return NextResponse.json({ success: false, error: caller.message, code: "unauthorized" }, { status: caller.status });
  }
  try {
    const uploads = await listUploadedObjects(caller.user.id);
    return NextResponse.json(
      {
        success: true,
        backend: resolveDirectUploadBackend(),
        count: uploads.length,
        uploads,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[uploads] 清单读取失败。", error);
    return NextResponse.json(
      { success: false, error: "读取上传记录失败，请稍后再试。", code: "internal_error" },
      { status: 500 },
    );
  }
}

// 供前端在无纪录时推导公网 URL 的辅助栏位（唯读、无副作用）。
export async function OPTIONS() {
  return NextResponse.json({ success: true, publicObjectUrlSupported: publicObjectUrl("probe") !== null });
}
