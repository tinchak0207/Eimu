// POST /api/canvas/scene-3d/link —— 鑄一枚「桌面 Blender → 站內畫布」的一次性連接碼。
//
// 為什麼要有這條端點：瀏覽器外的 Blender 進程沒有 cookie。上傳路由
// （`src/app/api/canvas/scene-3d/route.ts`）要求身分，而桌面端唯一能拿到身分的
// 合法途徑，是**已登入的站內會話主動鑄一段短命憑證給它**。本端點只做這一件事：
// 驗明站內身分 → 簽一段 15 分鐘的碼 → 回給前端顯示。
//
// 認證＝`requireVerifiedUser`（照抄隔壁 `../route.ts`）：把 `Authorization` 與
// `New-Api-User` 一起交給上游 `/api/user/self` 驗，**不信任 `x-user-id` 自稱**。
// 鑄碼端點的種種（不簽別人的 id、碼不進 log）都建立在這一步之上。
//
// 用途邊界（誠實聲明）：這串碼在 TTL 內等於「該用戶可上傳一個模型」的權限；
// 它**不能**換 B 端密鑰（域隔離見 `src/lib/canvas/scene-3d-link.ts` 檔頭），
// 也**無法單獨吊銷**（無存儲＝無吊銷表）。

import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import {
  SCENE_3D_LINK_TTL_MS,
  isLinkableUserId,
  scene3dLinkConfigured,
  signScene3dLinkCode,
} from "@/lib/canvas/scene-3d-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, message: string, code: string): NextResponse {
  // 回應形狀與隔壁 ../route.ts 的 fail() 逐字同源（本目錄既有慣例）。
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function POST(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  // 密鑰未配置＝誠實失敗（503），不降級、不靜默：降級成「無簽章」等於誰都能鑄碼。
  if (!scene3dLinkConfigured()) {
    return fail(503, "服务器未配置连接码签名密钥，暂时无法生成连接码。", "link_not_configured");
  }

  // 假身分（本地測試模式的 id:0）鑄出來的碼，驗簽端必然拒絕 ⇒ 一開始就不發。
  if (!isLinkableUserId(caller.user.id)) {
    return fail(403, "当前会话无法生成连接码，请用正式登录的账号操作。", "session_not_linkable");
  }

  const code = signScene3dLinkCode(caller.user.id);

  // 明文碼只在這個回應體裡出現一次；不寫進任何 log（AGENTS 紅線：憑證不入 log）。
  // no-store：這是憑證，任何中間層都不得快取或複用。
  return NextResponse.json(
    { success: true, code, expires_in_ms: SCENE_3D_LINK_TTL_MS },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
