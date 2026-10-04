// GET /openai/v1/models — 标准 OpenAI 模型清单形状，供中转站做模型发现／上架。
//
// 只列**当下真的能出图**的图片模型：白名单（金钥）+ 目录 kind=image + 真实生成结果驱动的
// 熔断／断供闸，三条都复用站内既有函数（见 lib/openai-compat/models.ts 档头）。
// 影片、TTS、数字人等非图片模型一概不列——它们不是 OpenAI Images 形状，列出来只会让
// 中转站把它们 POST 到 /openai/v1/images/generations 再收 400。
import { NextRequest, NextResponse } from "next/server";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { guardBizApiKey } from "@/lib/openai-compat/errors";
import { listCompatibleImageModelIds, openAICompatModelList } from "@/lib/openai-compat/models";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";
// 与 /v1/models 同区：这条路要读控制面的熔断名单。
export const preferredRegion = "sfo1";

export async function GET(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const guard = await guardBizApiKey(req, traceId);
  if (!guard.ok) return guard.response;

  const ids = await listCompatibleImageModelIds(guard.key);

  return addRateLimitHeaders(
    withTraceId(
      NextResponse.json(openAICompatModelList(ids), { headers: { "Cache-Control": "no-store" } }),
      traceId,
    ),
    guard.key,
  );
}
