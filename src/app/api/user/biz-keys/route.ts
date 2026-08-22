import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import {
  BIZ_KEY_DEFAULT_RPM,
  generateBizApiKey,
  normalizeUserBizKeyLabel,
  toPublicBizApiKey,
  USER_API_KEY_LIMIT,
  type BizKeyDraft,
} from "@/lib/biz-api-keys";
import { issueBizApiKey, listBizApiKeys } from "@/lib/biz-api-key-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

function fail(status: number, message: string, code: string) {
  return NextResponse.json({ success: false, message, code }, { status });
}

/**
 * GET /api/user/biz-keys — 列出当前登录用户的密钥（不含哈希）。
 *
 * 列表、详情只显示掩码预览；明文密钥自签发响应之后不可再取回。
 */
export async function GET(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message, "unauthorized");

  try {
    const all = await listBizApiKeys();
    const keys = all.filter((key) => key.userId === auth.user.id);
    return NextResponse.json({
      success: true,
      data: {
        keys: keys.map(toPublicBizApiKey),
        limit: USER_API_KEY_LIMIT,
      },
    });
  } catch (error) {
    console.error("[user-biz-keys] 读取密钥列表失败。", error);
    return fail(503, "密钥列表暂时不可用，请稍后再试。", "key_list_failed");
  }
}

/**
 * POST /api/user/biz-keys — 为自己签发新密钥。
 *
 * 计费主体绑定当前校验通过的登录用户；明文密钥只在这一次响应里出现。
 * label 可选，空则用默认名称「DSH 插件」。
 */
export async function POST(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return fail(auth.status, auth.message, "unauthorized");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "请求体格式不正确。", "invalid_request");
  }

  const label = normalizeUserBizKeyLabel(body.label);

  try {
    const all = await listBizApiKeys();
    const mine = all.filter((key) => key.userId === auth.user.id);
    if (mine.length >= USER_API_KEY_LIMIT) {
      return fail(
        400,
        `每个账号最多创建 ${USER_API_KEY_LIMIT} 个密钥，请先吊销不再使用的密钥。`,
        "key_limit_reached",
      );
    }

    const draft: BizKeyDraft = {
      label,
      // 计费主体只能来自校验结果，与后台签发走同一套存储层。
      userId: auth.user.id,
      rpm: BIZ_KEY_DEFAULT_RPM,
      allowedModels: [],
      enabled: true,
    };
    const generated = generateBizApiKey();
    const issued = await issueBizApiKey(draft, generated);

    return NextResponse.json({
      success: true,
      data: toPublicBizApiKey(issued.record),
      // 仅此一次：存储里只有哈希，关闭弹层后就拿不到了。
      key: issued.key,
    });
  } catch (error) {
    console.error("[user-biz-keys] 签发密钥失败。", error);
    return fail(503, "签发失败，请稍后再试。", "key_issue_failed");
  }
}
