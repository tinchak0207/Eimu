// 定價頁首充卡（plan id `first-charge`）的資格查詢：這張卡要不要顯示。
//
// 登入態從 napi_token cookie 反查 userId（控面穩定令牌表，與 checkout 同一條路），
// 再經 HMAC 通道問控面「這個帳號還有沒有首充資格」（判準唯一權威在 src/lib/first-charge.ts：
// 帳本從無 recharge 行、且從未買過本檔）。
//
// 只讀、不碰錢路。通道不可用／未登入一律回 eligible:false（保守：優惠卡不給，
// 真正的執法點是 checkout 的 403 與入帳時的按正價折算，這裡只是增值入口）。
// 回應不含 userId，也不含任何憑證。

import { NextRequest, NextResponse } from "next/server";
import { readFirstChargeEligibilityViaRelay } from "@/lib/first-charge";
import { lookupUserIdByTokenViaRelay } from "@/lib/newapi-session-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 登入 cookie 名（與 new-api-client.ts 的 TOKEN_KEY 同名；服務端只讀不寫）。 */
const TOKEN_COOKIE = "napi_token";
/** 反查預算是增值路徑的禮貌：查不到就當沒資格，不拖慢定價頁。 */
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