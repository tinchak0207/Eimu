// POST /api/uploads/commit —— 兩段式上傳【第二段】：把 objectKey 回寫入庫。
//
// 對稱差 D36（Dramagic 全站 286 行）：`UpdateImageImage{ImageId, TosKey, ImageTitle}`
//   ⇒ 上傳的圖要回寫 TosKey 才算入庫。
//
// 契約：
//   請求 { objectKey: string, title?: string }
//   回應 { success, alreadyCommitted, record, assetPackId, assetPackTitle }
//
// 回寫目標（兩處，皆為呼叫者私有）：
//   ① 擁有者紀錄 `upload-records/<userId>/`（物件鍵＋伺服器驗過的 sha256＋大小＋mime）
//   ② 資產庫包 `uploaded-assets`（kind:"image" 項目）→ `GET /api/assets` 清單可見
//      ＝ UI 資產庫面板（ProjectAssetLibraryPanel）的消費路徑
//
// 誠實紀律：伺服器親自 `get` 回位元組、串流算 sha256；物件不存在即 404，不寫紀錄、
// 不入庫（不宣稱未驗證的成功）。objectKey 不屬呼叫者即 403。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { UploadSignError, commitUploadedObject } from "@/lib/two-phase-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    console.error("[uploads/commit] 回寫入庫失敗。", error);
    return fail(500, "回写入库失败，请稍后再试。", "internal_error");
  }
}
