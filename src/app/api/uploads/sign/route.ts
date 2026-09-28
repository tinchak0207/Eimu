// POST /api/uploads/sign —— 兩段式上傳【第一段】：簽發直傳憑證。
//
// 對稱差 D36（Dramagic 全站 303 行）：
//   `UploadFileUrl{Type,Target:"temp",Suffix}` → 簽名 PUT（`Expires:3600`）→ 回寫 `TosKey`
//
// 契約：
//   請求（**只帶 metadata，零檔案位元組**——大檔直傳的唯一意義）
//     { filename?: string, contentType: string, size?: number }
//   或官方 `@vercel/blob/client` 的 `upload()` 事件體
//     { type: "blob.generate-client-token", payload: { pathname, clientPayload, multipart } }
//   回應：{ success, backend, objectKey, uploadUrl, method, access, clientToken,
//           contentType, maxBytes, expiresInMs, expiresAt, downloadUrl, type }
//
// 後端判定與簽發細節全在 `@/lib/two-phase-upload`（單一真源）。VPS image-data-api
// 沒有簽名端點 ⇒ 具名錯誤 `vps_blob_direct_upload_unsupported`（不假裝成功）。
//
// 鑑權：requireVerifiedUser（授權走上游 /api/user/self，不信任 x-user-id）。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { UploadSignError, issueDirectUploadCredential } from "@/lib/two-phase-upload";

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

  // 官方協議：客戶端（`@vercel/blob/client` 的 upload()）自帶 pathname；owner 前綴照樣要過檢查。
  const isOfficialProtocol = body?.type === "blob.generate-client-token";
  const payload = (body?.payload ?? null) as { pathname?: unknown } | null;

  try {
    const credential = await issueDirectUploadCredential({
      userId: caller.user.id,
      filename: typeof body?.filename === "string" ? body.filename : undefined,
      contentType: typeof body?.contentType === "string" ? body.contentType : "",
      size: typeof body?.size === "number" ? body.size : undefined,
      pathname: isOfficialProtocol && typeof payload?.pathname === "string" ? payload.pathname : undefined,
      request: req,
    });
    return NextResponse.json({ success: true, ...credential }, { status: 200 });
  } catch (error) {
    if (error instanceof UploadSignError) return fail(error.status, error.message, error.code);
    console.error("[uploads/sign] 簽發直傳憑證失敗。", error);
    return fail(500, "签發直传凭证失败，请稍后再试。", "internal_error");
  }
}
