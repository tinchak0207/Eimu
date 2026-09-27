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
//
// 2026-09-27 刀（桌面 Blender → 畫布回流）：本檔**不新增第二條上傳路徑**，
// 只多認一種身分來源——站內鑄的一次性連接碼（`src/lib/canvas/scene-3d-link.ts`）：
//   ① `Authorization: Bearer <连接码>`：純本機驗簽，命中即免 cookie；
//   ② 表單欄位 `code`：Blender addon 走這條（它發 multipart，不帶 cookie）。
// 三條身分來源的優先序：Bearer 連接碼 → cookie（`requireVerifiedUser`，**順序與語義
// 逐字不變**）→ 表單碼。落地物件鍵仍用驗出來的那個 userId，與 cookie 路徑同一套。

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

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/** 連接碼驗簽失敗的人話（**不插值任何碼內容**——憑證明文不得回顯）。 */
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
  // (A) Bearer 連接碼：純本機 HMAC 驗簽，命中即免 cookie（Blender 也可走這條）。
  //     未命中就**原樣落到下面的 cookie 路徑**——會話令牌不是本碼，驗簽必失敗，
  //     因此既有瀏覽器客戶端（Bearer 會話令牌）的行為逐字不變。
  const bearer = scene3dLinkBearer(req.headers);
  if (bearer) {
    const linked = verifyScene3dLinkCode(bearer);
    if (linked.ok) return acceptUpload(req, linked.userId);
    // 簽章有效但已過期＝確定是連接碼：直接回人話，不再拿它去打上游。
    // `invalid`（＝不是本碼，例如瀏覽器的會話令牌）與 `not_configured`（缺 env）
    // 都**不在此短路**，落到下面的 cookie 路徑：一缺 env 就整個導入通道掛掉，
    // 或把會話令牌誤判成無效碼，都是不可接受的。真正帶碼卻驗不過的情形，
    // 由 (C) 的表單碼分支回 401/503。
    if (linked.reason === "expired") return linkFailure(linked.reason);
  }

  // (B) cookie 路徑：**順序與語義逐字不變**（requireVerifiedUser → 長度 → multipart）。
  const caller = await requireVerifiedUser(req);
  if (caller.ok) return acceptUpload(req, caller.user.id);

  // (C) 表單欄位 `code`：只有 cookie 沒過才需要看 body（Blender addon 走這條）。
  //     解析失敗或沒有 code 欄位時，回的是 cookie 路徑原本那個錯誤，不新增語義。
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
 * 落地：長度預檢 → multipart → 檔案驗證 → 物件存儲 → put。
 *
 * `preParsedForm`：表單碼那條路已經為了讀 `code` 解析過 body，不重複解析
 * （請求體只能讀一次）。cookie 路徑不傳，解析位置與改刀前一致。
 */
async function acceptUpload(req: NextRequest, userId: number, preParsedForm?: FormData): Promise<NextResponse> {
  // 先看宣告長度：能擋就別把整個檔讀進記憶體（multipart 尾部會超過宣告值時，下面 file.size 再擋一次）。
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

  // 後端不可用且不允許記憶體降級 → 誠實失敗（不假裝上傳成功但沒有持久化）。
  try {
    if (!ensureBlobBackendWritable("canvas-scene-3d-import")) {
      return fail(503, "模型存储暂不可用，请稍后再试。", "storage_unconfigured");
    }
  } catch {
    return fail(503, "模型存储暂不可用，请稍后再试。", "storage_unconfigured");
  }

  const ext = scene3dExtensionOf(file.name);
  // 落地鍵用「驗出來的那個 userId」——cookie 與連接碼兩條路都收斂到同一個變數，
  // 沒有第二處 userId 來源（域隔離的另一面：碼只能以它自己那個用戶落地）。
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
