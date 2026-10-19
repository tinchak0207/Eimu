// POST /api/harness/media/quality —— 已生成媒体产物的确定性硬检（给 MCP 外部 agent 的自检面）。
//
// 定位：对**已经生成完成**的档案（影片/图/音讯）做**确定性、非模型意见**的品质量测。
//   本档不呼叫任何模型、不呼叫任何付费上游、不扣费、不写账本；只用
//   `src/lib/media-quality-gate.ts` 的 `probeMedia`（本机 ffprobe/ffmpeg）与
//   `evaluateMediaQuality`（纯函式套政策阈值）。
//
// 为什么在 `/api/harness/**` 而不是 `/api/v1/**`：后者被 next.config.mjs 的 beforeFiles
//   整包代理给控制面（`/image-control/api/v1/**`），控面没有本 route ⇒ 直打 404。harness
//   前缀未被代理，由本部署直接服务；MCP 工具目标路由漂移由 tools.test.ts 守门。
//
// 诚实红线（照 media-quality-gate.ts 的措辞）：
//   **未知 ≠ 通过。** 本部署环境（Vercel serverless）**不保证有 ffprobe/ffmpeg**；探测不可用时
//   `probeMedia` 回 `probe_unavailable`，`evaluateMediaQuality` 会回 `ok:false` 并带
//   `probe_unavailable` failure——本路由**原样**回给呼叫方（让呼叫方知道「量测没有发生」，
//   而不是误以为「检查通过」）。呼叫方也可以自己 ffprobe 后把 `probe` 传进来，我们只负责套用
//   **我们的政策与阈值**。
//
// 惯例逐项照抄既有 /api/v1 route（本专案 B 端 API 的通行形状）：biz-key 鉴权、OpenAI 风格
//   错误信封、runtime/preferredRegion、traceId 走 getOrCreateTraceId/withTraceId。成功回包＝
//   `QualityVerdict` 本体（`{ ok, measured, failures, policyId }`）。

import { NextRequest, NextResponse } from "next/server";
import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import {
  QUALITY_POLICIES,
  evaluateMediaQuality,
  probeMedia,
  type MediaProbe,
  type QualityVerdict,
} from "@/lib/media-quality-gate";

export const runtime = "nodejs";
export const preferredRegion = "sfo1";

/** 探测（本机 ffprobe/ffmpeg＋URL 下载）实打实要时间；与 probeMedia 预设同级，不超过它。 */
const PROBE_TIMEOUT_MS = 15_000;
/** 未给 policy 时的预设（与 media-quality-gate 的 video_default 同名同语义）。 */
const DEFAULT_POLICY_ID = "video_default";

type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "api_error";

/** OpenAI 风格错误体（与 /v1/images/generations 同一形状，只多带 trace_id）。 */
function errorResponse(
  status: number,
  message: string,
  type: OpenAIErrorType,
  code: string,
  traceId: string,
  headers?: Record<string, string>,
) {
  const response = NextResponse.json(
    { error: { message, type, code, param: null, trace_id: traceId } },
    { status, ...(headers ? { headers } : {}) },
  );
  return withTraceId(response, traceId);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function POST(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);

  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) {
    const type: OpenAIErrorType =
      auth.status === 429 ? "rate_limit_error" : auth.status === 403 ? "permission_error" : "authentication_error";
    return errorResponse(
      auth.status,
      auth.message,
      type,
      auth.code,
      traceId,
      auth.retryAfterSeconds ? { "Retry-After": String(auth.retryAfterSeconds) } : undefined,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "请求体不是合法 JSON。", "invalid_request_error", "invalid_json", traceId);
  }
  if (!isPlainObject(body)) {
    return errorResponse(400, "请求体必须是 JSON 对象。", "invalid_request_error", "invalid_payload", traceId);
  }

  // body 白名单：policy 未知 → 400（用 hasOwnProperty，挡掉 "constructor" 之类原型链幻影）。
  const policyId = body.policy === undefined ? DEFAULT_POLICY_ID : body.policy;
  if (typeof policyId !== "string" || !Object.prototype.hasOwnProperty.call(QUALITY_POLICIES, policyId)) {
    return errorResponse(
      400,
      `policy 未知：只接受 ${Object.keys(QUALITY_POLICIES).join(" / ")}。`,
      "invalid_request_error",
      "invalid_policy",
      traceId,
    );
  }
  const policy = QUALITY_POLICIES[policyId];

  const probe = body.probe;
  if (probe !== undefined && !isPlainObject(probe)) {
    return errorResponse(400, "probe 必须是物件（MediaProbe 形状）。", "invalid_request_error", "invalid_probe", traceId);
  }

  const mediaUrl = body.media_url;
  if (mediaUrl !== undefined && typeof mediaUrl !== "string") {
    return errorResponse(400, "media_url 必须是字串。", "invalid_request_error", "invalid_media_url", traceId);
  }

  // 有 probe 就直接套政策（不做服务器量测）；否则用 media_url 实测；两者都没有＝无从量测 → 400。
  let measured: MediaProbe;
  if (probe !== undefined) {
    measured = probe as unknown as MediaProbe;
  } else if (typeof mediaUrl === "string" && mediaUrl.trim() !== "") {
    measured = await probeMedia(mediaUrl.trim(), PROBE_TIMEOUT_MS);
  } else {
    return errorResponse(
      400,
      "缺少量测输入：请给 probe（呼叫方自己的 ffprobe 结果）或 media_url 其中之一。",
      "invalid_request_error",
      "missing_measurement_input",
      traceId,
    );
  }

  const verdict: QualityVerdict = evaluateMediaQuality(measured, policy);
  return withTraceId(NextResponse.json(verdict), traceId);
}
