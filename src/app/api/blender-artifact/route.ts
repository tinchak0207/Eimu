// GET /api/blender-artifact?name=<file> — 桥产物读取通道（2026-09-06 片P）。
//
// 存在理由：blender-bridge 产物落在桥工作目录 `.blender-work/out/`（repo root，
// 已 gitignore，不在 public/ 静态服务范围内），而 blender-delegate 的
// defaultResolveArtifactUrl 把它落成站内绝对路径（/blender-work/out/<file>），
// 该路径 Next 不服务 → 3D 场景卡的 glTF 预览与下载连结全部 404。本路由以
// 站内同源身份代读，供 Scene3dGltfViewport（鉴权 fetch → blob → engine.setGltfAsset）
// 与既有 <a download> 连结消费。
//
// 安全立场：只读 `<cwd>/.blender-work/out/` 固定目录、只认单段纯档名
// （无目录分隔符 → 无 traversal）、副档名白名单（只出渲染产物，不出脚本/日志）、
// 不做任何上游 fetch（无 SSRF 面）。登入用户限定（requireVerifiedUser，
// NEXT_PUBLIC_LOCAL_TEST_MODE=true 时按站内惯例放行）。

import { NextRequest, NextResponse } from "next/server";
import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { requireVerifiedUser } from "@/lib/server-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

/** 副档名白名单 → content-type（只收渲染产物；.py/.log 等一律 404）。 */
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

/** 档名白名单：单段、无分隔符、不以点开头（防 .env/.blender-work 本体与 traversal）。 */
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

  const userDir = String(caller.user.id);
  if (!/^\d+$/.test(userDir)) return fail(400, "用户身份无效", "invalid_user");
  const outDir = path.join(process.cwd(), ".blender-work", "out", userDir);
  const filePath = path.join(outDir, name);
  if (!filePath.startsWith(outDir + path.sep) || !existsSync(filePath)) {
    return fail(404, "产物不存在（桥可能还没生成该文件）", "not_found");
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) return fail(404, "产物不存在", "not_found");

  // Content-Disposition：附件下载时用原始档名；GLTFLoader fetch 不受影响。
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
