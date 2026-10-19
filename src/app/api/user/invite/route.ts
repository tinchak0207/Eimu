// GET /api/user/invite — 当前用户的邀请连结（我方自签邀请码，见 src/lib/referral-code.ts）。
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/server-user";
import { buildInviteUrl, inviteCodeFor, referralSecret } from "@/lib/referral-code";
import { getSiteUrl } from "@/lib/site-url";

export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

export async function GET(req: NextRequest) {
  const auth = await requireVerifiedUser(req);
  if (!auth.ok) return NextResponse.json({ success: false, message: auth.message }, { status: auth.status });
  const secret = referralSecret();
  if (!secret) return NextResponse.json({ success: false, message: "邀请暂不可用，请稍后再试。" }, { status: 503 });
  const code = inviteCodeFor(auth.user.id, secret);
  return NextResponse.json({ success: true, data: { code, url: buildInviteUrl(await getSiteUrl(), code) } });
}
