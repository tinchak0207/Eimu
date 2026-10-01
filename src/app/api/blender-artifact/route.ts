// GET /api/blender-artifact?name=<file> — 橋產物讀取通道（2026-09-06 片P）。
//
// 存在理由：blender-bridge 產物落在橋工作目錄 `.blender-work/out/`（repo root，
// 已 gitignore，不在 public/ 靜態服務範圍內），而 blender-delegate 的
// defaultResolveArtifactUrl 把它落成站內絕對路徑（/blender-work/out/<file>），
// 該路徑 Next 不服務 → 3D 場景卡的 glTF 預覽與下載連結全部 404。本路由以
// 站內同源身份代讀，供 Scene3dGltfViewport（鑑權 fetch → blob → engine.setGltfAsset）
// 與既有 <a download> 連結消費。
//
// 安全立場：只讀 `<cwd>/.blender-work/out/` 固定目錄、只認單段純檔名
// （無目錄分隔符 → 無 traversal）、副檔名白名單（只出渲染產物，不出腳本/日誌）、
// 不做任何上游 fetch（無 SSRF 面）。登入用戶限定（requireVerifiedUser，
// NEXT_PUBLIC_LOCAL_TEST_MODE=true 時按站內慣例放行）。

import { NextRequest, NextResponse } from "next/server";
import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { requireVerifiedUser } from "@/lib/server-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

/** 副檔名白名單 → content-type（只收渲染產物；.py/.log 等一律 404）。 */
const CONTENT_TYPES: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".blend": "application/x-blender",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** 檔名白名單：單段、無分隔符、不以點開頭（防 .env/.blender-work 本體與 traversal）。 */
function isSafeArtifactName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name) && !name.includes("..") && !name.includes("/");
}

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ ok: false, error: message, code }, { status });
}

export async function GET(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  const name = (req.nextUrl.searchParams.get("name") ?? "").trim();
  if (!name) return fail(400, "缺少 name 参数", "invalid_name");
  if (!isSafeArtifactName(name)) return fail(400, "文件名不合法", "invalid_name");
  const ext = path.extname(name).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) return fail(404, `不支持的产物类型（${ext || "无扩展名"}）`, "unsupported_type");

  const outDir = path.join(process.cwd(), ".blender-work", "out");
  const filePath = path.join(outDir, name);
  if (!filePath.startsWith(outDir + path.sep) || !existsSync(filePath)) {
    return fail(404, "产物不存在（桥可能还没生成该文件）", "not_found");
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) return fail(404, "产物不存在", "not_found");

  // Content-Disposition：附件下載時用原始檔名；GLTFLoader fetch 不受影響。
  const asAttachment = req.nextUrl.searchParams.get("download") === "1";
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(stat.size),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(asAttachment ? { "Content-Disposition": `attachment; filename="${name}"` } : {}),
    },
  });
}
