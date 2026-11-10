import { NextRequest, NextResponse } from "next/server";
import { verifyAdminPassword } from "@/lib/admin-auth";
import { clearAdminSession, configuredAdminUsername, requireAdminSession, setAdminSession } from "@/lib/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const failedAttempts = new Map<string, { count: number; resetAt: number }>();
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
// S-13：Map 硬上限 + 清理节流，防止伪造 IP 灌爆内存或每请求整表扫描。
const MAX_TRACKED_KEYS = 5000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
let lastCleanupAt = 0;

function cleanupExpired(now: number): void {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  for (const [key, entry] of failedAttempts) {
    if (entry.resetAt <= now) failedAttempts.delete(key);
  }
}

// 取 XFF 最后一段：仓库 nginx 用 `$proxy_add_x_forwarded_for`，真实对端 IP 追加在末段（首段可由客户端任意伪造）；
// Vercel 会把 XFF 覆写为单值，末段即首段。
function requestIp(req: NextRequest): string {
  const parts = req.headers.get("x-forwarded-for")?.split(",") ?? [];
  return parts[parts.length - 1]?.trim() || "unknown";
}

// 同步占位：读窗口计数 → 超限 429 → 否则先 +1。全程无 await，JS 单线程下同键并发不丢计数。
// Map 满时淘汰插入顺序最老的键为新键腾位（不拒绝新键，避免被灌键者挡住真管理员），内存仍以 5000 为界。
function reserveAttempt(ip: string, now: number): boolean {
  const existing = failedAttempts.get(ip);
  if (existing && existing.resetAt > now) {
    if (existing.count >= MAX_ATTEMPTS) return false;
    existing.count += 1;
    return true;
  }
  failedAttempts.delete(ip); // 过期项重建到插入顺序末尾
  while (failedAttempts.size >= MAX_TRACKED_KEYS) {
    const oldest = failedAttempts.keys().next();
    if (oldest.done) break;
    failedAttempts.delete(oldest.value);
  }
  failedAttempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
  return true;
}

export async function POST(req: NextRequest) {
  const ip = requestIp(req);
  const now = Date.now();
  cleanupExpired(now);
  if (!reserveAttempt(ip, now)) {
    return NextResponse.json({ success: false, message: "尝试次数过多，请 10 分钟后再试。" }, { status: 429 });
  }

  const body = await req.json().catch(() => ({})) as { username?: unknown; password?: unknown };
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const passwordHash = process.env.ADMIN_PASSWORD_HASH?.trim();

  if (!passwordHash) {
    failedAttempts.delete(ip); // 配置缺失不是猜测行为，撤销占位
    return NextResponse.json({ success: false, message: "管理员登录尚未配置。" }, { status: 503 });
  }

  const valid = username === configuredAdminUsername() && verifyAdminPassword(password, passwordHash);
  if (!valid) {
    // 失败：保持占位计数。
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
