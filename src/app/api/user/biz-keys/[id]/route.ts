import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { listBizApiKeys, revokeBizApiKey } from "@/lib/biz-api-key-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

/** Next 15 的动态段是异步的，params 必须 await。 */
type RouteContext = { params: Promise<{ id: string }> };

function fail(status: number, message: string, code: string) {
  return NextResponse.json({ success: false, message, code }, { status });
}

/**
 * DELETE /api/user/biz-keys/[id] — 吊销自己的密钥，立即失效。
 *
 * 归属校验：只允许吊销 userId 与当前登录用户一致的密钥。
 * 不存在与不属于本人统一按 404 处理，不泄露密钥是否存在。
 */
export async function DELETE(req: NextRequest, context: RouteContext) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message, "unauthorized");
  const { id } = await context.params;

  try {
    const all = await listBizApiKeys();
    const target = all.find((key) => key.id === id);
    if (!target) return fail(404, "密钥不存在。", "not_found");
    if (target.userId !== auth.user.id) {
      return fail(404, "密钥不存在。", "not_found");
    }

    const removed = await revokeBizApiKey(id);
    if (!removed) return fail(404, "密钥不存在。", "not_found");

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[user-biz-keys] 吊销密钥失败。", error);
    return fail(503, "吊销失败，请稍后再试。", "key_revoke_failed");
  }
}
