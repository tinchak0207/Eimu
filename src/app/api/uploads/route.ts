// GET /api/uploads —— 已入庫（第二段回寫過）的直傳物件清單。
//
// 存在的意義：證明「commit 之後在清單可見」——沒有這條，第二段就只是寫了一張看不見的紙。
// 消費路徑另有 `GET /api/assets`（資產庫包 `uploaded-assets`）。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { listUploadedObjects } from "@/lib/upload-record-store";
import { resolveDirectUploadBackend, publicObjectUrl } from "@/lib/two-phase-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

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
    console.error("[uploads] 清單讀取失敗。", error);
    return NextResponse.json(
      { success: false, error: "读取上传记录失败，请稍后再试。", code: "internal_error" },
      { status: 500 },
    );
  }
}

// 供前端在無紀錄時推導公網 URL 的輔助欄位（唯讀、無副作用）。
export async function OPTIONS() {
  return NextResponse.json({ success: true, publicObjectUrlSupported: publicObjectUrl("probe") !== null });
}
