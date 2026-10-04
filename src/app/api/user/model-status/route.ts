// GET /api/user/model-status — C 端模型选单的活性字典。
//
// 数据源与 AI 助理的 /v1/model-status 完全同源：经 GENERATION_CONTROL_PLANE_PROXY_ORIGIN
// 走 HMAC 签名通道（域 "model-status"）调控制面内部端点 /image-control/api/internal/model-status。
// 判据全在控制面那一侧（probeAllModelsStatus + last_24h 真实交付 + balance 欠费覆写 +
// supplier 执行侧同源最终裁决）——Vercel 边缘拿不到控制面 Postgres（admin pools /
// routing-events 都在那一侧），本地复刻 probe 只会全 unknown（env 渠道全非 OpenAI 兼容）。
//
// 公开无 auth（与 /api/user/model-eta 同例）：只回模型名 + 三态，不含渠道/帐号/凭证等
// 敏感面。模组级缓存 60 秒；控制面内部端点自身也有 60s 缓存，这里的缓存是 HTTP 层，
// 避免每个请求都穿一次签名通道。
//
// 失败语义：控制面不可达/签名失败 → fail-open 返回空字典（前端全当活），绝不因活性
// 拉取把选单打挂——与后端 fail-open 纪律一致。

import { NextResponse } from "next/server";
import { signBizKeySync } from "@/lib/biz-key-sync";
import { SUPPORTED_GENERATION_MODEL_IDS } from "@/lib/image-model-ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 与 VPS（闸道/控制面 DB，矽谷）同区：每次上游往返省一趟横跨美国（2026-10-01 效能审计）

type Availability = "available" | "unavailable" | "unknown";

const SIGNATURE_DOMAIN = "model-status";
const TTL_MS = 60_000;
const PROXY_TIMEOUT_MS = 15_000;
let cache: { expiresAt: number; data: Record<string, Availability> } | null = null;

interface InternalModelStatusResponse {
  ok?: boolean;
  models?: Record<string, string>;
}

async function fetchControlPlaneModels(): Promise<Record<string, Availability>> {
  const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/+$/, "");
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!origin || !secret) {
    console.error("[user/model-status] 代理 origin/secret 未配置，fail-open 全当活");
    return {};
  }

  const now = Date.now();
  const rawBody = JSON.stringify({});
  const timestamp = String(now);
  const signature = signBizKeySync(secret, timestamp, rawBody, SIGNATURE_DOMAIN);

  let res: Response;
  try {
    res = await fetch(`${origin}/image-control/api/internal/model-status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Biz-Key-Sync-Timestamp": timestamp,
        "X-Biz-Key-Sync-Signature": signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[user/model-status] 控制面代理请求失败，fail-open 全当活", error);
    return {};
  }
  if (!res.ok) {
    console.error(`[user/model-status] 控制面代理返回 status=${res.status}，fail-open 全当活`);
    return {};
  }
  const data = (await res.json().catch(() => null)) as InternalModelStatusResponse | null;
  const remote = data?.models;
  if (!remote) {
    console.error("[user/model-status] 控制面回应缺 models，fail-open 全当活");
    return {};
  }

  // 收敛到支援的模型清单；控制面缺席的模型当 unknown（死活未知当活）。
  const models: Record<string, Availability> = {};
  for (const modelId of SUPPORTED_GENERATION_MODEL_IDS) {
    const av = remote[modelId];
    models[modelId] = av === "available" || av === "unavailable" || av === "unknown" ? av : "unknown";
  }
  return models;
}

export async function GET() {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return NextResponse.json({ models: cache.data }, { headers: { "Cache-Control": "public, s-maxage=60" } });
  }

  const models = await fetchControlPlaneModels();
  cache = { expiresAt: now + TTL_MS, data: models };
  return NextResponse.json({ models }, { headers: { "Cache-Control": "public, s-maxage=60" } });
}
