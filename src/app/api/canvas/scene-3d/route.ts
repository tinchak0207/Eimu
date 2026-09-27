// POST /api/canvas/scene-3d —— 本機 3D 模型（.glb/.gltf）導入通道。
//
// 為什麼要一條新路由：畫布既有的「上傳圖片/上傳參考圖」是**純前端**通道
// （embed-helpers.fileToDataUrl → dataURL 直接進節點 metadata），圖能這樣做是因為
// 2MB 級的 base64 塞得進 512KB~的字串欄位預算；GLB 級 base64 還要膨脹 4/3 倍，
// 塞不進節點 metadata，也不該塞。既有其他通道逐條排除：
//   · /api/canvas/assets（PUT）＝素材庫，只收 dataURL、imageUrl 硬限 2MB（MAX_IMAGE_DATA_URL_BYTES）；
//   · /api/assets、/api/asset-packs＝JSON 資產包，非二進位；
//   · /api/v1/uploads＝B 端（Bearer sk-biz）通道，上游 /uploads 只吞圖片 base64（~20MB）換 mediaId；
//   · /api/agent/sessions/[id]/attachments＝把 multipart 原樣轉給 agent 閘道，僅存在於 agent 會話上下文；
//   · /api/blender-artifact＝**只讀**橋工作目錄 `.blender-work/out/`，寫入面不存在。
// 所以新路由只補「登入用戶二進位模型 → 物件存儲」這一段，存儲與認證都複用既有輪子：
//   - 認證 = requireVerifiedUser（上游 /api/user/self 驗身分，不信任 x-user-id）；
//   - 落地 = blob-backend 的 put（VPS image-data-api 或 Vercel Blob，同一支選配器），
//     形狀照抄 persistReferenceInput / generation-jobs.persistReferences 的 public put。
//
// 誠實邊界（平台硬頂，非本檔可解）：站內代理的請求體受 Vercel 平台限制（專案內
// /api/agent/sessions/[id]/attachments 檔頭記的 4.5MB 硬頂），且 blob-backend.put
// 帶 10s 硬超時。契約上限已按平台真值收窄為 `MAX_SCENE_3D_BYTES`（4MB，見
// `src/lib/canvas/scene-3d-import.ts` 的長註釋）——宣告 100MB 只會讓 4.5–100MB 的檔
// 在前端驗證通過、卻在到達本函式前被平台 413；LibTV 級的 100MB 導入需要瀏覽器直傳
// 物件存儲的通道，站內現無，不以文案假裝能吃大檔。

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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function POST(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  // 先看宣告長度：能擋就別把整個檔讀進記憶體（multipart 尾部會超過宣告值時，下面 file.size 再擋一次）。
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_SCENE_3D_BYTES + 1024 * 1024) {
    return fail(413, SCENE_3D_SIZE_HINT, "too_large");
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "请求体不是有效的 multipart/form-data。", "invalid_request");
  }

  const file = form.get("file");
  if (!(file instanceof File)) return fail(400, "没有找到要上传的模型文件。", "no_file");

  const head = new Uint8Array(await file.slice(0, SCENE_3D_MAGIC_BYTES).arrayBuffer());
  const checked = validateScene3dUpload({ name: file.name, size: file.size, head });
  if (!checked.ok) {
    return fail(checked.reason === "too_large" ? 413 : 400, checked.message, checked.reason);
  }

  // 後端不可用且不允許記憶體降級 → 誠實失敗（不假裝上傳成功但沒有持久化）。
  try {
    if (!ensureBlobBackendWritable("canvas-scene-3d-import")) {
      return fail(503, "模型存储暂不可用，请稍后再试。", "storage_unconfigured");
    }
  } catch {
    return fail(503, "模型存储暂不可用，请稍后再试。", "storage_unconfigured");
  }

  const ext = scene3dExtensionOf(file.name);
  const objectKey = `canvas/scene3d/${caller.user.id}/${randomUUID()}${ext}`;
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
