// GET /v1/tts/voices — 語音庫（P1-11／對稱差 D33）。
//
// 對標口徑：對手的 `ListVoices` **無參數全量回**，每個音色帶結構化屬性
// `{Id, Age, Gender, Description, Name}`。本端點照這個形狀回，並多給兩欄我方誠實需要的資訊：
//   - `route`：這顆音色實際走哪條上游（siliconflow 主路／edge 降級）
//   - `source`：每一條屬性的實查來源（檔案:行號／指令），讓「這不是編的」可被複核
//   - `age`：**一律缺席**——上游 edge-tts 清單沒有 Age，我方沒有真源，不編造。
//
// 認證與錯誤形狀與其他 `/v1/*` 同一套（biz key → 401/403/429；不新造收口）。

import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { DEFAULT_TTS_VOICE, listVoices } from "@/lib/voice-library";

export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

function errorResponse(
  status: number,
  message: string,
  type: string,
  code: string,
  traceId: string,
  key?: BizApiKey,
) {
  let response: Response = NextResponse.json(
    { error: { message, type, code, param: null, trace_id: traceId } },
    { status },
  );
  if (key) response = addRateLimitHeaders(response, key, { consumed: false });
  return withTraceId(response, traceId);
}

export async function GET(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);

  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) {
    const type: "rate_limit_error" | "permission_error" | "authentication_error" =
      auth.status === 429 ? "rate_limit_error" : auth.status === 403 ? "permission_error" : "authentication_error";
    return errorResponse(auth.status, auth.message, type, auth.code, traceId);
  }

  const response = NextResponse.json(
    {
      object: "list",
      data: listVoices().map((voice) => ({
        id: voice.id,
        name: voice.name,
        ...(voice.gender ? { gender: voice.gender } : {}),
        ...(voice.description ? { description: voice.description } : {}),
        route: voice.route,
        source: voice.source,
      })),
      // 未帶 voice 時上游實際用的音色（proxy 的 DEFAULT_VOICE）——把預設值也變成明示的，
      // 呼叫端不必去猜「不填會怎樣」。
      default_voice: DEFAULT_TTS_VOICE,
      // 我方的邊界宣告：這些屬性有真源、Age 沒有。誠實比完整重要。
      notes: [
        "age 一律不提供：上游 edge-tts 语音清单没有 Age 字段，我方无真源，不编造。",
        "接受集大于描述集：voice 也接受上游按模式接受的 edge 音色名与 \"<model>:<preset>\" 形式（见 /docs 或 voice-library.ts 档头）。",
      ],
    },
    { status: 200 },
  );
  return addRateLimitHeaders(withTraceId(response, traceId), auth.key, { consumed: false });
}
