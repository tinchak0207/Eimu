import { NextRequest, NextResponse } from "next/server";
import { verifyAdminPassword } from "@/lib/admin-auth";
import { clearAdminSession, configuredAdminUsername, requireAdminSession, setAdminSession } from "@/lib/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const failedAttempts = new Map<string, { count: number; resetAt: number }>();
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function requestIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function POST(req: NextRequest) {
  const ip = requestIp(req);
  const now = Date.now();
  const attempts = failedAttempts.get(ip);
  if (attempts && attempts.resetAt > now && attempts.count >= MAX_ATTEMPTS) {
    return NextResponse.json({ success: false, message: "尝试次数过多，请 10 分钟后再试。" }, { status: 429 });
  }

  const body = await req.json().catch(() => ({})) as { username?: unknown; password?: unknown };
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const passwordHash = process.env.ADMIN_PASSWORD_HASH?.trim();

  if (!passwordHash) {
    return NextResponse.json({ success: false, message: "管理员登录尚未配置。" }, { status: 503 });
  }

  const valid = username === configuredAdminUsername() && verifyAdminPassword(password, passwordHash);
  if (!valid) {
    failedAttempts.set(ip, {
      count: attempts && attempts.resetAt > now ? attempts.count + 1 : 1,
      resetAt: attempts && attempts.resetAt > now ? attempts.resetAt : now + ATTEMPT_WINDOW_MS,
    });
    return NextResponse.json({ success: false, message: "账号或密码错误。" }, { status: 401 });
  }

  failedAttempts.delete(ip);
  await setAdminSession(username);
  return NextResponse.json({ success: true });
}

/**
 * DELETE /api/admin/session — 退出登录。
 *
 * 门禁与管理端其余路由一致（requireAdminSession；UNAUTHORIZED → 401），
 * 2026-10-05 红队修复：旧版 DELETE 不校验管理员。
 */
export async function DELETE() {
  try {
    await requireAdminSession();
    await clearAdminSession();
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "退出登录失败。";
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
