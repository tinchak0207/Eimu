// POST /v1/skus/:id/runs — SKU 下单：输入 → 镜头计划展开 → 逐镜头提交。
//
// 与 /v1/images/generations 完全同构的 B 端契约：biz key 鉴权、限流头、
// trace_id、OpenAI 风格错误体、幂等（Idempotency-Key 头 = run 根，
// 逐镜头确定性幂等键）。提交全部走 submitGenerationCommand——不自建第二套
// 提交/计费/调度。
//
// body 两种形态：
//  1. 单轮：SKU 输入物件（顶层可带保留栏位 model / callback_url）。
//  2. 表格批量：{ "inputs": [输入物件, ...] }（或直接顶层数组），每项一轮 run。

import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, isModelAllowedForKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { isSupportedImageModel, resolveGenerationModelId } from "@/lib/generation-model-catalog";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";
import { getSkuById } from "@/lib/sku/catalog";
import { expandSkuShots } from "@/lib/sku/expand";
import {
  MAX_RUNS_PER_REQUEST,
  MAX_SHOTS_PER_RUN,
  buildSkuShotCommandPlans,
  generateRunId,
  normalizeRunId,
  resolveSkuDispatcher,
} from "@/lib/sku/run-service";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { syncModelPricing } from "@/lib/pricing-runtime";

export const runtime = "nodejs";
export const maxDuration = 300;
// 与 /v1/images/generations 同区：逐镜头提交要串行打控制面 DB（建任务+预留计费）。
export const preferredRegion = "sfo1";

type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "insufficient_balance"
  | "api_error";

function errorResponse(
  status: number,
  message: string,
  type: OpenAIErrorType,
  code: string,
  traceId: string,
  headers?: Record<string, string>,
  param: string | null = null,
) {
  const response = NextResponse.json(
    { error: { message, type, code, param, trace_id: traceId } },
    { status, ...(headers ? { headers } : {}) },
  );
  return withTraceId(response, traceId);
}

interface RunItemView {
  shot_index: number;
  shot_id: string;
  kind: "image" | "video";
  task_id: string;
  task_url: string;
  accepted: true;
  prompt: string;
}

interface RunFailedItemView {
  shot_index: number | null;
  error: { message: string; type: string; code: string; param: null };
}

interface RunResponse {
  object: "sku.run";
  run_id: string;
  sku_id: string;
  model: string;
  created: number;
  idempotent_replay: boolean;
  items: RunItemView[];
  failed_items: RunFailedItemView[];
  estimated_coins: number;
  run_url: string;
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestId = Math.random().toString(36).slice(2);
  const traceId = getOrCreateTraceId(req);

  // ── 认证（与单任务端点同一套） ─────────────────────────────
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
  const apiKey = auth.key;

  // ── SKU 解析 ───────────────────────────────────────────────
  const { id } = await context.params;
  const sku = getSkuById(id);
  if (!sku) {
    return errorResponse(404, "SKU 不存在，请调用 GET /v1/skus 查看目录。", "invalid_request_error", "sku_not_found", traceId);
  }

  // ── 请求体解析（单轮 / 表格批量） ──────────────────────────
  let body: Record<string, unknown> | unknown[];
  try {
    body = (await req.json()) as Record<string, unknown> | unknown[];
  } catch {
    return errorResponse(400, "请求体不是合法的 JSON。", "invalid_request_error", "invalid_json", traceId);
  }

  let inputs: unknown[];
  if (Array.isArray(body)) {
    inputs = body;
  } else if (Array.isArray((body as Record<string, unknown>).inputs)) {
    inputs = (body as Record<string, unknown>).inputs as unknown[];
  } else {
    inputs = [body];
  }

  if (inputs.length === 0) {
    return errorResponse(400, "inputs 不能为空。", "invalid_request_error", "empty_inputs", traceId);
  }
  if (inputs.length > MAX_RUNS_PER_REQUEST) {
    return errorResponse(
      400,
      "单次请求最多 " + MAX_RUNS_PER_REQUEST + " 轮 run，当前 " + inputs.length + " 轮；请拆分提交。",
      "invalid_request_error",
      "too_many_inputs",
      traceId,
    );
  }

  // 保留栏位（信封层）：model 覆盖 / callback_url 透传。
  const envelope: Record<string, unknown> = Array.isArray(body) ? {} : (body as Record<string, unknown>);
  const rawModelOverride = typeof envelope.model === "string" && envelope.model ? envelope.model : "";
  const callbackUrl =
    typeof envelope.callback_url === "string" && envelope.callback_url.trim()
      ? envelope.callback_url.trim()
      : null;

  // ── 模型解析（覆盖或缺省） ─────────────────────────────────
  const rawModelId = rawModelOverride || sku.defaultModelId;
  const modelId = (resolveGenerationModelId(rawModelId) ?? rawModelId).trim();
  // v1 SKU 全部 image kind；video SKU 落地时按 shot.kind 分派校验。
  if (!isSupportedImageModel(modelId)) {
    return errorResponse(
      400,
      "不支持的模型 " + modelId + "。可用模型请调用 GET /v1/models。",
      "invalid_request_error",
      "model_not_found",
      traceId,
    );
  }
  if (!isModelAllowedForKey(apiKey, modelId)) {
    return errorResponse(403, "当前密钥无权调用模型 " + modelId + "。", "permission_error", "model_not_permitted", traceId);
  }

  // 管理员改价需立即对扣费生效：与单任务端点同一个计费共同上游。
  await syncModelPricing();

  if (!generationControlPlaneEnabled()) {
    return errorResponse(
      503,
      "SKU runs only support the durable control plane, which is currently unavailable.",
      "api_error",
      "control_plane_unavailable",
      traceId,
    );
  }

  // ── run_id（幂等根） ───────────────────────────────────────
  const headerRun = req.headers.get("idempotency-key");
  let baseRunId: string;
  if (headerRun !== null && headerRun !== "") {
    const normalized = normalizeRunId(headerRun);
    if (!normalized.ok) {
      return errorResponse(400, normalized.message, "invalid_request_error", "invalid_run_id", traceId);
    }
    baseRunId = normalized.runId;
  } else {
    baseRunId = generateRunId();
  }

  // ── 逐轮展开 + 发射 ────────────────────────────────────────
  const dispatcher = resolveSkuDispatcher();
  const tenantId = "biz:" + apiKey.id;
  const dispatchContext = { tenantId, apiKeyId: apiKey.id, billingUserId: apiKey.userId };

  const runResponses: RunResponse[] = [];
  const failedInputs: Array<{ index: number; error: { message: string; type: string; code: string; param: string | null } }> = [];

  for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
    const runId = inputs.length === 1 ? baseRunId : baseRunId + "-" + inputIndex;
    const expansion = expandSkuShots(sku, inputs[inputIndex]);
    if (!expansion.ok) {
      const first = expansion.issues[0];
      failedInputs.push({
        index: inputIndex,
        error: {
          message: expansion.issues.map((item) => item.message).join("；"),
          type: "invalid_request_error",
          code: first?.code ?? "invalid_input",
          param: first?.param ?? null,
        },
      });
      continue;
    }
    if (expansion.shots.length > MAX_SHOTS_PER_RUN) {
      failedInputs.push({
        index: inputIndex,
        error: {
          message: "单轮 run 镜头数不能超过 " + MAX_SHOTS_PER_RUN + "。",
          type: "invalid_request_error",
          code: "too_many_shots",
          param: null,
        },
      });
      continue;
    }

    const extraMetadata =
      typeof (inputs[inputIndex] as Record<string, unknown> | null)?.product_image_url === "string"
        ? { productImageUrl: (inputs[inputIndex] as Record<string, unknown>).product_image_url }
        : undefined;

    const plans = buildSkuShotCommandPlans(sku, expansion.shots, {
      runId,
      modelId,
      callbackUrl,
      ...(extraMetadata ? { extraMetadata } : {}),
    });
    const outcomes = await dispatcher.submitAll(plans, dispatchContext);

    const items: RunItemView[] = [];
    const failedItems: RunFailedItemView[] = [];
    for (let i = 0; i < expansion.shots.length; i += 1) {
      const shot = expansion.shots[i];
      const outcome = outcomes.find((candidate) => candidate.shotIndex === shot.index);
      if (outcome && outcome.accepted && outcome.taskId) {
        items.push({
          shot_index: shot.index,
          shot_id: shot.shotId,
          kind: shot.kind,
          task_id: outcome.taskId,
          task_url: "/v1/images/" + outcome.taskId,
          accepted: true,
          prompt: shot.prompt,
        });
      } else if (outcome && outcome.error) {
        failedItems.push({ shot_index: shot.index, error: { ...outcome.error, param: null } });
      } else {
        failedItems.push({
          shot_index: shot.index,
          error: { message: "镜头提交结果缺失。", type: "api_error", code: "submission_failed", param: null },
        });
      }
    }

    const estimatedCoins = plans.reduce((sum, plan) => sum + plan.billingAmount, 0) / QUOTA_PER_COIN;
    const replayed = outcomes.length > 0 && outcomes.every((outcome) => outcome.replayed === true);

    runResponses.push({
      object: "sku.run",
      run_id: runId,
      sku_id: sku.id,
      model: modelId,
      created: Math.floor(Date.now() / 1000),
      idempotent_replay: replayed,
      items,
      failed_items: failedItems,
      estimated_coins: Math.round(estimatedCoins * 100) / 100,
      run_url: "/v1/skus/runs/" + runId,
    });
  }

  console.log(
    "[sku-run] requestId=" + requestId + ", keyId=" + apiKey.id + ", sku=" + sku.id + ", inputs=" + inputs.length +
      ", runs=" + runResponses.length + ", failedInputs=" + failedInputs.length + ", dispatcher=loop",
  );

  const multi = inputs.length > 1;
  const payload = multi
    ? {
        object: "sku.run.set",
        sku_id: sku.id,
        model: modelId,
        run_count: runResponses.length,
        runs: runResponses,
        failed_inputs: failedInputs,
      }
    : runResponses[0] ?? {
        object: "sku.run",
        run_id: baseRunId,
        sku_id: sku.id,
        model: modelId,
        created: Math.floor(Date.now() / 1000),
        idempotent_replay: false,
        items: [],
        failed_items: [],
        estimated_coins: 0,
        run_url: "/v1/skus/runs/" + baseRunId,
      };

  // 单轮输入且验证失败：直接 400（客户端错误应立即修正，不是异步失败）。
  if (!multi && runResponses.length === 0 && failedInputs.length > 0) {
    const failure = failedInputs[0];
    return errorResponse(
      400,
      failure.error.message,
      "invalid_request_error",
      failure.error.code,
      traceId,
      undefined,
      failure.error.param,
    );
  }

  const headers: Record<string, string> = {};
  if (!multi) headers.Location = "/v1/skus/runs/" + baseRunId;
  const response = NextResponse.json(payload, { status: 202, headers });
  return withTraceId(addRateLimitHeaders(response, apiKey), traceId);
}

/** 明确拒绝其他方法。 */
export function GET(req: NextRequest) {
  return errorResponse(
    405,
    "该端点只接受 POST。SKU 目录请调用 GET /v1/skus，run 状态请调用 GET /v1/skus/runs/{run_id}。",
    "invalid_request_error",
    "method_not_allowed",
    getOrCreateTraceId(req),
  );
}
