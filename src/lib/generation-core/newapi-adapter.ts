import { SupplierRequestError } from "./failure-classifier";
import { chatImageOutput } from "./openai-images-adapter";
import type { SupplierGenerationInput, SupplierGenerationOutput, SupplierRecord } from "./types";

/**
 * new-api 换血通道：把已迁移的供应商调度整体交给 new-api（127.0.0.1:3001，
 * OpenAI 兼容）。控制面只负责三阶段计费与任务合同，不再对已迁移模型跑
 * 自研 lease/熔断/健康检查。
 *
 * 上游事实（2026-08-27 实测）：
 * - new-api /v1/images/generations 是同步响应（pixai 9s / gpt-image-2 42s /
 *   firefly 9s），成功 200 直接带 data[0].url 或 b64_json，无 tasks 轮询。
 * - 失败形状 {"error":{"message":...,"code":...}}，与 OpenAI 兼容。
 * - 模型名透传：控制面 public_model_id 即 new-api 侧 models（new-api 内部
 *   用 model_mapping 做上游映射），控制面不做二次映射。
 */

const NEWAPI_TIMEOUT_IMAGE_MS = 180_000;
const NEWAPI_TIMEOUT_VIDEO_MS = 600_000;

function newApiBaseUrl(): string {
  const base = process.env.NEWAPI_BASE_URL?.trim() ?? "";
  if (!base) throw new SupplierRequestError("NEWAPI_BASE_URL is not configured.", 500);
  return base.replace(/\/+$/, "");
}

function newApiKey(): string {
  const key = process.env.NEWAPI_API_KEY?.trim() ?? "";
  if (!key) throw new SupplierRequestError("NEWAPI_API_KEY is not configured.", 500);
  return key;
}

type NewApiPayload = {
  data?: Array<{ b64_json?: string; url?: string; id?: string }>;
  id?: string;
  task_id?: string;
  error?: { message?: string; code?: string | number };
};

export function isNewApiEnabled(): boolean {
  return (process.env.NEWAPI_ENABLED ?? "").trim().toLowerCase() === "true"
    && Boolean(process.env.NEWAPI_BASE_URL?.trim())
    && Boolean(process.env.NEWAPI_API_KEY?.trim());
}

/**
 * 模型是否走 new-api：供应商记录的 base_url 指向 new-api 时（DB 路由表
 * 已把已迁移渠道的 base_url 切到 NEWAPI_BASE_URL），requestSupplier 直接
 * 分流到本模块，不再经过旧 openai_images 请求构造。
 */
export function isNewApiSupplier(supplier: SupplierRecord): boolean {
  return isNewApiEnabled() && supplier.baseUrl.replace(/\/+$/, "") === newApiBaseUrl();
}

export async function generateWithNewApi(supplier: SupplierRecord, input: SupplierGenerationInput): Promise<SupplierGenerationOutput> {
  // new-api 内部已做模型映射（model_mapping），这里直接透传 public model id。
  const model = input.modelId;
  const isVideo = input.kind === "video_generate";

  // gemini 系生图模型在 new-api 上只挂 chat 格式渠道——images 端点会把它
  // 们全滤掉（2026-08-29 实锤：candidate trace api_format 3->0，model not
  // found）。这类模型改走 /chat/completions，图以内嵌 markdown/base64 回来，
  // 解析复用 supplier-adapter 的 chatImageOutput。
  const chatImageModels = Array.isArray(supplier.configuration?.chatImageModels)
    ? (supplier.configuration.chatImageModels as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (!isVideo && chatImageModels.includes(model)) {
    return generateWithNewApiChat(supplier, input, model);
  }

  const references = input.workflow.references ?? [];
  const path = isVideo ? "/video/generations" : references.length ? "/images/edits" : "/images/generations";
  const body: Record<string, unknown> = {
    model,
    prompt: input.prompt,
    n: 1,
    ...(input.size ? { size: input.size } : {}),
    ...(input.quality ? { quality: input.quality === "quality" ? "high" : "medium" } : {}),
  };
  let requestBody: BodyInit = JSON.stringify(body);
  if (!isVideo && references.length) {
    const form = new FormData();
    for (const [key,value] of Object.entries(body)) form.append(key,String(value));
    for (const reference of references) {
      const response = await fetch(reference.url,{signal:AbortSignal.any([...(input.signal ? [input.signal] : []),AbortSignal.timeout(30_000)])});
      if (!response.ok) throw new SupplierRequestError('Reference image download failed before provider submission.',response.status,null,undefined,'artifact_download');
      form.append('image',new Blob([await response.arrayBuffer()],{type:reference.mimeType || 'image/png'}),reference.name || 'reference.png');
    }
    requestBody=form;
  }
  let response: Response;
  await input.onProviderRequestStarted?.();
  input.signal?.throwIfAborted();
  try {
    response = await fetch(`${newApiBaseUrl()}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${newApiKey()}`,
        ...(requestBody instanceof FormData ? {} : { "Content-Type": "application/json" }),
        "Idempotency-Key": input.idempotencyKey ?? input.attemptId,
        "X-Request-ID": input.idempotencyKey ?? input.attemptId,
      },
      body: requestBody,
      signal: AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(isVideo ? NEWAPI_TIMEOUT_VIDEO_MS : NEWAPI_TIMEOUT_IMAGE_MS)]),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new SupplierRequestError("new-api request timed out.", 408);
    throw error;
  }
  const text = await response.text();
  let payload: NewApiPayload | null = null;
  try {
    payload = text ? (JSON.parse(text) as NewApiPayload) : null;
  } catch {
    if (!response.ok) throw new SupplierRequestError(text.slice(0, 1000), response.status, response.headers.get("retry-after"));
  }
  if (!response.ok) {
    throw new SupplierRequestError(
      payload?.error?.message ?? `new-api request failed: HTTP ${response.status}.`,
      response.status,
      response.headers.get("retry-after"),
    );
  }
  if (response.status === 202) {
    const taskId=payload?.task_id ?? payload?.id;
    if (taskId) await input.onProviderTaskSubmitted?.(taskId,isVideo?'newapi_video':'newapi_relay');
    throw new SupplierRequestError('Provider accepted request; original task awaits read-only reconciliation.',408,null,text,'unknown',taskId,202);
  }
  const first = payload?.data?.[0];
  if (!first?.b64_json && !first?.url) {
    throw new SupplierRequestError('new-api result was empty.',response.status,null,text,'empty_result',undefined,response.status);
  }
  return {
    base64: first?.b64_json ?? null,
    url: first?.url ?? null,
    providerRequestId: payload?.id ?? first?.id,
    providerTaskId: undefined,
    httpStatus: response.status,
    endpointLabel: `newapi:${supplier.label}`,
    supplierModelId: model,
    evidence: { adapter: "newapi" as const, supplierId: supplier.id, failureDomain: "newapi" },
  };
}

/** chat 格式生图的 new-api 载荷：content 可能是纯文字，也可能是多模态 parts（2026-08-29 实测：图在 image_url part 的 data URL 里）。 */
type NewApiChatContentPart = { type?: string; text?: string; image_url?: { url?: string } };
type NewApiChatPayload = {
  choices?: Array<{ message?: { content?: string | NewApiChatContentPart[] } }>;
  error?: { message?: string; code?: string | number };
};

async function generateWithNewApiChat(
  supplier: SupplierRecord,
  input: SupplierGenerationInput,
  model: string,
): Promise<SupplierGenerationOutput> {
  const references = (input.workflow.references ?? []).filter((reference) => reference.url.length > 0);
  let response: Response;
  await input.onProviderRequestStarted?.();
  input.signal?.throwIfAborted();
  try {
    response = await fetch(`${newApiBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${newApiKey()}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey ?? input.attemptId,
        "X-Request-ID": input.idempotencyKey ?? input.attemptId,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: references.length
              ? [
                  { type: "text", text: input.prompt },
                  ...references.map((reference) => ({ type: "image_url", image_url: { url: reference.url } })),
                ]
              : input.prompt,
          },
        ],
      }),
      signal: AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(NEWAPI_TIMEOUT_IMAGE_MS)]),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new SupplierRequestError("new-api request timed out.", 408);
    throw error;
  }
  const text = await response.text();
  let payload: NewApiChatPayload | null = null;
  try {
    payload = text ? (JSON.parse(text) as NewApiChatPayload) : null;
  } catch {
    if (!response.ok) throw new SupplierRequestError(text.slice(0, 1000), response.status, response.headers.get("retry-after"));
  }
  if (!response.ok) {
    throw new SupplierRequestError(
      payload?.error?.message ?? `new-api request failed: HTTP ${response.status}.`,
      response.status,
      response.headers.get("retry-after"),
    );
  }
  const rawContent = payload?.choices?.[0]?.message?.content ?? "";
  // 两种返回形状都吃：纯文字（内嵌 markdown/base64）走 chatImageOutput 直解；
  // 多模态 parts 逐个翻——text part 拼回原文、image_url part 直接当成品候选。
  let output: { base64: string | null; url: string | null } = { base64: null, url: null };
  if (Array.isArray(rawContent)) {
    const texts: string[] = [];
    for (const part of rawContent) {
      const candidate = part?.image_url?.url;
      if (typeof candidate === "string" && candidate) {
        const found = chatImageOutput(candidate);
        if (found.base64 || found.url) {
          output = found;
          break;
        }
      } else if (typeof part?.text === "string") {
        texts.push(part.text);
      }
    }
    if (!output.base64 && !output.url) output = chatImageOutput(texts.join("\n"));
  } else {
    output = chatImageOutput(rawContent);
  }
  if (!output.base64 && !output.url) {
    throw new SupplierRequestError('new-api result was empty.',response.status,null,text,'empty_result',undefined,response.status);
  }
  return {
    base64: output.base64,
    url: output.url,
    providerRequestId: undefined,
    providerTaskId: undefined,
    httpStatus: response.status,
    endpointLabel: `newapi:${supplier.label}`,
    supplierModelId: model,
    evidence: { adapter: "newapi" as const, supplierId: supplier.id, failureDomain: "newapi" },
  };
}
