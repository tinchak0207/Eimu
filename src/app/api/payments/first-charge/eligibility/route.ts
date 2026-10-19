// 定价页首充卡（plan id `first-charge`）的资格查询：这张卡要不要显示。
//
// 登入态从 napi_token cookie 反查 userId（控面稳定令牌表，与 checkout 同一条路），
// 再经 HMAC 通道问控面「这个帐号还有没有首充资格」（判准唯一权威在 src/lib/first-charge.ts：
// 帐本从无 recharge 行、且从未买过本档）。
//
// 只读、不碰钱路。通道不可用／未登入一律回 eligible:false（保守：优惠卡不给，
// 真正的执法点是 checkout 的 403 与入帐时的按正价折算，这里只是增值入口）。
// 回应不含 userId，也不含任何凭证。

import { NextRequest, NextResponse } from "next/server";
import { readFirstChargeEligibilityViaRelay } from "@/lib/first-charge";
import { lookupUserIdByTokenViaRelay } from "@/lib/newapi-session-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

/** 登入 cookie 名（与 new-api-client.ts 的 TOKEN_KEY 同名；服务端只读不写）。 */
const TOKEN_COOKIE = "napi_token";
/** 反查预算是增值路径的礼貌：查不到就当没资格，不拖慢定价页。 */
const LOOKUP_BUDGET_MS = 2_500;

async function resolveUserId(token: string): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookupUserIdByTokenViaRelay(token),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), LOOKUP_BUDGET_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  const token = req.cookies.get(TOKEN_COOKIE)?.value?.trim();
  if (!token) return NextResponse.json({ success: true, loggedIn: false, eligible: false });

  const userId = await resolveUserId(token);
  if (!userId) return NextResponse.json({ success: true, loggedIn: false, eligible: false });

  const eligible = await readFirstChargeEligibilityViaRelay({ userId });
  return NextResponse.json({ success: true, loggedIn: true, eligible: eligible === true });
}