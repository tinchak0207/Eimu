// POST /api/uploads/sign —— 两段式上传【第一段】：签发直传凭证。
//
// 对称差 D36（Dramagic 全站 303 行）：
//   `UploadFileUrl{Type,Target:"temp",Suffix}` → 签名 PUT（`Expires:3600`）→ 回写 `TosKey`
//
// 契约：
//   请求（**只带 metadata，零档案位元组**——大档直传的唯一意义）
//     { filename?: string, contentType: string, size?: number }
//   或官方 `@vercel/blob/client` 的 `upload()` 事件体
//     { type: "blob.generate-client-token", payload: { pathname, clientPayload, multipart } }
//   回应：{ success, backend, objectKey, uploadUrl, method, access, clientToken,
//           contentType, maxBytes, expiresInMs, expiresAt, downloadUrl, type }
//
// 后端判定与签发细节全在 `@/lib/two-phase-upload`（单一真源）。VPS image-data-api
// 没有签名端点 ⇒ 具名错误 `vps_blob_direct_upload_unsupported`（不假装成功）。
//
// 鉴权：requireVerifiedUser（授权走上游 /api/user/self，不信任 x-user-id）。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { UploadSignError, issueDirectUploadCredential } from "@/lib/two-phase-upload";

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

  // 官方协议：客户端（`@vercel/blob/client` 的 upload()）自带 pathname；owner 前缀照样要过检查。
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
    console.error("[uploads/sign] 签发直传凭证失败。", error);
    return fail(500, "签发直传凭证失败，请稍后再试。", "internal_error");
  }
}
