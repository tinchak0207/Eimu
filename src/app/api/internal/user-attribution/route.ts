// 控制面側的用戶側車事實端點（已驗證真實 email ＋ 首次觸達歸因）。
//
// 呼叫方：Vercel 上
//   - /api/auth/github/callback、/api/auth/google/callback（email + 歸因，每次登入冪等 upsert）
//   - /api/auth/me（歸因補記，涵蓋微信等沒有 OAuth callback 的登入路徑）
//
// 鑑權復用 biz-key-sync 的 HMAC 通道（signatureDomain "user-attribution"），
// 與 welcome-gift / newapi-session-token 同一骨架；不回顯任何內部錯誤細節。
//
// 隱私：本路由**永不把 email 寫進回應或日誌**——成功只回 ok + written 布林。

import { NextRequest, NextResponse } from "next/server";
import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  verifyBizKeySync,
} from "@/lib/biz-key-sync";
import { generationDatabaseConfigured, getGenerationSql } from "@/lib/generation-core/database";
import {
  USER_ATTRIBUTION_RELAY_SIGNATURE_DOMAIN,
  createPostgresUserAttributionStore,
  parseAttributionUpsertBody,
} from "@/lib/user-attribution";
import { parseInviteCode } from "@/lib/referral-code";
import { createPostgresReferralStore } from "@/lib/referral-reward";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!secret) return NextResponse.json({ ok: false, message: "签名通道未配置。" }, { status: 503 });

  // 签名覆盖的是字节：必须读原文再解析。
  const rawBody = await req.text();
  const verified = verifyBizKeySync({
    secret,
    timestamp: req.headers.get(BIZ_KEY_SYNC_TIMESTAMP_HEADER),
    signature: req.headers.get(BIZ_KEY_SYNC_SIGNATURE_HEADER),
    rawBody,
    signatureDomain: USER_ATTRIBUTION_RELAY_SIGNATURE_DOMAIN,
  });
  if (!verified) return NextResponse.json({ ok: false, message: "签名校验失败。" }, { status: 401 });

  if (!generationDatabaseConfigured()) {
    return NextResponse.json({ ok: false, message: "储存层未配置。" }, { status: 503 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, message: "请求体不是合法 JSON。" }, { status: 400 });
  }

  // 邀請綁定：驗簽還原邀請人 → 只在被邀請人未出過圖時綁定（首個邀請勝出）。
  // 碼不合法／自己邀自己／已出過圖＝判定完成（ok），不讓 Vercel 側每次登入重送。
  const invite = parsed as { op?: unknown; userId?: unknown; inviteCode?: unknown } | null;
  if (invite?.op === "invite") {
    const inviteeId = Number(invite.userId);
    if (!Number.isInteger(inviteeId) || inviteeId <= 0) {
      return NextResponse.json({ ok: false, message: "缺少合法的 userId。" }, { status: 400 });
    }
    const inviterId = parseInviteCode(typeof invite.inviteCode === "string" ? invite.inviteCode : null, secret);
    if (!inviterId || inviterId === inviteeId) return NextResponse.json({ ok: true, bound: false });
    try {
      const bound = await createPostgresReferralStore(getGenerationSql()).bind(inviteeId, inviterId);
      return NextResponse.json({ ok: true, bound });
    } catch (error) {
      console.error(`[internal/user-attribution] invite bind failed user=${inviteeId}：${error instanceof Error ? error.message : String(error)}`);
      return NextResponse.json({ ok: false, message: "邀请绑定失败。" }, { status: 500 });
    }
  }

  const record = parseAttributionUpsertBody(parsed);
  if (!record) return NextResponse.json({ ok: false, message: "缺少合法的 userId。" }, { status: 400 });

  try {
    const written = await createPostgresUserAttributionStore().upsert(record);
    return NextResponse.json({ ok: true, written });
  } catch (error) {
    // 只印 user_id 與錯誤訊息，絕不印請求體（含 email）。
    console.error(
      `[internal/user-attribution] upsert failed user=${record.userId}：${error instanceof Error ? error.message : String(error)}`,
    );
    return NextResponse.json({ ok: false, message: "侧车事实写入失败。" }, { status: 500 });
  }
}
