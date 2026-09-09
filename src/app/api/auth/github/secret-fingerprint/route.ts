import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";

// 臨時診斷路由（遷移驗證用，驗完即刪）：輸出 GITHUB_LOGIN_SECRET 指紋，
// 不回顯值本身。fingerprint = sha256(trimmed(secret)) 前 8 hex。
export async function GET(_req: NextRequest) {
  const raw = process.env.GITHUB_LOGIN_SECRET ?? "";
  const trimmed = raw.trim();
  const fp = createHash("sha256").update(trimmed).digest("hex").slice(0, 8);
  return NextResponse.json({
    present: raw.length > 0,
    rawLen: raw.length,
    trimmedLen: trimmed.length,
    trimmedHex: /^[0-9a-f]+$/.test(trimmed),
    fp,
  });
}
