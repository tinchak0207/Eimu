import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

function adminConfig() {
  const baseURL = process.env.ADOBE2API_ADMIN_BASE_URL?.trim().replace(/\/+$/, "");
  const username = process.env.ADOBE2API_ADMIN_USERNAME?.trim();
  const password = process.env.ADOBE2API_ADMIN_PASSWORD;
  if (!baseURL || !username || !password) throw new Error("ADOBE2API_ADMIN_NOT_CONFIGURED");
  return { baseURL, username, password };
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "管理员登录已失效" }, { status: 401 });
  }
  if (error instanceof Error && error.message === "ADOBE2API_ADMIN_NOT_CONFIGURED") {
    return NextResponse.json({ success: false, message: "Adobe 直连导入尚未配置" }, { status: 503 });
  }
  const message = error instanceof Error ? error.message : "导入失败";
  return NextResponse.json({ success: false, message }, { status: 400 });
}

async function adobeAdminCookie() {
  const { baseURL, username, password } = adminConfig();
  const response = await fetch(`${baseURL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const session = response.headers.get("set-cookie")?.match(/adobe2api_session=[^;]+/)?.[0];
  if (!response.ok || !session) throw new Error("Adobe 直连管理登录失败");
  return { baseURL, session };
}

export async function POST(req: NextRequest) {
  try {
    await requireAdminSession();
    const input = await req.json().catch(() => null) as { cookie?: unknown; name?: unknown } | null;
    const serialized = input?.cookie === undefined ? "" : JSON.stringify(input.cookie);
    if (!input || !serialized || serialized.length > 2_000_000) {
      return NextResponse.json({ success: false, message: "请选择不超过 2 MB 的 Cookie JSON" }, { status: 400 });
    }
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 100) : "";
    const { baseURL, session } = await adobeAdminCookie();
    const response = await fetch(`${baseURL}/api/v1/refresh-profiles/import-cookie`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: session },
      body: JSON.stringify({ cookie: input.cookie, name: name || undefined }),
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    });
    const body = await response.json().catch(() => null) as { status?: string; profile?: { name?: string } } | null;
    if (!response.ok) throw new Error(`Adobe Cookie 导入失败 (${response.status})`);
    return NextResponse.json({
      success: true,
      data: { status: body?.status ?? "ok", profileName: body?.profile?.name ?? (name || "Adobe") },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
