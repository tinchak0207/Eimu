// 渠道連通性探測：對支持 OpenAI 風格 /models 的渠道發一次帶授權的 GET。
// 絕不觸發真實出圖——那是 image-upstream-probe 的職責（會扣費）。
//
// 誠實原則：某些渠道沒有 /models 端點，硬探只會恆紅騙人，
// 所以明確回報「不支持探測」而不是假裝探測失敗。

import { NextRequest, NextResponse } from "next/server";
import { readAdminPools } from "@/lib/admin-pool-store";
import { requireAdminSession } from "@/lib/admin-session";
import { describeEnvChannels } from "@/lib/sub2api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROBEABLE_ENV_CHANNEL_IDS = new Set(["env:sub2api", "env:primary", "env:fallback"]);
const UNPROBEABLE_CHANNEL_IDS = new Set<string>([]);

interface ProbeResult {
  ok: boolean;
  status?: number;
  ms: number;
  note?: string;
}

async function probeModelsEndpoint(endpoint: { baseURL: string; apiKey: string }): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${endpoint.baseURL}/models`, {
      headers: { Authorization: `Bearer ${endpoint.apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const ms = Date.now() - startedAt;
    if (!response.ok) {
      return { ok: false, status: response.status, ms, note: `上游返回 HTTP ${response.status}` };
    }
    return { ok: true, status: response.status, ms };
  } catch (error) {
    const ms = Date.now() - startedAt;
    const note = error instanceof Error && error.name === "TimeoutError" ? "连接超时（10 秒）" : "无法连接上游";
    return { ok: false, ms, note };
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdminSession();

    const body = (await req.json().catch(() => null)) as { channelId?: unknown } | null;
    const channelId = typeof body?.channelId === "string" ? body.channelId : "";
    if (!channelId) {
      return NextResponse.json({ success: false, message: "缺少 channelId。" }, { status: 400 });
    }

    if (UNPROBEABLE_CHANNEL_IDS.has(channelId)) {
      return NextResponse.json({ ok: null, supported: false, note: "此渠道不支持 /models 探测" });
    }

    if (PROBEABLE_ENV_CHANNEL_IDS.has(channelId)) {
      const channel = describeEnvChannels(process.env).find((item) => item.id === channelId);
      if (!channel?.endpoint) {
        return NextResponse.json({ ok: false, ms: 0, note: "渠道未配置，无法探测。" });
      }
      return NextResponse.json(await probeModelsEndpoint(channel.endpoint));
    }

    if (channelId.startsWith("pool:")) {
      const poolId = channelId.slice("pool:".length);
      const pool = (await readAdminPools()).find((item) => item.id === poolId);
      if (!pool) {
        return NextResponse.json({ success: false, message: "渠道不存在。" }, { status: 404 });
      }
      return NextResponse.json(await probeModelsEndpoint(pool));
    }

    return NextResponse.json({ success: false, message: "未知渠道。" }, { status: 400 });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ success: false, message: "请先登录管理员后台。" }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "探测失败。";
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
