import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { generationDatabaseConfigured } from "@/lib/generation-core/database";
import { INSUFFICIENT_BALANCE_ERROR } from "@/lib/generation-core/quota-precheck";
import { musicChargeId, musicChargeSql, runMusicChargeWithSql } from "@/lib/music-charge";
import { musicCoinsPerGeneration, musicQuotaPerGeneration } from "@/lib/music-pricing";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// 上游（VPS：new-api／控制面 Postgres）都在矽谷，同区省一趟横跨美国（同 tts 路由）。
export const preferredRegion = "sfo1";

/** ref 长度上限（客户端每次生成尝试的稳定 ref；只作判重身份，不需要长）。 */
const MAX_REF_LENGTH = 200;

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

/**
 * POST /v1/music/charges —— 音乐生成按次扣费（biz key 鉴权）。
 *
 * 音乐走 harness 的 `music_gen`（FlowMusic2API / Lyria / YuE2），**从不经过平台的
 * 生成管线**，所以平台侧原本没有任何扣费点（记忆 2026-10-10-music-has-no-price-authority）。
 * 本端点补上这个扣费点：harness 每次生成尝试带一个稳定 `ref` 调用一次，平台对该
 * key 绑定的 new-api user 扣 **1 币/次**（金额唯一来源＝src/lib/music-pricing.ts）。
 *
 * 契约：
 *   · 请求体**只接受 `{ ref: string }`** —— 出现任何其他栏位（尤其金额/单价：
 *     cost_coins / amount / quota / coins / price / n …）一律 400，不静默忽略。
 *     理由：本端点的钱由服务端定价，客户端能塞金额＝客户端能改价；静默忽略会让
 *     「客户端以为设了价」的整合 bug 藏在暗处。
 *   · 幂等：同一 key 同一 `ref` 第二次调用不再扣，回 `{ ok:true, deduped:true, cost_coins:1 }`。
 *   · 余额不足 → 402（与图片生图同一 402 契约码 insufficient_balance）。
 *   · 上游/网关错误按既有错误类型映射状态码（回滚净零 409、上游拒绝 上游码 ?? 502）。
 *   · 审计：扣费落 `account_ledger` consumption 行（append-only；见 lib/music-charge.ts），
 *     占位状态落 `music_charge` 表（幂等键）。
 */
export async function POST(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);

  // ── 认证（照抄图片/tts 路由：只看 Authorization: Bearer sk-biz-…）──────────
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) {
    const type: "rate_limit_error" | "permission_error" | "authentication_error" =
      auth.status === 429 ? "rate_limit_error" : auth.status === 403 ? "permission_error" : "authentication_error";
    return errorResponse(auth.status, auth.message, type, auth.code, traceId);
  }
  const apiKey = auth.key;

  // ── 解析请求（严格白名单：只有 ref）────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return errorResponse(400, "请求体必须是 JSON 对象。", "invalid_request_error", "invalid_json", traceId);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return errorResponse(400, "请求体不是合法的 JSON。", "invalid_request_error", "invalid_json", traceId);
  }

  const extraKeys = Object.keys(body).filter((key) => key !== "ref");
  if (extraKeys.length > 0) {
    // 金额/单价字段绝不接受（客户端无权改价）；其余未知栏位一并拒，契约只有 { ref }。
    return errorResponse(
      400,
      `请求体只接受 { ref }；不接受的栏位：${extraKeys.join("、")}（金额由服务端定价，不得由调用方传入）。`,
      "invalid_request_error",
      "unexpected_field",
      traceId,
      apiKey,
    );
  }

  const ref = typeof body.ref === "string" ? body.ref.trim() : "";
  if (!ref) {
    return errorResponse(400, "缺少必填参数 ref（本次生成尝试的稳定标识）。", "invalid_request_error", "missing_ref", traceId, apiKey);
  }
  if (ref.length > MAX_REF_LENGTH) {
    return errorResponse(400, `ref 长度不能超过 ${MAX_REF_LENGTH} 个字符。`, "invalid_request_error", "ref_too_long", traceId, apiKey);
  }

  // ── 控制面帐本不可用 → 不扣费、如实 503（绝不静默放行一笔没记帐的扣费）──────
  if (!generationDatabaseConfigured()) {
    return errorResponse(
      503,
      "Generation control plane is temporarily unavailable.",
      "api_error",
      "control_plane_unavailable",
      traceId,
      apiKey,
    );
  }

  // ── 服务端定价（金额唯一真源；调用方零输入）────────────────────────────
  const costCoins = musicCoinsPerGeneration();
  const quota = musicQuotaPerGeneration();

  let result;
  try {
    result = await runMusicChargeWithSql(musicChargeSql(), {
      chargeId: musicChargeId(apiKey.id, ref),
      billingUserId: apiKey.userId,
      amountQuota: quota,
      sourceRef: `music:${apiKey.id}:${ref}`,
    });
  } catch (error) {
    // getGenerationSql() 抛错（未配置连线）等：控制面不可用，不得当成功。
    console.error(`[v1/music/charges] charge failed keyId=${apiKey.id}:`, error);
    return errorResponse(
      503,
      "Generation control plane is temporarily unavailable.",
      "api_error",
      "control_plane_unavailable",
      traceId,
      apiKey,
    );
  }

  switch (result.outcome) {
    case "charged":
      return withTraceId(
        addRateLimitHeaders(NextResponse.json({ ok: true, cost_coins: costCoins }), apiKey, { consumed: true }),
        traceId,
      );
    case "already_charged":
      // 幂等命中：同 ref 第二次调用不再扣。
      return withTraceId(
        addRateLimitHeaders(
          NextResponse.json({ ok: true, deduped: true, cost_coins: costCoins }),
          apiKey,
          { consumed: false },
        ),
        traceId,
      );
    case "insufficient":
      return errorResponse(
        INSUFFICIENT_BALANCE_ERROR.status,
        INSUFFICIENT_BALANCE_ERROR.message,
        INSUFFICIENT_BALANCE_ERROR.type,
        INSUFFICIENT_BALANCE_ERROR.code,
        traceId,
        apiKey,
      );
    case "reverted":
      // 上游扣款已回滚、净额为零：与 internal/generation-billing 同码（409），可安全重试同 ref。
      return errorResponse(409, `扣费已回滚（净额为零），可重试。`, "api_error", "charge_reverted", traceId, apiKey);
    case "upstream_error":
      return errorResponse(
        result.upstreamStatus ?? 502,
        `上游扣费失败：${result.message ?? "未知错误"}`,
        "api_error",
        "upstream_failed",
        traceId,
        apiKey,
      );
    case "in_flight":
      // 已占位、结果未定（或并发）：不得重试双扣，交人工核对。
      return errorResponse(
        503,
        `扣费结果未定，请勿重复提交：${result.message ?? ""}`,
        "api_error",
        "charge_in_flight",
        traceId,
        apiKey,
      );
    case "unavailable":
    default:
      return errorResponse(
        503,
        "Generation control plane is temporarily unavailable.",
        "api_error",
        "control_plane_unavailable",
        traceId,
        apiKey,
      );
  }
}

/** 明确拒绝其他方法，避免聚合平台探测时收到 405 之外的怪结果（同图片路由）。 */
export function GET(req: NextRequest) {
  return errorResponse(
    405,
    "该端点只接受 POST。",
    "invalid_request_error",
    "method_not_allowed",
    getOrCreateTraceId(req),
  );
}
