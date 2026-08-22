// GET /api/admin/proxy-pool — adobe2api 出口代理池观测面板数据源。
//
// 双模式部署：只有控制面实例（GENERATION_CONTROL_PLANE_ENABLED=true）能直连
// http://adobe2api:6001；Vercel edge 实例没有网络路径，改走 HMAC 签名内部通道
// 中继到控制面的 /api/internal/proxy-pool（域前缀 "proxy-pool"，与密钥写入通道
// 共用密钥但签名互不通用）。中继未配置或失败时返回 available:false 让 UI 优雅降级。
// 上游异常同样以 200 + available:false 返回，面板显示原因。

import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-session";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";
import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  signBizKeySync,
} from "@/lib/biz-key-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdminSession();
  } catch {
    return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
  }

  if (!generationControlPlaneEnabled()) {
    const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/$/, "");
    const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
    if (!origin || !secret) {
      return NextResponse.json({ success: true, data: { available: false, reason: "relay-not-configured" } });
    }

    const timestamp = String(Date.now());
    try {
      const relay = await fetch(`${origin}/image-control/api/internal/proxy-pool`, {
        headers: {
          [BIZ_KEY_SYNC_TIMESTAMP_HEADER]: timestamp,
          [BIZ_KEY_SYNC_SIGNATURE_HEADER]: signBizKeySync(secret, timestamp, "", "proxy-pool"),
        },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      const payload = await relay.json().catch(() => null);
      if (payload !== null) {
        return NextResponse.json(payload, { status: relay.status });
      }
      return NextResponse.json({ success: true, data: { available: false, reason: `relay HTTP ${relay.status}（响应不是 JSON）` } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "中继请求失败";
      return NextResponse.json({ success: true, data: { available: false, reason } });
    }
  }

  const apiKey = process.env.ADOBE2API_API_KEY ?? "";
  try {
    const response = await fetch("http://adobe2api:6001/api/v1/proxy-pool", {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!response.ok) {
      return NextResponse.json({ success: true, data: { available: false, reason: `upstream HTTP ${response.status}` } });
    }
    const upstream = (await response.json()) as { enabled?: boolean; proxies?: unknown };
    return NextResponse.json({ success: true, data: { available: true, ...upstream } });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "上游请求失败";
    return NextResponse.json({ success: true, data: { available: false, reason } });
  }
}
