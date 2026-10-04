import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { GatewayEndpoint } from "@/lib/sub2api";
import { buildModelQueue } from "@/lib/channel-registry";
import { getRuntimeChannelOverrides } from "@/lib/channel-overrides";
import { getRuntimeGatewayPools } from "@/lib/admin-pool-store";
import { resolveUpstreamModelId } from "@/lib/provider-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const MODELS = ["gpt-image-2", "gemini-3.1-flash-image"];

function probeToken(): string {
  return (process.env.IMAGE_UPSTREAM_PROBE_TOKEN ?? "").trim();
}

function probeAuthorized(req: NextRequest): boolean {
  const expected = probeToken();
  const actual = req.headers.get("x-image-upstream-probe") ?? "";
  if (!expected || expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function endpointHost(endpoint: GatewayEndpoint): string {
  try {
    return new URL(endpoint.baseURL).host;
  } catch {
    return "invalid-url";
  }
}

async function generate(endpoint: GatewayEndpoint, modelId: string) {
  const response = await fetch(`${endpoint.baseURL}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.apiKey}` },
    body: JSON.stringify({
      model: resolveUpstreamModelId(modelId, endpoint.modelId),
      prompt: "A single white ceramic cup on a neutral studio background, product photograph.",
      n: 1,
      size: "1024x1024",
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(180_000),
  });
  const rawText = await response.text();
  let payload: { data?: Array<{ b64_json?: string; url?: string }>; error?: unknown } | null = null;
  try {
    payload = JSON.parse(rawText);
  } catch {
    payload = null;
  }
  const image = payload?.data?.[0];
  return {
    ok: response.ok && Boolean(image?.b64_json || image?.url),
    status: response.status,
    imageKind: image?.b64_json ? "base64" : image?.url ? "url" : null,
    // The raw upstream error body has never actually been inspected for the primary/
    // fallback 403s — status alone was assumed to mean "bad key" without evidence.
    errorBody: response.ok
      ? undefined
      : (typeof payload?.error === "string" ? payload.error : JSON.stringify(payload?.error ?? rawText)).slice(0, 500),
  };
}

export async function POST(req: NextRequest) {
  if (!probeAuthorized(req)) {
    const expected = probeToken();
    return NextResponse.json({
      error: "Probe token rejected",
      configured: Boolean(expected),
      expectedLength: expected.length,
      providedLength: (req.headers.get("x-image-upstream-probe") ?? "").length,
    }, { status: 401 });
  }

  // 队列必须与生产同源：channel-registry 的 buildModelQueue（含 admin 池、调度启停与
  // 优先级覆写）。旧版在这里自行拼 env 端点 + 池合并，admin 在调度面板停用的渠道
  // 照样被真实出图扣费，还被回报成「生产队列」——正是渠道统一调度要消灭的病。
  const [pools, overrides] = await Promise.all([getRuntimeGatewayPools(), getRuntimeChannelOverrides()]);
  const results = [];

  for (const modelId of MODELS) {
    const endpoints = buildModelQueue(modelId, process.env, pools, overrides);
    const attempts = [];
    for (const endpoint of endpoints) {
      try {
        const result = await generate(endpoint, modelId);
        attempts.push({ endpoint: endpoint.label, host: endpointHost(endpoint), ...result });
        if (result.ok) break;
      } catch (error) {
        attempts.push({
          endpoint: endpoint.label,
          host: endpointHost(endpoint),
          ok: false,
          status: null,
          imageKind: null,
          errorBody: error instanceof Error ? error.message : String(error),
        });
      }
    }
    results.push({
      modelId,
      queue: endpoints.map((endpoint) => ({ endpoint: endpoint.label, host: endpointHost(endpoint) })),
      attempts,
    });
  }

  return NextResponse.json({
    queueSource: "channel-registry:buildModelQueue（与生产队列同源，含调度停用与优先级覆写）",
    results,
  });
}
