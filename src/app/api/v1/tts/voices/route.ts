// GET /v1/tts/voices — 语音库（P1-11／对称差 D33）。
//
// 对标口径：对手的 `ListVoices` **无参数全量回**，每个音色带结构化属性
// `{Id, Age, Gender, Description, Name}`。本端点照这个形状回，并多给两栏我方诚实需要的资讯：
//   - `route`：这颗音色实际走哪条上游（siliconflow 主路／edge 降级）
//   - `source`：每一条属性的实查来源（档案:行号／指令），让「这不是编的」可被复核
//   - `age`：**一律缺席**——上游 edge-tts 清单没有 Age，我方没有真源，不编造。
//
// 认证与错误形状与其他 `/v1/*` 同一套（biz key → 401/403/429；不新造收口）。

import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { DEFAULT_TTS_VOICE, listVoices } from "@/lib/voice-library";

export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

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
      // 未带 voice 时上游实际用的音色（proxy 的 DEFAULT_VOICE）——把预设值也变成明示的，
      // 呼叫端不必去猜「不填会怎样」。
      default_voice: DEFAULT_TTS_VOICE,
      // 我方的边界宣告：这些属性有真源、Age 没有。诚实比完整重要。
      notes: [
        "age 一律不提供：上游 edge-tts 语音清单没有 Age 字段，我方无真源，不编造。",
        "接受集大于描述集：voice 也接受上游按模式接受的 edge 音色名与 \"<model>:<preset>\" 形式（见 /docs 或 voice-library.ts 档头）。",
      ],
    },
    { status: 200 },
  );
  return addRateLimitHeaders(withTraceId(response, traceId), auth.key, { consumed: false });
}
