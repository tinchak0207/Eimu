// POST /openai/v1/images/generations — **同步** OpenAI Images API 兼容面。
//
// 為什麼要有這一層：站內 `/v1/images/generations` 在 production 一律回 202 + task_id
// （durable control plane 語義，見 S2 核對報告），而中轉站（new-api/one-api）、
// Cherry Studio、SillyTavern、官方 SDK 這些分發管道全部只認「一次 POST 同步拿 data[]」。
// 這一層把既有 durable 管線包成同步形狀：提交 → 服務端輪詢 → 200 {created, data[]}。
//
// 與 `/v1/*` 的關係：契約一行不動（contract-lock 測試未改），biz key 兩邊通用；本路由
// 不直連資料庫，提交/輪詢都走被 beforeFiles 代理的 HTTP 入口（見 lib/openai-compat/generation.ts）。
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isModelAllowedForKey } from "@/lib/biz-api-keys";
import {
  guardBizApiKey,
  openAICompatError,
  openAIError,
} from "@/lib/openai-compat/errors";
import {
  artifactToBase64,
  awaitImageTask,
  resolveGenerationOrigin,
  resolveMaxWaitMs,
  submitImageTask,
  taskFailureToError,
  taskTimeoutError,
} from "@/lib/openai-compat/generation";
import { resolveCompatibleImageModelId } from "@/lib/openai-compat/models";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";
// Next.js 只靜態解析字面量：段配置 export 引用識別符會讓整包 build 失敗
// （`Unknown identifier ... at maxDuration`）。值須與 lib/openai-compat/generation.ts 的
// FUNCTION_MAX_DURATION_SECONDS 保持一致。
export const maxDuration = 300;
// 与 /v1/images/generations、/api/generate-images 同区：提交一跳、轮询多跳，
// 每跳 RTT 才是这一层的成本。
export const preferredRegion = "sfo1";

interface ImageRequestBody {
  model?: unknown;
  prompt?: unknown;
  n?: unknown;
  size?: unknown;
  quality?: unknown;
  response_format?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function POST(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const guard = await guardBizApiKey(req, traceId);
  if (!guard.ok) return guard.response;
  const key = guard.key;

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return openAICompatError(400, "invalid_json", "请求体不是合法的 JSON。", traceId);
  }
  const body = (isRecord(parsed) ? parsed : {}) as ImageRequestBody;

  const rawModel = typeof body.model === "string" ? body.model.trim() : "";
  if (!rawModel) {
    return openAICompatError(
      400,
      "missing_model",
      "缺少必填参数 model。可用模型见 GET /openai/v1/models。",
      traceId,
    );
  }
  // 與站內提交入口同一支解析/閘：顯示名風格 id 容忍，非圖像模型或目錄內不存在的模型一律拒。
  const model = resolveCompatibleImageModelId(rawModel);
  if (!model) {
    return openAICompatError(
      400,
      "model_not_supported",
      `不支持的模型 ${rawModel}。可用模型见 GET /openai/v1/models。`,
      traceId,
    );
  }
  if (!isModelAllowedForKey(key, model)) {
    return openAICompatError(403, "model_not_permitted", `当前密钥无权调用模型 ${model}。`, traceId);
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return openAICompatError(400, "missing_prompt", "缺少必填参数 prompt。", traceId);

  // n / size 不做本地白名單：站內入口是唯一真源，重寫一份只會漂移。
  // 傳什麼就送什麼，上游的 invalid_n / unsupported_size 原樣透傳（含可選值清單）。
  const n = body.n === undefined || body.n === null ? 1 : Number(body.n);
  const size = typeof body.size === "string" && body.size ? body.size : "1024x1024";
  const quality = typeof body.quality === "string" && body.quality ? body.quality : undefined;
  // OpenAI 語義：預設 url；只有明確要 b64_json 才由本層取件編碼。
  const responseFormat = body.response_format === "b64_json" ? "b64_json" : "url";

  const authorization = req.headers.get("authorization");
  const origin = resolveGenerationOrigin(req.url);
  const deadlineAt = Date.now() + resolveMaxWaitMs();

  const submitted = await submitImageTask({
    origin,
    authorization,
    model,
    prompt,
    n,
    size,
    ...(quality ? { quality } : {}),
    idempotencyKey: req.headers.get("idempotency-key") ?? `openai-${randomUUID()}`,
    ...(req.signal ? { signal: req.signal } : {}),
  });
  if (!submitted.ok) return openAIError(submitted.error, traceId);

  const polled = await awaitImageTask({ origin, authorization, taskId: submitted.taskId, deadlineAt });
  if (!polled.settled) return openAIError(taskTimeoutError(submitted.taskId), traceId);
  if (polled.outcome.status !== "succeeded") {
    return openAIError(taskFailureToError(polled.outcome, submitted.taskId), traceId);
  }

  const urls = polled.outcome.artifacts
    .map((artifact) => artifact.url)
    .filter((url): url is string => Boolean(url));
  if (urls.length === 0) {
    return openAICompatError(
      502,
      "generation_no_artifact",
      `任务 ${submitted.taskId} 已结束但没有可交付的产物（本次未出图，未扣费）。`,
      traceId,
    );
  }

  let data: Array<{ url: string } | { b64_json: string }>;
  if (responseFormat === "b64_json") {
    try {
      data = await Promise.all(urls.map(async (url) => ({ b64_json: await artifactToBase64(url) })));
    } catch (error) {
      console.error(`[openai-compat] artifact delivery failed task=${submitted.taskId}`, error);
      return openAICompatError(
        502,
        "artifact_delivery_failed",
        `图片取回失败：任务 ${submitted.taskId} 已生成，可在任务历史中查看（本次未交付，按未出图结算）。`,
        traceId,
      );
    }
  } else {
    data = urls.map((url) => ({ url }));
  }

  return withTraceId(
    NextResponse.json(
      { created: Math.floor(Date.now() / 1000), data },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    ),
    traceId,
  );
}
