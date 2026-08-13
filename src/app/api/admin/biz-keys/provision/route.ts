import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { fetchGatewayUser, provisionBizBillingAccount } from "@/lib/gateway-admin";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

/** 一次最多开这么多张额度，防手滑多打一个零。 */
const MAX_INITIAL_IMAGES = 1_000_000;

/**
 * 用户名规则。
 * 长度上限 20 是上游 New API 的硬限制（model/user.go 的 `validate:"max=20"`），
 * 不是我们自己定的偏好 —— 超了上游会返回一句很难懂的字段校验错误。
 */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,19}$/;

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : "操作失败。";
  return NextResponse.json({ success: false, message }, { status: 400 });
}

/**
 * GET /api/admin/biz-keys/provision?userId=12 — 查一个上游账户的余额。
 *
 * 签发界面用它在填完 id 后即时显示余额，避免绑到一个空账户上
 * ——那样第一次调用就返回 402，聚合平台会以为密钥是坏的。
 */
export async function GET(req: NextRequest) {
  try {
    await requireAdminSession();

    const userId = Number(new URL(req.url).searchParams.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      return NextResponse.json({ success: false, message: "userId 无效。" }, { status: 400 });
    }

    const user = await fetchGatewayUser(userId);
    if (!user) {
      return NextResponse.json({ success: false, message: "上游没有这个用户。" }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      data: {
        id: user.id,
        username: user.username,
        quota: user.quota,
        images: user.quota / QUOTA_PER_COIN,
        usedQuota: user.used_quota ?? 0,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/admin/biz-keys/provision — 开一个专用 B 端计费账户并设定额度。
 *
 * 为什么放在服务端：上游管理凭证在 Vercel 里被标记为 sensitive，
 * `vercel env pull` 拿不回明文，只有运行时持有它们。
 * 幂等：同名账户已存在时复用，只把额度调到目标值。
 */
export async function POST(req: NextRequest) {
  try {
    await requireAdminSession();

    const body = (await req.json()) as { username?: unknown; images?: unknown };

    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    if (!USERNAME_PATTERN.test(username)) {
      return NextResponse.json(
        { success: false, message: "用户名需为 3–20 位，仅含小写字母、数字、下划线或短横线，且以字母或数字开头。" },
        { status: 400 },
      );
    }

    const images = Number(body.images);
    if (!Number.isFinite(images) || images < 0 || images > MAX_INITIAL_IMAGES) {
      return NextResponse.json(
        { success: false, message: `初始额度需在 0 到 ${MAX_INITIAL_IMAGES} 张之间。` },
        { status: 400 },
      );
    }

    const result = await provisionBizBillingAccount(username, Math.floor(images));

    return NextResponse.json({
      success: true,
      created: result.created,
      data: {
        id: result.user.id,
        username: result.user.username,
        quota: result.user.quota,
        images: result.user.quota / QUOTA_PER_COIN,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
