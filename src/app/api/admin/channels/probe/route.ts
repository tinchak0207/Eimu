// 渠道连通性探测：对支持 OpenAI 风格 /models 的渠道发一次带授权的 GET。
// 绝不触发真实出图——那是 image-upstream-probe 的职责（会扣费）。
//
// 诚实原则：某些渠道没有 /models 端点，硬探只会恒红骗人，
// 所以明确回报「不支持探测」而不是假装探测失败。

import { NextRequest, NextResponse } from "next/server";
import { readAdminPools } from "@/lib/admin-pool-store";
import { requireAdminSession } from "@/lib/admin-session";
import { describeEnvChannels } from "@/lib/sub2api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{4,}/gi, "[redacted]")
    .replace(/bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/key=[^\s&"'<>]+/gi, "key=[redacted]");
}

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
        return NextResponse.json({ ok: false, ms: 0, note: "渠道未配置，无法探测。" }, { status: 503 });
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
    const raw = error instanceof Error ? error.message : "探测失败。";
    console.error("[admin-channels-probe]", redactSecrets(raw));
    return NextResponse.json({ success: false, message: "探测失败。" }, { status: 500 });
  }
}
