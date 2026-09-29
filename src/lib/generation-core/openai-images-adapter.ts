import { aspectRatioFromImageSize } from "@/lib/generation-model-catalog";
import { resolveAdobe2ApiImageModelId, resolveAdobe2ApiVideoModelId } from "@/lib/generation-core/adobe2api-upstream";
import { SupplierRequestError } from "./failure-classifier";
import type { SupplierGenerationInput, SupplierGenerationOutput, SupplierRecord } from "./types";

// OpenAI 相容同步供給（openai_images / adobe2api 兩個協議共用）。
// 本檔是 supplier-adapter.ts `requestSupplier` 原 openai_images/adobe2api 分支的
// 逐行搬遷（V-06，docs/architecture/planes-violations.md）：請求構造、路徑選擇、
// 成品抽取一行未改；唯一語義差異是 V-04——上游模型別名不再認 supplier 身分
//（原 `supplier.id === "env:sub2api"` 特例），改讀資料 `configuration.modelAliases`。

type ProviderPayload = {
  data?: Array<{ b64_json?: string; url?: string; id?: string }>;
  choices?: Array<{ message?: { content?: string } }>;
  id?: string;
  task_id?: string;
  error?: { message?: string };
};

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function readCredential(supplier: SupplierRecord): string {
  const value = process.env[supplier.account.credentialRef] ?? process.env[supplier.credentialRef] ?? "";
  if (!value.trim()) throw new SupplierRequestError(`Missing configured credential ${supplier.account.credentialRef}.`, 401);
  return value.trim();
}

async function readPayload(response: Response): Promise<ProviderPayload | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as ProviderPayload;
  } catch {
    if (!response.ok) throw new SupplierRequestError(text.slice(0, 1000), response.status, response.headers.get("retry-after"), text.slice(0, 1000));
    return null;
  }
}

function adobeOutputUrl(payload: ProviderPayload | null): string | null {
  const direct = payload?.data?.[0]?.url;
  if (direct?.startsWith("http://") || direct?.startsWith("https://")) return direct;
  const text = payload?.choices?.[0]?.message?.content ?? "";
  return text.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/)?.[1] ?? null;
}

/**
 * 從 /chat/completions 的 message.content 抽出生圖成品。
 *
 * 上游實測事實：gemini 系生圖模型掛在 chat/completions，圖以
 * `![image](data:image/jpeg;base64,...)` 內嵌 content，有時是 http URL 的
 * markdown。先抓 base64 data URL（取第一個），抓不到再抓 http URL；兩種都
 * 抓不到回 { null, null }，由呼叫端報 empty result。
 */
export function chatImageOutput(content: string): { base64: string | null; url: string | null } {
  const base64 = content.match(/data:image\/[a-zA-Z+]+;base64,([A-Za-z0-9+/=]+)/)?.[1] ?? null;
  if (base64) return { base64, url: null };
  const url = content.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/)?.[1] ?? null;
  return { base64: null, url };
}

async function referencesAsFormData(references: SupplierGenerationInput["workflow"]["references"]): Promise<FormData> {
  const body = new FormData();
  for (const reference of references ?? []) {
    const response = await fetch(reference.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new SupplierRequestError(`Failed to download reference image: HTTP ${response.status}.`, response.status, response.headers.get("retry-after"));
    const bytes = await response.arrayBuffer();
    body.append("image", new Blob([bytes], { type: reference.mimeType || response.headers.get("content-type") || "image/png" }), reference.name || "reference-image.png");
  }
  return body;
}

function adobeModel(input: SupplierGenerationInput): string {
  const ratio = (input.ratio ?? aspectRatioFromImageSize(input.size ?? "1024x1024"));
  const resolution = (input.resolution ?? (input.quality === "quality" ? "2k" : "1k")) as "1k" | "2k" | "4k";
  if (input.kind === "video_generate") {
    const duration = Number(input.workflow.durationSeconds ?? 5);
    const result = resolveAdobe2ApiVideoModelId(input.modelId, ratio as never, resolution as never, duration);
    if (!result) throw new SupplierRequestError(`Capability contract rejects Adobe video variant ${input.modelId} ${ratio} ${resolution}.`, 400);
    return result;
  }
  const result = resolveAdobe2ApiImageModelId(input.modelId, ratio as never, resolution as never);
  if (!result) throw new SupplierRequestError(`Capability contract rejects Adobe image variant ${input.modelId} ${ratio} ${resolution}.`, 400);
  return result;
}

/**
 * 上游模型名解析（V-04）：`supplierModelId ?? configuration.modelAliases[modelId] ?? modelId`。
 *
 * 別名是**供給資料**（seed 寫進 supplier.configuration_json），不是分派邏輯。
 * 歷史來源：sub2api 的 images endpoint 只認它自己字典裡的上游模型名，平台 id
 * 「gemini-3-image」直傳被拒 `images endpoint requires an image model`
 *（generation_attempt 2026-08-23~27 多筆 400），sub2api 的命名是「gemini-3-pro-image」
 * ——該映射現由 tools/seed-generation-suppliers.ts 的 CHANNEL_MODEL_ALIASES seed 進 sub2api。
 */
export function aliasedSupplierModel(supplier: SupplierRecord, modelId: string): string {
  if (supplier.supplierModelId) return supplier.supplierModelId;
  const aliases = supplier.configuration?.modelAliases;
  if (aliases && typeof aliases === "object" && !Array.isArray(aliases)) {
    const alias = (aliases as Record<string, unknown>)[modelId];
    if (typeof alias === "string" && alias.trim()) return alias;
  }
  return modelId;
}

/** openai_images / adobe2api 同步提交（原 requestSupplier 通用段，逐行搬遷）。 */
export async function requestOpenAiCompatibleSupplier(supplier: SupplierRecord, input: SupplierGenerationInput): Promise<SupplierGenerationOutput> {
  const upstreamModel = supplier.supplierModelId
    ?? (supplier.adapterType === "adobe2api" ? adobeModel(input) : aliasedSupplierModel(supplier, input.modelId));
  const references = input.workflow.references ?? [];
  const headers: Record<string, string> = {
    Authorization: `Bearer ${readCredential(supplier)}`,
  };
  // rc.21 原生視頻路由是 /v1/video/generations（無 "s" 目錄層）；/videos/generations 實測 404。
  let path = input.kind === "video_generate" ? "/video/generations" : "/images/generations";
  let body: BodyInit;
  // registry 渠道的 chat 生圖路由：chatImageModels 裡的上游模型只掛在
  // /chat/completions（gemini 系實測），對照 adobe2api chat 分支的形狀。
  const chatImageModels = Array.isArray(supplier.configuration?.chatImageModels)
    ? (supplier.configuration.chatImageModels as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const viaChatImage = chatImageModels.includes(upstreamModel) && input.kind !== "video_generate";

  if (viaChatImage) {
    path = "/chat/completions";
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      model: upstreamModel,
      messages: [{
        role: "user",
        content: references.length
          ? [
              { type: "text", text: input.prompt },
              ...references.map((reference) => ({ type: "image_url", image_url: { url: reference.url } })),
            ]
          : input.prompt,
      }],
    });
  } else if (supplier.adapterType === "adobe2api" && (references.length || input.kind === "video_generate")) {
    path = "/chat/completions";
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      model: upstreamModel,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: input.prompt },
          ...references.map((reference) => ({ type: "image_url", image_url: { url: reference.url } })),
        ],
      }],
      ...(input.kind === "video_generate" ? { generate_audio: input.workflow.generateAudio === true } : {}),
    });
  } else if (supplier.adapterType === "openai_images" && references.length && input.kind !== "video_generate") {
    path = "/images/edits";
    const form = await referencesAsFormData(references);
    form.append("model", upstreamModel);
    form.append("prompt", input.prompt);
    if (input.size) form.append("size", input.size);
    if (!supplier.configuration?.omitQualityBody) {
      form.append("quality", input.quality === "quality" ? "high" : "medium");
    }
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    const size = input.size ?? "1024x1024";
    const upstreamBody: Record<string, unknown> = {
      model: upstreamModel,
      prompt: input.prompt,
      n: 1,
      size,
      // agnes 類上游的 text image queue 拒收 quality（2026-09-19 實錘），渠道級開關跳過。
      ...(supplier.configuration?.omitQualityBody ? {} : { quality: input.quality === "quality" ? "high" : "medium" }),
    };
    // ControlNet 透傳線路：workflow.metadata.controlNets 是已歸一成 pixai 形狀的
    // entries（見 pixai-controlnets.ts）。只鬆散讀 metadata —— 構造來源是上游
    // 請求路由，任何其他 job 若塞了非法 metadata 會在這裡被當作普通欄位忽略。
    const metadataControlNets = input.workflow.metadata?.controlNets;
    if (Array.isArray(metadataControlNets) && metadataControlNets.length > 0) {
      upstreamBody.controlNets = metadataControlNets;
    }
    body = JSON.stringify(upstreamBody);
  }

  let response: Response;
  try {
    response = await fetch(`${cleanBaseUrl(supplier.baseUrl)}${path}`, {
      method: "POST",
      headers,
      body,
      // 影片生成實測遠長於圖片（kling 8s 片 2-6 分鐘）；單一 100s 預設會讓影片永遠超時。
      // 圖片 180s（2026-08-27 實測：hub.linux.do gpt-image-2 59s、gemini-3.1-flash-image
      // chat 生圖 73s，100s 預設把這兩條路全部掐死在「Supplier request timed out」）。
      signal: AbortSignal.timeout(Number(process.env.GENERATION_SUPPLIER_TIMEOUT_MS ?? (input.kind === "video_generate" ? 600_000 : 180_000))),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new SupplierRequestError("Supplier request timed out.", 408);
    throw error;
  }
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new SupplierRequestError(
      payload?.error?.message ?? `Supplier request failed: HTTP ${response.status}.`,
      response.status,
      response.headers.get("retry-after"),
    );
  }
  // 202 Accepted 不是成功：任务已收、成品未回。worker 不做轮询，202 一律记失败
  // （providerHttpStatus=202），调度器会换下一个 supplier 重试。
  if (response.status === 202) {
    throw new SupplierRequestError(
      `Supplier ${supplier.label} returned HTTP 202 (accepted) without an image; the worker does not poll tasks.`,
      202,
    );
  }
  const first = payload?.data?.[0];
  if (viaChatImage) {
    // chat 生圖：成品內嵌在 message.content，data URL 優先、http URL 次之。
    // content 形狀跨上游渠道不穩定（字串 markdown / OpenAI 多模態 parts 陣列），
    // 非字串先 JSON 化再抽；抽不到時把預覽帶進錯誤訊息，排障不用盲猜。
    const rawContent = payload?.choices?.[0]?.message?.content;
    const contentText = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? "");
    const chatImage = chatImageOutput(contentText);
    if (!chatImage.base64 && !chatImage.url) {
      throw new SupplierRequestError(`Supplier chat image result was empty. Content preview: ${contentText.slice(0, 200)}`, response.status);
    }
    return {
      base64: chatImage.base64,
      url: chatImage.url,
      providerRequestId: payload?.id,
      providerTaskId: payload?.task_id,
      httpStatus: response.status,
      endpointLabel: supplier.label,
      supplierModelId: upstreamModel,
      evidence: { adapter: supplier.adapterType, supplierId: supplier.id, failureDomain: supplier.failureDomain },
    };
  }
  const url = supplier.adapterType === "adobe2api" ? adobeOutputUrl(payload) : first?.url ?? null;
  if (!first?.b64_json && !url) throw new SupplierRequestError("Supplier result was empty.", response.status);
  return {
    base64: first?.b64_json ?? null,
    url,
    providerRequestId: payload?.id ?? first?.id,
    providerTaskId: payload?.task_id,
    httpStatus: response.status,
    endpointLabel: supplier.label,
    supplierModelId: upstreamModel,
    evidence: { adapter: supplier.adapterType, supplierId: supplier.id, failureDomain: supplier.failureDomain },
  };
}

