import { NextRequest, NextResponse, after } from "next/server";
import type { GenerateImageRequest } from "@/lib/api-types";
import { MOCK_MODE, mockGenerateImage } from "@/lib/mock";
import { getRuntimeGatewayPools } from "@/lib/admin-pool-store";
// The queue, the breaker and the host formatter all come from the channel registry —
// the same module the /admin routing panel reads. If this route ever builds its queue
// any other way, /admin is lying again; the route tests pin this import.
import {
  buildModelQueue,
  isEndpointCoolingDown,
  prioritizeHealthyEndpoints,
  publicEndpointLabel,
  recordEndpointFailure,
  recordEndpointSuccess,
  safeEndpointHost as safeEndpointName,
} from "@/lib/channel-registry";
import { getRuntimeChannelOverrides } from "@/lib/channel-overrides";
import { recordRoutingEvent, type RoutingAttempt, type RoutingOutcome } from "@/lib/routing-telemetry";
import { publicImageUrl } from "@/lib/image-url";
import {
  canPersistGeneratedImages,
  persistGeneratedImage,
  persistUpstreamImageBytes,
  saveGeneratedHistoryEntry,
} from "@/lib/server-history-store";
import { authenticateImageUser, refundImageQuota, reserveImageQuota } from "@/lib/image-billing";
import {
  WORKFLOW_SCHEMA_VERSION,
  buildWorkflowPrompt,
  normalizeGenerationWorkflowMetadata,
} from "@/lib/generation-workflow";
import { mergeLineageIntoHost, parentsFromReferences } from "@/lib/lineage";
import type { GenerationWorkflowMetadata } from "@/lib/image-types";
import {
  NANO_BANANA_PRO_MODEL_ID,
  imageGenerationCoins,
  isSupportedImageModel,
  resolveUpstreamModelId,
  type ModelMode,
} from "@/lib/provider-config";
import { resolveAdobe2ApiModelId } from "@/lib/generation-core/adobe2api-upstream";
import { sanitizeUpstreamMessage } from "@/lib/upstream-sanitizer";
import { QUOTA_PER_COIN } from "@/lib/new-api-client";
import {
  aspectRatioFromImageSize,
  imageSizeForAspectRatio,
  resolveSupportedAspectRatio,
  resolveSupportedResolution,
  type AspectRatio,
  type OutputResolution,
} from "@/lib/generation-model-catalog";
import { normalizeControlNets, toPixaiControlNets, type PixaiControlNetEntry } from "@/lib/pixai-controlnets";
import { gatesBlock, runPreGenerationGates } from "@/lib/generation-gates";
import { appendGateLog } from "@/lib/generation-gate-log";
import { syncModelPricing } from "@/lib/pricing-runtime";

export const maxDuration = 300;
// Co-located with the Tencent Cloud gateway (na-siliconvalley-2). One generation makes
// 3-4 *sequential* gateway calls (auth, reserve, refund), so the per-hop cost dominates:
// measured ~10ms from sfo1 vs ~70ms from iad1 and ~160ms from hkg1. hkg1 is nearer the
// user but 4x further from the gateway, which made it the slowest of the three.
export const preferredRegion = "sfo1";

/**
 * Ceiling for the whole upstream retry loop, leaving the rest of `maxDuration` to
 * settle billing. Vercel hard-kills the function at `maxDuration`, and a kill skips
 * the refund entirely — previously three 100s attempts summed to exactly 300s, so a
 * run of timeouts charged the user and returned nothing. Per-endpoint timeouts are
 * clamped against what is left of this budget.
 */
const UPSTREAM_BUDGET_MS = 240_000;
/** Below this, starting another attempt just burns the refund window. */
const MIN_ATTEMPT_BUDGET_MS = 15_000;
// Endpoint failure memory (threshold/cooldown) now lives in channel-registry, shared
// with the biz pipeline: a dead endpoint observed by one pipeline cools down for both.

const DEFAULT_IMAGE_SIZE = "1024x1024";
const SUPPORTED_IMAGE_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536"]);
const IMAGE_EDITS_PATH = "/images/edits";
const IMAGE_GENERATIONS_PATH = "/images/generations";

function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{4,}/gi, "[redacted]")
    .replace(/bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/key=[^\s&"'<>]+/gi, "key=[redacted]");
}

function loggedError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(sanitizeUpstreamMessage(raw) ?? raw);
}
const PRIMARY_UPSTREAM_TIMEOUT_MS = 100_000;
const BANANA_UPSTREAM_TIMEOUT_MS = 100_000;
const FALLBACK_UPSTREAM_TIMEOUT_MS = 100_000;

type UpstreamSuccess = {
  created?: number;
  data?: Array<{ b64_json?: string; url?: string }>;
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

type ParsedGenerateImageRequest = Omit<GenerateImageRequest, "controlNets"> & {
  referenceImages: File[];
  /** 已归一成 pixai 形状的 ControlNet entries；无控制网时为 undefined。 */
  controlNets?: PixaiControlNetEntry[];
};

class UpstreamImageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UpstreamImageError";
  }
}

class UnsupportedEndpointInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedEndpointInputError";
  }
}

async function readUpstreamPayload(response: Response): Promise<UpstreamSuccess | null> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as UpstreamSuccess;
  } catch {
    if (!response.ok) {
      throw new UpstreamImageError("Upstream returned an unexpected response.", response.status);
    }
    throw new Error("Upstream returned a non-JSON success payload.");
  }
}

function upstreamTimeoutForEndpoint(endpoint: { label: string; isFallback?: boolean }, modelId: string): number {
  if (endpoint.label === "fallback") return FALLBACK_UPSTREAM_TIMEOUT_MS;
  return endpoint.label.toLowerCase().includes("banana") || modelId === NANO_BANANA_PRO_MODEL_ID
    ? BANANA_UPSTREAM_TIMEOUT_MS
    : PRIMARY_UPSTREAM_TIMEOUT_MS;
}

function endpointFailureReason(error: unknown): string {
  if (error instanceof UpstreamImageError) return `HTTP ${error.status}`;
  if (error instanceof Error && error.message.includes("timed out")) return "timeout";
  return "upstream error";
}

/** Short machine-readable classification for telemetry aggregation. */
function attemptFailureReason(error: unknown): string {
  if (error instanceof UpstreamImageError) return `http-${error.status}`;
  if (error instanceof Error && error.message.includes("timed out")) return "timeout";
  return "upstream-error";
}

/**
 * Aborts on whichever comes first: our own timeout, or the client going away.
 * Without the client's signal a closed tab kept the upstream call (and its billing)
 * running for the full timeout on every remaining endpoint.
 */
function combineAbortSignals(timeoutSignal: AbortSignal, clientSignal?: AbortSignal): AbortSignal {
  if (!clientSignal) return timeoutSignal;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([timeoutSignal, clientSignal]);
  return timeoutSignal;
}

function resolveImageSize(workflow?: GenerationWorkflowMetadata): string {
  return workflow?.imageSize && SUPPORTED_IMAGE_SIZES.has(workflow.imageSize)
    ? workflow.imageSize
    : DEFAULT_IMAGE_SIZE;
}

function readWorkflowMetadata(value: unknown): GenerationWorkflowMetadata | undefined {
  if (!value) return undefined;
  const parsed = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return undefined;
        }
      })()
    : value;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return normalizeGenerationWorkflowMetadata({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    ...(parsed as GenerationWorkflowMetadata),
  });
}

/**
 * 把请求携带的 controlNets（JSON body 物件或 multipart 的 JSON 字串栏位）
 * 清洗并归一成 pixai 形状。非法输入回 undefined —— 呼叫方自行决定回 400。
 */
function readControlNets(value: unknown): PixaiControlNetEntry[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return null;
        }
      })()
    : value;
  if (raw === null || raw === undefined) return undefined;
  const normalized = normalizeControlNets(raw);
  if (normalized.valid.length === 0 || normalized.rejected.length > 0) return undefined;
  return toPixaiControlNets(normalized.valid);
}

async function readGenerateImageRequest(req: NextRequest): Promise<ParsedGenerateImageRequest> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    const body = (await req.json()) as GenerateImageRequest;
    return {
      ...body,
      workflow: readWorkflowMetadata(body.workflow),
      referenceImages: [],
      controlNets: readControlNets(body.controlNets),
    };
  }

  const form = await req.formData();
  const prompt = String(form.get("prompt") ?? "");
  const provider = String(form.get("provider") ?? "") as GenerateImageRequest["provider"];
  const modelId = String(form.get("modelId") ?? "");
  const qualityMode = String(form.get("qualityMode") ?? "fast") as ModelMode;
  const aspectRatio = String(form.get("aspectRatio") ?? "") as GenerateImageRequest["aspectRatio"];
  const outputResolution = String(form.get("outputResolution") ?? "") as GenerateImageRequest["outputResolution"];
  const workflow = readWorkflowMetadata(form.get("workflow"));
  const referenceImages = form
    .getAll("referenceImages")
    .filter((item): item is File => item instanceof File && item.size > 0);
  const loraRaw = String(form.get("loraModelVersionIds") ?? "");
  const loraModelVersionIds = loraRaw
    ? (() => {
        try {
          const parsed = JSON.parse(loraRaw) as unknown;
          return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : undefined;
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const controlNets = readControlNets(form.get("controlNets"));

  return { prompt, provider, modelId, qualityMode, aspectRatio, outputResolution, workflow, referenceImages, loraModelVersionIds, controlNets };
}

function buildUpstreamImageRequestBody(
  prompt: string,
  modelId: string,
  referenceImages: File[],
  imageSize: string,
  qualityMode: ModelMode,
  loraModelVersionIds?: string[],
  controlNets?: PixaiControlNetEntry[],
): { path: string; body: BodyInit; headers: Record<string, string> } {
  const quality = qualityMode === "quality" ? "high" : "medium";
  if (referenceImages.length > 0) {
    const body = new FormData();
    body.append("model", modelId);
    body.append("prompt", prompt);
    body.append("size", imageSize);
    body.append("quality", quality);
    for (const image of referenceImages) {
      body.append("image", image, image.name || "reference-image.png");
    }
    return { path: IMAGE_EDITS_PATH, body, headers: {} };
  }

  return {
    path: IMAGE_GENERATIONS_PATH,
    body: JSON.stringify({
      model: modelId,
      prompt,
      size: imageSize,
      quality,
      ...(loraModelVersionIds?.length ? { loraModelVersionIds } : {}),
      ...(controlNets?.length ? { controlNets } : {}),
    }),
    headers: { "Content-Type": "application/json" },
  };
}

/**
 * PixAI bridge 的 img2img：参考图先 POST /v1/uploads 换 mediaId，再以 JSON
 * {image: mediaId} 打 /v1/images/edits。bridge 的 edits 只吃 JSON——multipart
 * 会直接 400，所以不能走通用的 multipart edits 路径。多张参考图取第一张作
 * 底图（bridge 是单 mediaId 契约）。
 */
async function buildPixaiEditRequestBody(
  endpoint: { baseURL: string; apiKey: string },
  model: string,
  prompt: string,
  referenceImages: File[],
  imageSize: string,
  signal: AbortSignal,
): Promise<{ path: string; body: BodyInit; headers: Record<string, string> }> {
  const image = referenceImages[0];
  const data = Buffer.from(await image.arrayBuffer()).toString("base64");
  const upload = await fetch(`${endpoint.baseURL}/v1/uploads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${endpoint.apiKey}`,
    },
    body: JSON.stringify({ data, mimeType: image.type || "image/png" }),
    cache: "no-store",
    signal,
  });
  const uploadPayload = await upload.json().catch(() => null) as
    | { mediaId?: string; error?: { message?: string } }
    | null;
  if (!upload.ok || !uploadPayload?.mediaId) {
    throw new UpstreamImageError(
      uploadPayload?.error?.message ?? "Failed to upload reference image.",
      upload.status,
    );
  }
  return {
    path: IMAGE_EDITS_PATH,
    body: JSON.stringify({ model, image: uploadPayload.mediaId, prompt, size: imageSize, n: 1 }),
    headers: { "Content-Type": "application/json" },
  };
}

async function buildAdobe2ApiImageRequestBody(
  prompt: string,
  modelId: string,
  referenceImages: File[],
  aspectRatio: AspectRatio,
  outputResolution: OutputResolution,
): Promise<{ path: string; body: BodyInit; headers: Record<string, string>; upstreamModelId: string }> {
  const upstreamModelId = resolveAdobe2ApiModelId(modelId, aspectRatio, outputResolution);
  if (!upstreamModelId) {
    throw new UnsupportedEndpointInputError(`Unsupported Adobe 3P variant: ${modelId} ${outputResolution} ${aspectRatio}.`);
  }

  if (referenceImages.length === 0) {
    return {
      path: IMAGE_GENERATIONS_PATH,
      body: JSON.stringify({ model: upstreamModelId, prompt }),
      headers: { "Content-Type": "application/json" },
      upstreamModelId,
    };
  }

  const content = [
    { type: "text", text: prompt },
    ...await Promise.all(referenceImages.map(async (image) => ({
      type: "image_url",
      image_url: {
        url: `data:${image.type || "image/png"};base64,${Buffer.from(await image.arrayBuffer()).toString("base64")}`,
      },
    }))),
  ];
  return {
    path: "/chat/completions",
    body: JSON.stringify({ model: upstreamModelId, messages: [{ role: "user", content }] }),
    headers: { "Content-Type": "application/json" },
    upstreamModelId,
  };
}

function extractAdobe2ApiImageUrl(payload: UpstreamSuccess | null): string | null {
  const directUrl = publicImageUrl(payload?.data?.[0]?.url);
  if (directUrl) return directUrl;
  const content = payload?.choices?.[0]?.message?.content ?? "";
  const url = content.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/)?.[1];
  return publicImageUrl(url);
}

async function requestImageGeneration(
  endpoint: { apiKey: string; baseURL: string; label: string; modelId?: string; protocol?: "adobe2api" | "pixai" | "filmera"; isFallback?: boolean },
  prompt: string,
  modelId: string,
  referenceImages: File[],
  imageSize: string,
  qualityMode: ModelMode,
  aspectRatio: AspectRatio,
  outputResolution: OutputResolution,
  timeoutMs: number,
  clientSignal?: AbortSignal,
  loraModelVersionIds?: string[],
) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const directRequest = endpoint.protocol === "adobe2api"
    ? await buildAdobe2ApiImageRequestBody(prompt, modelId, referenceImages, aspectRatio, outputResolution)
    : null;
  // pixai-bridge 的 img2img 要 mediaId 而非 multipart——有参考图时先上传换 id。
  // 非 pixai 渠道维持原 multipart edits 契约（sub2api 等 OpenAI 相容吃 multipart）。
  const pixaiRequest = !directRequest && endpoint.protocol === "pixai" && referenceImages.length > 0
    ? await buildPixaiEditRequestBody(
        endpoint,
        resolveUpstreamModelId(modelId, endpoint.modelId),
        prompt,
        referenceImages,
        imageSize,
        controller.signal,
      )
    : null;
  const upstreamModelId = directRequest?.upstreamModelId ?? resolveUpstreamModelId(modelId, endpoint.modelId);
  const upstreamRequest = directRequest ?? pixaiRequest ?? buildUpstreamImageRequestBody(
    prompt,
    upstreamModelId,
    referenceImages,
    imageSize,
    qualityMode,
    loraModelVersionIds,
  );

  try {
    const response = await fetch(`${endpoint.baseURL}${upstreamRequest.path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        ...upstreamRequest.headers,
      },
      body: upstreamRequest.body,
      signal: combineAbortSignals(controller.signal, clientSignal),
    });
    const payload = await readUpstreamPayload(response);

    if (!response.ok) {
      throw new UpstreamImageError(
        payload?.error?.message ?? `Image generation failed on ${endpoint.label} endpoint.`,
        response.status,
      );
    }
    // 202 Accepted 只代表任务已收、成品未回。本管线不做轮询，202 等于没拿到图，
    // 必须记失败让下一个端点接手——否则「卡 202」会被虚假判定为成功。
    if (response.status === 202) {
      throw new UpstreamImageError(
        `Upstream ${endpoint.label} returned HTTP 202 (accepted) without an image; this pipeline does not poll tasks.`,
        202,
      );
    }

    const firstItem = payload?.data?.[0];
    const imageUrl = endpoint.protocol === "adobe2api"
      ? extractAdobe2ApiImageUrl(payload)
      : publicImageUrl(firstItem?.url);
    if (!firstItem?.b64_json && !imageUrl) {
      throw new Error(`No image payload returned from ${endpoint.label} endpoint.`);
    }

    return {
      image: firstItem?.b64_json ?? null,
      imageUrl,
      upstreamModelId,
      upstreamElapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (clientSignal?.aborted) {
        throw new Error(`Image generation cancelled by the client on ${endpoint.label} endpoint.`);
      }
      throw new Error(`Image generation timed out on ${endpoint.label} endpoint after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(req: NextRequest) {
  const requestId = Math.random().toString(36).slice(2);
  const requestStartedAt = Date.now();
  // 非法 JSON／破损 multipart 是客户端输入错误：解析失败回 400，不得落到未捕捉的 500，
  // 也不得把解析器内部细节外泄（红队 2026-10-05 实测 `-d 'not-json'` 原本回 500 空 body）。
  let parsedImageRequest: Awaited<ReturnType<typeof readGenerateImageRequest>>;
  try {
    parsedImageRequest = await readGenerateImageRequest(req);
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const {
    prompt,
    modelId,
    referenceImages,
    workflow,
    qualityMode: requestedQualityMode,
    aspectRatio: requestedAspectRatio,
    outputResolution: requestedOutputResolution,
    loraModelVersionIds,
  } = parsedImageRequest;
  // 请求体校验前移（红队 2026-10-05）：body 可能不是物件、prompt/modelId 可能缺栏或非字串。
  // 必须在任何对 prompt 调 `.trim()`（buildWorkflowPrompt）／算价／建档之前拦住，
  // 否则 `undefined.trim()` 会落到未捕捉的 500 空 body（`{}`／`[]` 实测）。回 400 不含内部细节。
  if (
    typeof prompt !== "string" ||
    !prompt.trim() ||
    typeof modelId !== "string" ||
    !isSupportedImageModel(modelId)
  ) {
    return NextResponse.json({ error: "Invalid request parameters" }, { status: 400 });
  }
  const aspectRatio = resolveSupportedAspectRatio(
    modelId,
    requestedAspectRatio ?? workflow?.aspectRatio ?? aspectRatioFromImageSize(workflow?.imageSize),
  );
  const outputResolution = resolveSupportedResolution(
    modelId,
    requestedOutputResolution ?? workflow?.outputResolution ?? (requestedQualityMode === "quality" ? "2k" : "1k"),
  );
  const qualityMode: ModelMode = outputResolution === "1k" ? "fast" : "quality";
  // 管理员改价需立即对扣费生效：算价前先把最新定价覆写同步进目录（核心层内部吞错，失败不挡生成）。
  await syncModelPricing();
  const requiredCoins = imageGenerationCoins(modelId, qualityMode, outputResolution);
  const generationQuota = requiredCoins * QUOTA_PER_COIN;
  const estimatedCredits = workflow?.estimatedCredits;
  const imageSize = workflow?.imageSize && !requestedAspectRatio
    ? resolveImageSize(workflow)
    : imageSizeForAspectRatio(aspectRatio);
  const finalPrompt = buildWorkflowPrompt(prompt, workflow);

  // Both kicked off before authenticating: neither shares data with auth, and both
  // swallow their own errors (pools -> [], overrides -> last-known-good), so neither can
  // reject unhandled. Awaiting them after auth would turn independent round-trips into
  // sequential ones.
  const poolsPromise = getRuntimeGatewayPools();
  const overridesPromise = getRuntimeChannelOverrides();

  const authResult = await authenticateImageUser(req.headers, generationQuota);
  if (!authResult.ok) {
    return NextResponse.json({ error: authResult.message }, { status: authResult.status });
  }
  const authenticatedUser = authResult.user;

  // ── 生成质量门（v1 确定性拦截）────────────────────────────────────────────
  // 可判定的才拦：空提示词 / 超长 / 非法宽高比 / 负面词反噬所选风格。LoRA 多选
  // 只记 skip（平台既有 slice(0,1) 归一化兜底）。检查原始请求值而非归一化后的
  // 值——归一化产物恒合法，门会退化成恒真。日志写入失败绝不影响主流程。
  const gateChecks = runPreGenerationGates({
    prompt,
    modelId,
    aspectRatio: requestedAspectRatio ?? workflow?.aspectRatio ?? null,
    referenceImageCount: referenceImages.length,
    negativePrompt: workflow?.negativePrompt ?? null,
    stylePresetId: workflow?.styleTemplate ?? null,
    loraIds: loraModelVersionIds ?? [],
  });
  const gateLogEntry = {
    id: `gate-${requestId}`,
    at: new Date().toISOString(),
    modelId,
    blocked: gatesBlock(gateChecks),
    checks: gateChecks,
  };
  after(() =>
    appendGateLog(authenticatedUser.id, gateLogEntry).catch((error) => {
      console.error(`Failed to append gate log [requestId=${requestId}] ${loggedError(error)}`);
    }),
  );
  if (gatesBlock(gateChecks)) {
    return NextResponse.json(
      { success: false, code: "quality_gate_failed", gates: gateChecks },
      { status: 422 },
    );
  }

  // ── Mock mode ──────────────────────────────────────────────────────────────
  if (MOCK_MODE) {
    await new Promise((r) => setTimeout(r, 1200));
    return NextResponse.json(mockGenerateImage());
  }

  // ── Real mode ──────────────────────────────────────────────────────────────
  // buildModelQueue is the registry's single queue function — the same one the /admin
  // routing panel and the upstream probe call. Env channels, admin
  // pools and admin overrides are all resolved inside it; this route no longer has a
  // private opinion about what the queue is.
  const endpoints = prioritizeHealthyEndpoints(
    buildModelQueue(modelId, process.env, poolsPromise ? await poolsPromise : [], await overridesPromise),
  );
  const routingQueue = endpoints.map((endpoint) => ({
    label: endpoint.label,
    host: safeEndpointName(endpoint.baseURL),
    cooling: isEndpointCoolingDown(endpoint),
  }));
  const attempts: RoutingAttempt[] = [];
  const emitRoutingEvent = (outcome: RoutingOutcome, extra?: { deliveredBy?: string; refunded?: boolean; imageUrls?: string[] }) =>
    recordRoutingEvent({
      id: `${Date.now()}-${requestId}`,
      ts: Date.now(),
      requestId,
      pipeline: "user",
      modelId,
      qualityMode,
      resolution: outputResolution,
      queue: routingQueue,
      attempts,
      outcome,
      ...(extra?.deliveredBy ? { deliveredBy: extra.deliveredBy } : {}),
      ...(extra?.imageUrls && extra.imageUrls.length > 0 ? { imageUrls: extra.imageUrls } : {}),
      totalMs: Date.now() - requestStartedAt,
      coins: requiredCoins,
      refunded: extra?.refunded ?? false,
      ...(authResult.bypassBilling ? { bypassBilling: true } : {}),
    });

  // Logs the queue *after* health reordering, from the same array the telemetry event
  // records — the log line and the admin-visible event can never disagree.
  console.log(`[image-routing] model=${modelId}, queue=${routingQueue.map((entry) => `${entry.label}@${entry.host}${entry.cooling ? "(cooling)" : ""}`).join(" -> ") || "empty"}`);

  if (endpoints.length === 0) {
    // Recorded synchronously: an empty queue is a configuration failure the admin needs
    // to see, and there is no response-latency concern on an error path.
    await emitRoutingEvent("no-endpoints");
    return NextResponse.json(
      {
        error: `No compatible image generation endpoint configured for ${modelId}.`,
      },
      { status: 500 },
    );
  }

  let quotaReserved = false;
  if (!authResult.bypassBilling) {
    try {
      await reserveImageQuota(authenticatedUser.id, generationQuota, authenticatedUser.quota);
      quotaReserved = true;
    } catch (error) {
      console.error(`Failed to reserve image quota [requestId=${requestId}] ${loggedError(error)}`);
      return NextResponse.json(
        { error: "Failed to reserve image quota." },
        { status: 402 },
      );
    }
  }

  const failureReasons: string[] = [];
  // Anchored to request start, not to this line: body parsing (a slow multipart upload
  // can take tens of seconds), auth and reserve all happen before we get here, and none
  // of them used to count against the budget — so the worst case summed to exactly
  // maxDuration with zero headroom for the refund. Anchoring at requestStartedAt makes
  // preamble time compress the retry loop instead of the settlement window.
  const upstreamDeadline = requestStartedAt + UPSTREAM_BUDGET_MS;
  let delivered = false;
  let refundFailed = false;
  let budgetExhausted = false;
  let clientAbortedDuringLoop = false;

  try {
    for (const endpoint of endpoints) {
      if (req.signal?.aborted) {
        clientAbortedDuringLoop = true;
        failureReasons.push("client: cancelled");
        break;
      }

      const remainingMs = upstreamDeadline - Date.now();
      if (remainingMs < MIN_ATTEMPT_BUDGET_MS) {
        budgetExhausted = true;
        failureReasons.push(`budget: ${UPSTREAM_BUDGET_MS}ms exhausted`);
        break;
      }
      // Clamped against the remaining budget so the loop can never overrun maxDuration
      // and take the refund down with it.
      const attemptTimeoutMs = Math.min(upstreamTimeoutForEndpoint(endpoint, modelId), remainingMs);
      const attemptStartedAt = Date.now();

      try {
        const result = await requestImageGeneration(
          endpoint,
          finalPrompt,
          modelId,
          referenceImages,
          imageSize,
          qualityMode,
          aspectRatio,
          outputResolution,
          attemptTimeoutMs,
          req.signal,
          loraModelVersionIds,
        );
        recordEndpointSuccess(endpoint);
        attempts.push({
          label: endpoint.label,
          host: safeEndpointName(endpoint.baseURL),
          ok: true,
          ms: result.upstreamElapsedMs,
        });

        const entryId = `${authenticatedUser.id}-${Date.now()}`;
        let responseImage = result.image;
        let responseImageUrl = result.imageUrl;

        // Upload before responding so the body carries a URL instead of ~2.7MB of base64
        // (which also flirts with the 4.5MB non-streaming response ceiling). History
        // uploaded the same bytes moments later anyway, so this moves the work rather
        // than adding it — and the PNG is then served from the Blob CDN near the user.
        //
        // 2026-08-15 根因修复：上游可能回 url（短时签名链接）而非 b64_json。
        // 旧逻辑此时完全跳过 Blob，把短时链接直接存进 Canvas metadata.content，
        // 链接过期即破图。这里统一转存，让 Canvas/History 拿到的永远是本站持久 URL。
        // 转存失败则退化为保留上游原 URL（不阻塞响应），由 onError 兜底展示。
        if (authenticatedUser.id && canPersistGeneratedImages() && (responseImage || responseImageUrl)) {
          try {
            if (responseImage) {
              responseImageUrl = await persistGeneratedImage(
                authenticatedUser.id,
                entryId,
                "image_tinchak",
                responseImage,
              );
              responseImage = null;
            } else if (responseImageUrl?.startsWith("http")) {
              responseImageUrl = await persistUpstreamImageBytes(authenticatedUser.id, entryId, responseImageUrl);
            }
          } catch (error) {
            // Inline the base64 instead: an oversized response beats no image at all.
            // For upstream-URL re-hosting failures, the original URL simply stays.
            console.error(`Failed to persist generated image [requestId=${requestId}] ${loggedError(error)}`);
          }
        }

        delivered = true;
        // Success events ride after(): the user should not wait on telemetry. Failure
        // paths below record synchronously instead — those are the runs the admin most
        // needs to see, and an error response can afford ~100ms.
        after(() => emitRoutingEvent("delivered", { deliveredBy: endpoint.label, imageUrls: responseImageUrl ? [responseImageUrl] : undefined }));
        if (authenticatedUser.id) {
          // REQ-D1 挂钩 a：生成完成落历史时登记 parents——本次请求带的参考图若出自
          // 另一条生成任务（sourceGenerationId）记 derivation、若直接引用产物
          // （sourceResultId）记 reference；裸上传无持久身份，不登记（跳不动的
          // 假链条比没有链条更坏）。血统只落历史本体，agent/canvas 两面零触碰。
          const historyLineage = mergeLineageIntoHost(
            null,
            parentsFromReferences(workflow?.referenceImages, new Date().toISOString()),
          );
          // after()：响应返回后再持久化历史，避免 serverless 函数实例提前冻结导致历史丢失。
          after(() =>
            saveGeneratedHistoryEntry({
              id: entryId,
              userId: authenticatedUser.id,
              prompt: finalPrompt,
              generatedAt: Date.now(),
              workflow,
              ...(historyLineage ?? {}),
              results: [
                {
                  // Already uploaded above, so persistImages() skips a second upload.
                  provider: "image_tinchak",
                  modelId,
                  image: responseImage,
                  imageUrl: responseImageUrl,
                  endpointLabel: endpoint.label,
                },
              ],
            }).catch((error) => {
              console.error(`Failed to save history [requestId=${requestId}] ${loggedError(error)}`);
            }),
          );
        }
        console.log(`Completed [requestId=${requestId}, model=${modelId}, upstreamModel=${result.upstreamModelId}, endpoint=${endpoint.label}, endpointHost=${safeEndpointName(endpoint.baseURL)}, chargedCoins=${requiredCoins}, estimatedCredits=${estimatedCredits ?? 1}, upstreamElapsedMs=${result.upstreamElapsedMs}, imageDelivery=${responseImage ? "inline-base64" : "blob-url"}]`);
        return NextResponse.json({
          provider: "image_tinchak",
          image: responseImage,
          imageUrl: responseImageUrl,
          endpointLabel: publicEndpointLabel(endpoint.label),
        });
      } catch (error) {
        const clientCancelled = Boolean(req.signal?.aborted);
        attempts.push({
          label: endpoint.label,
          host: safeEndpointName(endpoint.baseURL),
          ok: false,
          ms: Date.now() - attemptStartedAt,
          ...(error instanceof UpstreamImageError ? { status: error.status } : {}),
          reason: clientCancelled ? "cancelled" : attemptFailureReason(error),
        });
        if (clientCancelled) {
          // The user closing the tab is not the channel's fault: recording it as a
          // failure would cool healthy endpoints down and skew the admin success rates.
          clientAbortedDuringLoop = true;
          failureReasons.push("client: cancelled");
          break;
        }
        if (error instanceof UnsupportedEndpointInputError) {
          // 本路径是 DURABLE_PASS_THROUGH（middleware 不缓冲），失败体的脱敏只能在**生成源**
          // 做：上游 message 可能夹带内部文案，出站前先过 sanitize（正常业务文案原样保留）。
          failureReasons.push(redactSecrets(sanitizeUpstreamMessage(error.message) ?? "unsupported input"));
          continue;
        }
        recordEndpointFailure(endpoint);
        failureReasons.push(endpointFailureReason(error));
        const upstreamStatus = error instanceof UpstreamImageError ? `, upstreamStatus=${error.status}` : "";
        const upstreamMessage = loggedError(error);
        console.error(`Failed on ${endpoint.label} [requestId=${requestId}, endpointHost=${safeEndpointName(endpoint.baseURL)}, upstreamModel=${resolveUpstreamModelId(modelId, endpoint.modelId)}${upstreamStatus}, attemptTimeoutMs=${attemptTimeoutMs}] ${upstreamMessage}`);
      }
    }
  } finally {
    // Refunds on *every* path that failed to deliver: exhausted queue, spent budget,
    // client cancellation, or an unexpected throw. This used to sit after the loop, so
    // a function killed at maxDuration debited the user and refunded nothing.
    if (quotaReserved && !delivered) {
      try {
        await refundImageQuota(authenticatedUser.id, generationQuota);
      } catch (error) {
        refundFailed = true;
        console.error(`Failed to refund image quota [requestId=${requestId}] ${loggedError(error)}`);
      }
    }
  }

  // Failure events are recorded before the response goes out. after() callbacks are
  // skipped when Vercel hard-kills at maxDuration, and a run that burned its whole
  // budget is exactly the run the admin needs evidence of. The deadline is anchored at
  // requestStartedAt, so maxDuration - UPSTREAM_BUDGET_MS (60s) of settlement headroom
  // is genuinely guaranteed here; the telemetry write itself is capped at 5s.
  // Classified from the loop-time snapshot: reading req.signal here would let a client
  // that disconnects during the refund await re-label a genuine exhaustion as cancelled.
  const failureOutcome: RoutingOutcome = clientAbortedDuringLoop
    ? "cancelled"
    : budgetExhausted
      ? "budget-exhausted"
      : "exhausted";
  await emitRoutingEvent(failureOutcome, { refunded: quotaReserved && !delivered && !refundFailed });

  if (refundFailed) {
    return NextResponse.json(
      { error: "生成失败，额度退回失败，请联系管理员。" },
      { status: 500 },
    );
  }

  if (failureReasons.length > 0) {
    console.error(`Image generation failed [requestId=${requestId}] ${redactSecrets(failureReasons.join("; "))}`);
  }
  return NextResponse.json(
    { error: "Image generation failed." },
    { status: 503 },
  );
}
