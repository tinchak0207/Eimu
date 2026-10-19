// POST /api/canvas/scene-3d —— 本机 3D 模型（.glb/.gltf）导入通道。
//
// 为什么要一条新路由：画布既有的「上传图片/上传参考图」是**纯前端**通道
// （embed-helpers.fileToDataUrl → dataURL 直接进节点 metadata），图能这样做是因为
// 2MB 级的 base64 塞得进 512KB~的字串栏位预算；GLB 级 base64 还要膨胀 4/3 倍，
// 塞不进节点 metadata，也不该塞。既有其他通道逐条排除：
//   · /api/canvas/assets（PUT）＝素材库，只收 dataURL、imageUrl 硬限 2MB（MAX_IMAGE_DATA_URL_BYTES）；
//   · /api/assets、/api/asset-packs＝JSON 资产包，非二进位；
//   · /api/v1/uploads＝B 端（Bearer sk-biz）通道，上游 /uploads 只吞图片 base64（~20MB）换 mediaId；
//   · /api/agent/sessions/[id]/attachments＝把 multipart 原样转给 agent 闸道，仅存在于 agent 会话上下文；
//   · /api/blender-artifact＝**只读**桥工作目录 `.blender-work/out/`，写入面不存在。
// 所以新路由只补「登入用户二进位模型 → 物件存储」这一段，存储与认证都复用既有轮子：
//   - 认证 = requireVerifiedUser（上游 /api/user/self 验身分，不信任 x-user-id）；
//   - 落地 = blob-backend 的 put（VPS image-data-api 或 Vercel Blob，同一支选配器），
//     形状照抄 persistReferenceInput / generation-jobs.persistReferences 的 public put。
//
// 诚实边界（平台硬顶，非本档可解）：站内代理的请求体受 Vercel 平台限制（专案内
// /api/agent/sessions/[id]/attachments 档头记的 4.5MB 硬顶），且 blob-backend.put
// 带 10s 硬超时。契约上限已按平台真值收窄为 `MAX_SCENE_3D_BYTES`（4MB，见
// `src/lib/canvas/scene-3d-import.ts` 的长注释）——宣告 100MB 只会让 4.5–100MB 的档
// 在前端验证通过、却在到达本函式前被平台 413；LibTV 级的 100MB 导入需要浏览器直传
// 物件存储的通道，站内现无，不以文案假装能吃大档。
//
// 2026-09-27 刀（桌面 Blender → 画布回流）：本档**不新增第二条上传路径**，
// 只多认一种身分来源——站内铸的一次性连接码（`src/lib/canvas/scene-3d-link.ts`）：
//   ① `Authorization: Bearer <连接码>`：纯本机验签，命中即免 cookie；
//   ② 表单栏位 `code`：Blender addon 走这条（它发 multipart，不带 cookie）。
// 三条身分来源的优先序：Bearer 连接码 → cookie（`requireVerifiedUser`，**顺序与语义
// 逐字不变**）→ 表单码。落地物件键仍用验出来的那个 userId，与 cookie 路径同一套。

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireVerifiedUser } from "@/lib/server-user";
import { ensureBlobBackendWritable, put } from "@/lib/blob-backend";
import {
  MAX_SCENE_3D_BYTES,
  SCENE_3D_MAGIC_BYTES,
  SCENE_3D_SIZE_HINT,
  scene3dExtensionOf,
  validateScene3dUpload,
} from "@/lib/canvas/scene-3d-import";
import { scene3dLinkBearer, verifyScene3dLinkCode } from "@/lib/canvas/scene-3d-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/** 连接码验签失败的人话（**不插值任何码内容**——凭证明文不得回显）。 */
function linkFailure(reason: "invalid" | "expired" | "not_configured"): NextResponse {
  if (reason === "not_configured") {
    return fail(503, "服务器未配置连接码签名密钥，暂时无法验证连接码。", "link_not_configured");
  }
  if (reason === "expired") {
    return fail(401, "连接码已过期，请在画布重新生成。", "link_expired");
  }
  return fail(401, "连接码无效，请在画布重新生成。", "invalid_code");
}

export async function POST(req: NextRequest) {
  // (A) Bearer 连接码：纯本机 HMAC 验签，命中即免 cookie（Blender 也可走这条）。
  //     未命中就**原样落到下面的 cookie 路径**——会话令牌不是本码，验签必失败，
  //     因此既有浏览器客户端（Bearer 会话令牌）的行为逐字不变。
  const bearer = scene3dLinkBearer(req.headers);
  if (bearer) {
    const linked = verifyScene3dLinkCode(bearer);
    if (linked.ok) return acceptUpload(req, linked.userId);
    // 签章有效但已过期＝确定是连接码：直接回人话，不再拿它去打上游。
    // `invalid`（＝不是本码，例如浏览器的会话令牌）与 `not_configured`（缺 env）
    // 都**不在此短路**，落到下面的 cookie 路径：一缺 env 就整个导入通道挂掉，
    // 或把会话令牌误判成无效码，都是不可接受的。真正带码却验不过的情形，
    // 由 (C) 的表单码分支回 401/503。
    if (linked.reason === "expired") return linkFailure(linked.reason);
  }

  // (B) cookie 路径：**顺序与语义逐字不变**（requireVerifiedUser → 长度 → multipart）。
  const caller = await requireVerifiedUser(req);
  if (caller.ok) return acceptUpload(req, caller.user.id);

  // (C) 表单栏位 `code`：只有 cookie 没过才需要看 body（Blender addon 走这条）。
  //     解析失败或没有 code 栏位时，回的是 cookie 路径原本那个错误，不新增语义。
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(caller.status, caller.message, "unauthorized");
  }

  const codeField = form.get("code");
  if (typeof codeField !== "string" || !codeField.trim()) {
    return fail(caller.status, caller.message, "unauthorized");
  }

  const linked = verifyScene3dLinkCode(codeField.trim());
  if (!linked.ok) return linkFailure(linked.reason);
  return acceptUpload(req, linked.userId, form);
}

/**
 * 落地：长度预检 → multipart → 档案验证 → 物件存储 → put。
 *
 * `preParsedForm`：表单码那条路已经为了读 `code` 解析过 body，不重复解析
 * （请求体只能读一次）。cookie 路径不传，解析位置与改刀前一致。
 */
async function acceptUpload(req: NextRequest, userId: number, preParsedForm?: FormData): Promise<NextResponse> {
  // 先看宣告长度：能挡就别把整个档读进记忆体（multipart 尾部会超过宣告值时，下面 file.size 再挡一次）。
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_SCENE_3D_BYTES + 1024 * 1024) {
    return fail(413, SCENE_3D_SIZE_HINT, "too_large");
  }

  let form: FormData;
  if (preParsedForm) {
    form = preParsedForm;
  } else {
    try {
      form = await req.formData();
    } catch {
      return fail(400, "请求体不是有效的 multipart/form-data。", "invalid_request");
    }
  }

  const file = form.get("file");
  if (!(file instanceof File)) return fail(400, "没有找到要上传的模型文件。", "no_file");

  const head = new Uint8Array(await file.slice(0, SCENE_3D_MAGIC_BYTES).arrayBuffer());
  const checked = validateScene3dUpload({ name: file.name, size: file.size, head });
  if (!checked.ok) {
    return fail(checked.reason === "too_large" ? 413 : 400, checked.message, checked.reason);
  }

  // 后端不可用且不允许记忆体降级 → 诚实失败（不假装上传成功但没有持久化）。
  try {
    if (!ensureBlobBackendWritable("canvas-scene-3d-import")) {
      return fail(503, "模型存储暂不可用，请稍后再试。", "storage_unconfigured");
    }
  } catch {
    return fail(503, "模型存储暂不可用，请稍后再试。", "storage_unconfigured");
  }

  const ext = scene3dExtensionOf(file.name);
  // 落地键用「验出来的那个 userId」——cookie 与连接码两条路都收敛到同一个变数，
  // 没有第二处 userId 来源（域隔离的另一面：码只能以它自己那个用户落地）。
  const objectKey = `canvas/scene3d/${userId}/${randomUUID()}${ext}`;
  try {
    const blob = await put(objectKey, Buffer.from(await file.arrayBuffer()), {
      access: "public",
      contentType: ext === ".gltf" ? "model/gltf+json" : "model/gltf-binary",
      addRandomSuffix: false,
      cacheControlMaxAge: 31_536_000,
    });
    return NextResponse.json(
      { success: true, url: blob.url, pathname: blob.pathname, bytes: file.size, name: file.name },
      { status: 200 },
    );
  } catch (error) {
    console.error("[canvas-scene-3d] upload failed:", error);
    return fail(502, "模型上传失败，请稍后再试。", "upload_failed");
  }
}
