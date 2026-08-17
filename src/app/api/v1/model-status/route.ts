// GET /v1/model-status — 對外、agent-friendly 的模型可用性狀態。
//
// 回傳所有生成模型（image+video）的可用性 + 能力 + 功能標註，讓 AI 助手一眼判斷
// 「哪個模型可用、能幹嘛、調哪個端點」。探測只發 GET {baseURL}/models（渠道的
// /models 清單端點）——不觸發真實生成、不扣費；無 /models 能力的渠道
// 回報 unknown + note，而不是假裝探測失敗。結果模組級緩存 60 秒（probe.cached 指示）。
//
// 認證/限流/錯誤格式與 /v1/system_stats 完全一致：biz key、rate limit headers、
// trace_id、OpenAI 風格 {error:{message,type,code,param,trace_id}} 錯誤體。

import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { readAdminPools } from "@/lib/admin-pool-store";
import { getRuntimeChannelOverrides } from "@/lib/channel-overrides";
import { probeAllModelsStatus } from "@/lib/model-status-probe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, message: string, code: string, traceId: string, key?: BizApiKey) {
  let response: Response = NextResponse.json(
    { error: { message, type: "invalid_request_error", code, param: null, trace_id: traceId } },
    { status },
  );
  if (key) response = addRateLimitHeaders(response, key, { consumed: false });
  return withTraceId(response, traceId);
}

export async function GET(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")), {
    consumeRateLimit: false,
  });
  if (!auth.ok) return errorResponse(auth.status, auth.message, auth.code, traceId);

  // 隊列輸入與真實生成路由同源：admin 池 + admin overrides + 本實例 env。
  const [pools, overrides] = await Promise.all([
    readAdminPools().catch(() => []),
    getRuntimeChannelOverrides(),
  ]);
  const snapshot = await probeAllModelsStatus({ env: process.env, pools, overrides });

  const response = addRateLimitHeaders(
    NextResponse.json({ object: "model_status", ...snapshot }, { headers: { "Cache-Control": "no-store" } }),
    auth.key,
    { consumed: false },
  );
  return withTraceId(response, traceId);
}
