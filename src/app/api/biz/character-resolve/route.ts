// POST /api/biz/character-resolve — 把 prompt 里的行内实体 tag `@[种类:名称]` 就地展开，
// 并把命中的卡的参考图併进参考图清单，回传「已解析」结果给调用端（agent 工具层会把结果
// 转投给控制面的生图端点）。
//
// 为什么是 `/api/biz/*`：生产 next.config.mjs 的 beforeFiles 改写把 `/v1/:path*` 与
// `/api/v1/:path*` 整体代理到控制面 origin（VPS 容器那棵树没有卡模型档），`/api/biz/*`
// 不在清单里 ⇒ 挂在这里才是 Vercel 全功能应用在服务。
//
// 解析逻辑**不在这里**：整段复用 src/lib/biz-image-references.ts 的 `planBizGenerationInput`
// ——与 `/v1/images/generations` 同一把尺（未命中 fail-open、卡库读取失败降级、上限 5 张截尾、
// data:image 落地 Blob 换公网 URL）。本档只做三件事：认证、形状校验、把 plan 的
// `references: GenerationReference[]` **最小投影**成契约要的 `reference_images: string[]`
// （公网 URL）。不改 plan 的语义、不重写解析、不自己写 regex。
import { NextRequest, NextResponse } from "next/server";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { bizErrorResponse, guardBizApiKey } from "@/lib/biz-openai-error";
import { listCharacterCards } from "@/lib/character-card-store";
import {
  EditInputError,
  parseBizGenerationTarget,
  planBizGenerationInput,
  type BizGenerationInputPlan,
  type BizGenerationTarget,
} from "@/lib/biz-image-references";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Blob 落地用的幂等键：**刻意不是随机值**。
 * `resolveEditReference` 的物件键 = sha256(tenantId | idempotencyKey | 图片内容 sha256)，
 * 键里已含内容指纹 ⇒ 固定 idempotencyKey 让「同一张 data:image 反复 resolve」命中同一个
 * 物件（allowOverwrite，幂等），而不是每次调用都往 Blob 灌一份新副本。
 */
const RESOLVE_IDEMPOTENCY_KEY = "biz-resolve";

interface ResolveRequestBody {
  prompt?: unknown;
  /** `Array<string | { url, role?, name? }>`；形状校验在 plan 内（任何 I/O 之前）。 */
  reference_images?: unknown;
  /** 生成链路：`"image"`（缺省）/ `"audio"`；值域外 400 `invalid_target`（形状校验在 plan 前）。 */
  target?: unknown;
}

/**
 * POST /api/biz/character-resolve
 *
 * body：`{ prompt: string, reference_images?: Array<string | {url, role?, name?}>, target?: "image" | "audio" }`
 * 回：`{ prompt: string, reference_images: string[], warnings: string[] }`
 *   - `prompt` ＝ 展开后的正文（token 命中者就地换成卡的 prompt 片段，片段空 → 换卡名；
 *     未命中者**原样保留**；零 token 时与输入逐位元相同）。
 *   - `target` ＝ 生成链路。缺省／`"image"`＝既有视觉行为（**逐位元不變**）；
 *     `"audio"`＝只有音频卡参与（`applyCharacterCards(..., { target: "audio" })`），
 *     未引用的锁定音频卡照常进前缀，**`reference_images` 一律空数组**（音频链路没有参考图语义），
 *     显式传的 `reference_images` 被忽略并出一條 warning。值域外 → 400 `invalid_target`
 *     （**不默默收敛成默认**：把 `"Audio"` 静默当视觉会静默丢掉音频卡）。
 *   - `reference_images` ＝ **已可直送上游的公网 URL**，顺序＝命中卡的图在前、调用端显式带的
 *     图在后，按 url 去重，总数上限 5。`data:image` 必须先落地 Blob 换成公网 URL——
 *     对象存储不可用时**明确失败（502）**，绝不把 `data:` URI 原样回给调用端冒充公网 URL。
 *   - `warnings` ＝ 未命中 token 原文、卡库读取失败、截尾等说明（**不准静默**）。
 *
 * 卡库读取失败 → 不 5xx：回原 prompt + warning（fail-open，生成是主线）。
 * 形状非法 → 400（沿用 `EditInputError` 的码与 status）。
 */
export async function POST(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const auth = await guardBizApiKey(req, traceId);
  if (!auth.ok) return auth.response;

  let body: ResolveRequestBody;
  try {
    body = (await req.json()) as ResolveRequestBody;
  } catch {
    return bizErrorResponse(400, "请求体不是合法的 JSON。", "invalid_request_error", "invalid_json", traceId);
  }

  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return bizErrorResponse(400, "缺少必填参数 prompt。", "invalid_request_error", "missing_prompt", traceId);
  }

  // 生成链路形状校验（任何 I/O 之前）：缺省/null → "image"（＝既有行为，逐位元不變）。
  let target: BizGenerationTarget;
  try {
    target = parseBizGenerationTarget(body?.target);
  } catch (error) {
    if (error instanceof EditInputError) {
      return bizErrorResponse(error.status, error.message, "invalid_request_error", error.code, traceId);
    }
    throw error;
  }

  let plan: BizGenerationInputPlan;
  try {
    plan = await planBizGenerationInput({
      prompt,
      rawReferenceImages: body.reference_images,
      target,
      // 只有 prompt 真的带 token 时才会被调用（零 token 请求不读卡库、不加延迟）。
      loadCards: () => listCharacterCards(auth.key.userId),
      tenantId: `biz:${auth.key.id}`,
      idempotencyKey: RESOLVE_IDEMPOTENCY_KEY,
    });
  } catch (error) {
    if (error instanceof EditInputError) {
      return bizErrorResponse(error.status, error.message, "invalid_request_error", error.code, traceId);
    }
    // 非形状错误只可能来自 data:image 的 Blob 落地（plan 已把卡库读失败吞成 warning）。
    // 参考图是调用端明确要求的输入，落地失败就诚实失败 —— 不静默丢图、不拿 data: URI 充数。
    console.error("[biz-character-resolve] 参考图落地失败:", error);
    return bizErrorResponse(
      502,
      "参考图落地到对象存储失败（data:image 需要 Blob 后端）。请改传公网 URL 或稍后再试。",
      "api_error",
      "reference_upload_failed",
      traceId,
    );
  }

  return withTraceId(
    NextResponse.json(
      {
        prompt: plan.prompt,
        // 最小投影：契约只回公网 URL 字符串，不回内部 GenerationReference 结构。
        reference_images: plan.references.map((reference) => reference.url),
        warnings: plan.warnings,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    ),
    traceId,
  );
}

/** 明确拒绝其他方法，避免 agent 工具探测时收到 405 之外的怪结果。 */
export function GET(req: NextRequest) {
  return bizErrorResponse(
    405,
    "该端点只接受 POST。",
    "invalid_request_error",
    "method_not_allowed",
    getOrCreateTraceId(req),
  );
}
