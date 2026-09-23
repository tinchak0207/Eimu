import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { findGatewayUserByUsername, fetchGatewayUser, provisionBizBillingAccount } from "@/lib/gateway-admin";
import { ensureAccountBaselines, recordAdjustment } from "@/lib/generation-core/account-ledger";
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

    // 調整前的權威讀數（REQ-E1a 帳本 delta 的基準）；帳號不存在時視為新建（0 起算）。
    const beforeUser = await findGatewayUserByUsername(username);
    const beforeQuota = Math.round(Number(beforeUser?.quota ?? 0) || 0);
    // 順序鐵律：帳號存在時先種基線（動上游之前），再調整，最後記 adjustment。
    // 新帳號沒有可種的基線（第一次 touch 就是本刀的 adjustment），故只對既有帳號先種。
    const baselineReady = beforeUser
      ? await ensureAccountBaselines([beforeUser.id], { fetchUser: async (id) => fetchGatewayUser(id) })
      : true;

    const result = await provisionBizBillingAccount(username, Math.floor(images));

    // REQ-E1a 雙寫：provision 改的是上游 users.quota（adjust 路徑），我方帳本同步記
    // 一筆 adjustment。delta 由「呼叫前後的權威讀數」相減得出（不是重算目標值，
    // 免得把上游的取整/覆寫算成我們自己的帳）。記帳失敗不擋路，差額由對帳報告指出。
    const delta = Math.round(result.user.quota) - Math.round(beforeQuota);
    if (delta !== 0 && baselineReady) {
      const ledger = await recordAdjustment({
        billingUserId: result.user.id,
        amountQuota: delta,
        // 幂等鍵含「調整後的目標額度」：重放同一次 provision（同名、同目標）必然算出同一個鍵。
        sourceRef: `provision:${username}:${Math.round(result.user.quota)}`,
        note: `管理员调整 B 端计费账户额度（delta ${delta} quota）`,
        source: "admin-provision",
      });
      if (!ledger.posted) {
        console.error(`[admin/provision] ${username}: 帳本同步未落地（${ledger.reason}）——已由對帳報告負責`);
      }
    } else if (delta !== 0) {
      console.error(`[admin/provision] ${username}: 基線不可得，未記帳（delta ${delta} quota）——已由對帳報告負責`);
    }

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
