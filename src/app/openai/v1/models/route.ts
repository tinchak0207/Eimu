// GET /openai/v1/models — 標準 OpenAI 模型清單形狀，供中轉站做模型發現／上架。
//
// 只列**當下真的能出圖**的圖片模型：白名單（金鑰）+ 目錄 kind=image + 真實生成結果驅動的
// 熔斷／斷供閘，三條都複用站內既有函數（見 lib/openai-compat/models.ts 檔頭）。
// 影片、TTS、數字人等非圖片模型一概不列——它們不是 OpenAI Images 形狀，列出來只會讓
// 中轉站把它們 POST 到 /openai/v1/images/generations 再收 400。
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
