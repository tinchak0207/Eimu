import { NextRequest, NextResponse } from "next/server";
import {
  BIZ_KEY_DEFAULT_RPM,
  generateBizApiKey,
  normalizeUserBizKeyLabel,
  toPublicBizApiKey,
  USER_API_KEY_LIMIT,
  type BizKeyDraft,
} from "@/lib/biz-api-keys";
import { issueBizApiKey, listBizApiKeys } from "@/lib/biz-api-key-store";
import { verifyEmuOauthCode } from "@/lib/emu-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

function fail(status: number, message: string, code: string) {
  return NextResponse.json({ success: false, message, code }, { status });
}

/**
 * POST /api/auth/emu-oauth/exchange — 用回环授权凭证换自动签发的 B 端密钥。
 *
 * 凭证验证通过即等价于「用户刚在站点完成 GitHub 登录」，因此不读任何
 * 授权头、不依赖会话：userId 完全来自签名凭证。明文密钥只在这一次响应里出现，
 * 存储里只留哈希（issueBizApiKey 语义）。
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "请求体格式不正确。", "invalid_request");
  }

  const code = typeof body.code === "string" ? body.code : "";
  const userId = verifyEmuOauthCode(code);
  if (userId === null) {
    return fail(401, "授权凭证无效或已过期，请重新发起授权。", "invalid_code");
  }

  try {
    const all = await listBizApiKeys();
    const mine = all.filter((key) => key.userId === userId);
    if (mine.length >= USER_API_KEY_LIMIT) {
      return fail(
        400,
        `每个账号最多创建 ${USER_API_KEY_LIMIT} 个密钥，请先吊销不再使用的密钥。`,
        "key_limit_reached",
      );
    }

    const draft: BizKeyDraft = {
      label: normalizeUserBizKeyLabel(undefined),
      userId,
      rpm: BIZ_KEY_DEFAULT_RPM,
      allowedModels: [],
      enabled: true,
    };
    const generated = generateBizApiKey();
    const issued = await issueBizApiKey(draft, generated);

    return NextResponse.json({
      success: true,
      data: {
        // 明文只此一次：存储里只有哈希，插件拿到后应立刻持久化。
        key: issued.key,
        preview: toPublicBizApiKey(issued.record).keyPreview,
      },
    });
  } catch (error) {
    console.error("[emu-oauth/exchange] 签发密钥失败。", error);
    return fail(503, "签发失败，请稍后再试。", "key_issue_failed");
  }
}
