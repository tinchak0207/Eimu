// POST /api/canvas/scene-3d/link —— 铸一枚「桌面 Blender → 站内画布」的一次性连接码。
//
// 为什么要有这条端点：浏览器外的 Blender 进程没有 cookie。上传路由
// （`src/app/api/canvas/scene-3d/route.ts`）要求身分，而桌面端唯一能拿到身分的
// 合法途径，是**已登入的站内会话主动铸一段短命凭证给它**。本端点只做这一件事：
// 验明站内身分 → 签一段 15 分钟的码 → 回给前端显示。
//
// 认证＝`requireVerifiedUser`（照抄隔壁 `../route.ts`）：把 `Authorization` 与
// `New-Api-User` 一起交给上游 `/api/user/self` 验，**不信任 `x-user-id` 自称**。
// 铸码端点的种种（不签别人的 id、码不进 log）都建立在这一步之上。
//
// 用途边界（诚实声明）：这串码在 TTL 内等于「该用户可上传一个模型」的权限；
// 它**不能**换 B 端密钥（域隔离见 `src/lib/canvas/scene-3d-link.ts` 档头），
// 也**无法单独吊销**（无存储＝无吊销表）。

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
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function fail(status: number, message: string, code: string): NextResponse {
  // 回应形状与隔壁 ../route.ts 的 fail() 逐字同源（本目录既有惯例）。
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function POST(req: NextRequest) {
  const caller = await requireVerifiedUser(req);
  if (!caller.ok) return fail(caller.status, caller.message, "unauthorized");

  // 密钥未配置＝诚实失败（503），不降级、不静默：降级成「无签章」等于谁都能铸码。
  if (!scene3dLinkConfigured()) {
    return fail(503, "服务器未配置连接码签名密钥，暂时无法生成连接码。", "link_not_configured");
  }

  // 假身分（本地测试模式的 id:0）铸出来的码，验签端必然拒绝 ⇒ 一开始就不发。
  if (!isLinkableUserId(caller.user.id)) {
    return fail(403, "当前会话无法生成连接码，请用正式登录的账号操作。", "session_not_linkable");
  }

  const code = signScene3dLinkCode(caller.user.id);

  // 明文码只在这个回应体里出现一次；不写进任何 log（AGENTS 红线：凭证不入 log）。
  // no-store：这是凭证，任何中间层都不得快取或复用。
  return NextResponse.json(
    { success: true, code, expires_in_ms: SCENE_3D_LINK_TTL_MS },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
