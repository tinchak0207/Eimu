// GET /api/user/model-status — C 端模型選單的活性字典。
//
// 數據源與 AI 助理的 /v1/model-status 完全同源：經 GENERATION_CONTROL_PLANE_PROXY_ORIGIN
// 走 HMAC 簽名通道（域 "model-status"）調控制面內部端點 /image-control/api/internal/model-status。
// 判據全在控制面那一側（probeAllModelsStatus + last_24h 真實交付 + balance 欠費覆寫 +
// supplier 執行側同源最終裁決）——Vercel 邊緣拿不到控制面 Postgres（admin pools /
// routing-events 都在那一側），本地復刻 probe 只會全 unknown（env 渠道全非 OpenAI 兼容）。
//
// 公開無 auth（與 /api/user/model-eta 同例）：只回模型名 + 三態，不含渠道/帳號/憑證等
// 敏感面。模組級緩存 60 秒；控制面內部端點自身也有 60s 緩存，這裡的緩存是 HTTP 層，
// 避免每個請求都穿一次簽名通道。
//
// 失敗語義：控制面不可達/簽名失敗 → fail-open 返回空字典（前端全當活），絕不因活性
// 拉取把選單打掛——與後端 fail-open 紀律一致。

import { NextResponse } from "next/server";
import { signBizKeySync } from "@/lib/biz-key-sync";
import { SUPPORTED_GENERATION_MODEL_IDS } from "@/lib/image-model-ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    console.error("[user/model-status] 代理 origin/secret 未配置，fail-open 全當活");
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
    console.error("[user/model-status] 控制面代理請求失敗，fail-open 全當活", error);
    return {};
  }
  if (!res.ok) {
    console.error(`[user/model-status] 控制面代理返回 status=${res.status}，fail-open 全當活`);
    return {};
  }
  const data = (await res.json().catch(() => null)) as InternalModelStatusResponse | null;
  const remote = data?.models;
  if (!remote) {
    console.error("[user/model-status] 控制面回應缺 models，fail-open 全當活");
    return {};
  }

  // 收斂到支援的模型清單；控制面缺席的模型當 unknown（死活未知當活）。
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
