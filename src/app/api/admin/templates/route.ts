// 场景模板的只读管理面。真正的模板库（templates-cache.json）托管在 VPS，
// 这里用 admin session 校验后代理到 VPS 的 `GET /v1/templates`（VPS 侧缓存，
// TTL 1h），由 VPS 返回缓存的场景+preset 快照。
//
// 安全：这条路由只有持有 admin session cookie 的人能访问；不读、不转发任何
// BIZ_API_KEY —— 展示模板不需要上游密钥。
//
// TODO: 新增/编辑/删除场景 - 需要 VPS admin endpoint
// POST   /api/admin/templates             - 新增场景
// PUT    /api/admin/templates/:sceneId    - 更新
// DELETE /api/admin/templates/:sceneId    - 删除
// 当前仅实现 GET 只读；CRUD 后端与 /v1/templates 的写入通道尚未打通。

import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { getGatewayBaseUrl } from "@/lib/new-api-auth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : "读取场景模板失败。";
  return NextResponse.json({ success: false, message }, { status: 500 });
}

export async function GET() {
  try {
    await requireAdminSession();

    const baseURL = getGatewayBaseUrl().replace(/\/+$/, "");
    const response = await fetch(`${baseURL}/v1/templates`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`上游返回 HTTP ${response.status}`);
    }

    let body: { scenes?: unknown } = {};
    try {
      body = JSON.parse(text) as { scenes?: unknown };
    } catch {
      throw new Error("上游返回了非 JSON 的场景模板。");
    }

    return NextResponse.json({ success: true, scenes: Array.isArray(body.scenes) ? body.scenes : [] });
  } catch (error) {
    return errorResponse(error);
  }
}