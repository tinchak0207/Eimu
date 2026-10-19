import { NextRequest, NextResponse, after } from "next/server";
import { getRuntimeGatewayPools } from "@/lib/admin-pool-store";
import { getRuntimeChannelOverrides } from "@/lib/channel-overrides";
import {
  buildModelQueue,
  isEndpointCoolingDown,
  prioritizeHealthyEndpoints,
  publicEndpointLabel,
  recordEndpointFailure,
  recordEndpointSuccess,
  safeEndpointHost,
} from "@/lib/channel-registry";
import { authenticateImageUser, refundImageQuota, reserveImageQuota } from "@/lib/image-billing";
import { publicImageUrl } from "@/lib/image-url";
import { QUOTA_PER_COIN } from "@/lib/new-api-client";
import { recordRoutingEvent, type RoutingAttempt } from "@/lib/routing-telemetry";
import {
  defaultGenerateAudio,
  generationCoins,
  isSupportedVideoModel,
  modelSupportsAudio,
  resolveGenerationModelId,
  resolveSupportedAspectRatio,
  resolveSupportedDuration,
  resolveSupportedResolution,
  type AspectRatio,
  type OutputResolution,
} from "@/lib/generation-model-catalog";
import { resolveAdobe2ApiVideoModelId } from "@/lib/generation-core/adobe2api-upstream";
import { syncModelPricing } from "@/lib/pricing-runtime";
import { optimizeVideoPrompt } from "@/lib/agent-prompt-optimizer";
import { fuseSceneVideo } from "@/lib/scene3d-video-fusion";

export const runtime = "nodejs";
export const maxDuration = 300;
export const preferredRegion = "sfo1";

const VIDEO_UPSTREAM_BUDGET_MS = 285_000;
const VIDEO_UPSTREAM_TIMEOUT_MS = 275_000;
const MIN_VIDEO_ATTEMPT_MS = 30_000;

interface ParsedVideoRequest {
  prompt: string;
  modelId: string;
  aspectRatio?: string;
  outputResolution?: string;
  durationSeconds?: number;
  generateAudio?: boolean;
  referenceImages: File[];
  // 3D 场景卡嵌合（片AC，2026-09-06，可选；缺栏零行为变化）。
  sceneCard?: unknown;
  cameraTrajectory?: unknown;
}

/** JSON body 的 scene_card/camera_trajectory 栏位（object 检查即可，融合层做深解析）。 */
function optionalObject(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

interface AdobeChatPayload {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

class UpstreamVideoError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "UpstreamVideoError";
  }
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

async function readVideoRequest(req: NextRequest): Promise<ParsedVideoRequest> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    const body = await req.json() as Record<string, unknown>;
    return {
      prompt: String(body.prompt ?? ""),
      modelId: String(body.modelId ?? ""),
      aspectRatio: typeof body.aspectRatio === "string" ? body.aspectRatio : undefined,
      outputResolution: typeof body.outputResolution === "string" ? body.outputResolution : undefined,
      durationSeconds: Number(body.durationSeconds) || undefined,
      generateAudio: optionalBoolean(body.generateAudio ?? body.generate_audio),
      sceneCard: optionalObject(body.scene_card),
      cameraTrajectory: optionalObject(body.camera_trajectory),
      referenceImages: [],
    };
  }

  const form = await req.formData();
  return {
    prompt: String(form.get("prompt") ?? ""),
    modelId: String(form.get("modelId") ?? ""),
    aspectRatio: String(form.get("aspectRatio") ?? "") || undefined,
    outputResolution: String(form.get("outputResolution") ?? "") || undefined,
    durationSeconds: Number(form.get("durationSeconds")) || undefined,
    generateAudio: optionalBoolean(form.get("generateAudio") ?? form.get("generate_audio")),
    referenceImages: form
      .getAll("referenceImages")
      .filter((item): item is File => item instanceof File && item.size > 0),
  };
}

async function buildMessages(prompt: string, referenceImages: File[]) {
  if (!referenceImages.length) return [{ role: "user", content: prompt }];
  return [{
    role: "user",
    content: [
      { type: "text", text: prompt },
      ...await Promise.all(referenceImages.map(async (image) => ({
        type: "image_url",
        image_url: {
          url: `data:${image.type || "image/png"};base64,${Buffer.from(await image.arrayBuffer()).toString("base64")}`,
        },
      }))),
    ],
  }];
}

function extractVideoUrl(payload: AdobeChatPayload | null): string | null {
  const content = payload?.choices?.[0]?.message?.content ?? "";
  const matched = content.match(/<video[^>]+src=['"](https?:\/\/[^'"]+)['"]/i)?.[1]
    ?? content.match(/(https?:\/\/[^\s'"<>]+\.(?:mp4|webm)(?:\?[^\s'"<>]*)?)/i)?.[1];
  return publicImageUrl(matched);
}

async function requestVideo(
  endpoint: { apiKey: string; baseURL: string; label: string },
  upstreamModelId: string,
  prompt: string,
  referenceImages: File[],
  generateAudio: boolean,
  timeoutMs: number,
  clientSignal?: AbortSignal,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = clientSignal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([controller.signal, clientSignal])
    : controller.signal;
  const startedAt = Date.now();
  try {
    const response = await fetch(`${endpoint.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: upstreamModelId,
        messages: await buildMessages(prompt, referenceImages),
        generate_audio: generateAudio,
      }),
      signal,
    });
    const text = await response.text();
    let payload: AdobeChatPayload | null = null;
    try {
      payload = text ? JSON.parse(text) as AdobeChatPayload : null;
    } catch {
      if (!response.ok) throw new UpstreamVideoError(text.slice(0, 300), response.status);
    }
    if (!response.ok) {
      throw new UpstreamVideoError(payload?.error?.message ?? `Video generation failed on ${endpoint.label}.`, response.status);
    }
    const videoUrl = extractVideoUrl(payload);
    if (!videoUrl) throw new Error(`No video URL returned from ${endpoint.label}.`);
    return { videoUrl, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(clientSignal?.aborted ? "Video generation cancelled by the client." : `Video generation timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(req: NextRequest) {
  const requestId = Math.random().toString(36).slice(2);
  const startedAt = Date.now();
  // 非法 JSON／破损 multipart 是客户端输入错误：解析失败回 400，不得落到未捕捉的 500，
  // 也不得把解析器内部细节外泄（红队 2026-10-05）。
  let parsed: Awaited<ReturnType<typeof readVideoRequest>>;
  try {
    parsed = await readVideoRequest(req);
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const prompt = parsed.prompt.trim();
  // 宽容解析：`seedance 2.0`（显示名风格分隔符）归一成 `seedance-2.0`，同一模型不因写法被拒。
  const modelId = resolveGenerationModelId(parsed.modelId.trim()) ?? parsed.modelId.trim();
  if (!prompt || !isSupportedVideoModel(modelId)) {
    return NextResponse.json({ error: "Invalid video generation parameters." }, { status: 400 });
  }

  const aspectRatio = resolveSupportedAspectRatio(modelId, parsed.aspectRatio) as AspectRatio;
  const outputResolution = resolveSupportedResolution(modelId, parsed.outputResolution) as OutputResolution;
  const durationSeconds = resolveSupportedDuration(modelId, parsed.durationSeconds);
  if (!durationSeconds) return NextResponse.json({ error: "Unsupported video duration." }, { status: 400 });
  const generateAudio = modelSupportsAudio(modelId)
    ? parsed.generateAudio ?? defaultGenerateAudio(modelId)
    : false;
  const upstreamModelId = resolveAdobe2ApiVideoModelId(modelId, aspectRatio, outputResolution, durationSeconds);
  if (!upstreamModelId) return NextResponse.json({ error: "Unsupported video model variant." }, { status: 400 });

  // 隐形提示词导演：Agent 层（deepseek）优化 → 失败规则层兜底 → 原样。
  // 用户无感；优化失败绝不阻塞生成（回原始 prompt）。
  // 3D 场景卡嵌合（片AC）：scene_card + camera_trajectory 同时在场且形状合法才生效，
  // 缺栏/脏栏 = null = 零行为变化。
  const sceneVideoFusion = fuseSceneVideo(parsed.sceneCard, parsed.cameraTrajectory);
  const optimized = await optimizeVideoPrompt(prompt, {
    modelId,
    durationSeconds,
    generateAudio,
    ...(sceneVideoFusion
      ? { sceneCard: sceneVideoFusion.sceneCard, cameraTrajectory: sceneVideoFusion.cameraTrajectory }
      : {}),
  });
  const finalPrompt = optimized.prompt;
  if (optimized.ok && optimized.usedAgent) {
    console.log(`[video-prompt-director] optimized requestId=${requestId} model=${optimized.model ?? "agent"} ms=${optimized.ms ?? 0}`);
  }

  // 管理员改价需立即对扣费生效：算价前先把最新定价覆写同步进目录（核心层内部吞错，失败不挡生成）。
  await syncModelPricing();

  const requiredCoins = generationCoins(modelId, {
    resolution: outputResolution,
    durationSeconds,
    generateAudio,
  });
  const requiredQuota = requiredCoins * QUOTA_PER_COIN;
  const [authResult, pools, overrides] = await Promise.all([
    authenticateImageUser(req.headers, requiredQuota),
    getRuntimeGatewayPools(),
    getRuntimeChannelOverrides(),
  ]);
  if (!authResult.ok) return NextResponse.json({ error: authResult.message }, { status: authResult.status });

  const endpoints = prioritizeHealthyEndpoints(buildModelQueue(modelId, process.env, pools, overrides));
  const routingQueue = endpoints.map((endpoint) => ({
    label: endpoint.label,
    host: safeEndpointHost(endpoint.baseURL),
    cooling: isEndpointCoolingDown(endpoint),
  }));
  const attempts: RoutingAttempt[] = [];
  const emitEvent = (outcome: "delivered" | "exhausted" | "budget-exhausted" | "no-endpoints", deliveredBy?: string, refunded = false, imageUrls?: string[]) =>
    recordRoutingEvent({
      id: `${Date.now()}-${requestId}`,
      ts: Date.now(),
      requestId,
      pipeline: "user",
      modelId,
      qualityMode: outputResolution,
      resolution: outputResolution,
      queue: routingQueue,
      attempts,
      outcome,
      ...(deliveredBy ? { deliveredBy } : {}),
      ...(imageUrls && imageUrls.length > 0 ? { imageUrls } : {}),
      totalMs: Date.now() - startedAt,
      coins: requiredCoins,
      refunded,
      ...(authResult.bypassBilling ? { bypassBilling: true } : {}),
    });

  if (!endpoints.length) {
    await emitEvent("no-endpoints");
    return NextResponse.json({ error: `No compatible video endpoint configured for ${modelId}.` }, { status: 503 });
  }

  let quotaReserved = false;
  let delivered = false;
  let refunded = false;
  if (!authResult.bypassBilling) {
    try {
      await reserveImageQuota(authResult.user.id, requiredQuota, authResult.user.quota);
      quotaReserved = true;
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to reserve video quota." }, { status: 402 });
    }
  }

  const failures: string[] = [];
  const deadline = startedAt + VIDEO_UPSTREAM_BUDGET_MS;
  let budgetExhausted = false;
  try {
    for (const endpoint of endpoints) {
      const remainingMs = deadline - Date.now();
      if (remainingMs < MIN_VIDEO_ATTEMPT_MS) {
        budgetExhausted = true;
        failures.push("video generation budget exhausted");
        break;
      }
      const attemptStartedAt = Date.now();
      try {
  // 上游只吃 files（multipart 图位）——非 File 的 JSON 参考卡不进上游（版位契约不动）。
  const referenceFiles = [...parsed.referenceImages];
  if (sceneVideoFusion) {
    const upstreamFiles = sceneVideoFusion.frameCard.references
      .filter((reference) => reference.url.startsWith("data:"))
      .slice(0, Math.max(0, 2 - referenceFiles.length));
    if (upstreamFiles.length > 0) {
      const files = await Promise.all(
        upstreamFiles.map(async (reference) => new File(
          [Buffer.from(reference.url.slice(reference.url.indexOf(",") + 1), "base64")],
          `${reference.name || "scene3d-ref"}.png`,
          { type: reference.mimeType },
        )),
      );
      referenceFiles.push(...files);
    }
  }
  const result = await requestVideo(
    endpoint,
    upstreamModelId,
    finalPrompt,
    referenceFiles,
    generateAudio,
          Math.min(VIDEO_UPSTREAM_TIMEOUT_MS, remainingMs),
          req.signal,
        );
        recordEndpointSuccess(endpoint);
        attempts.push({ label: endpoint.label, host: safeEndpointHost(endpoint.baseURL), ok: true, ms: result.elapsedMs });
        delivered = true;
        after(() => emitEvent("delivered", endpoint.label, false, result.videoUrl ? [result.videoUrl] : undefined));
        return NextResponse.json({
          provider: "image_eimu",
          mediaType: "video",
          videoUrl: result.videoUrl,
          endpointLabel: publicEndpointLabel(endpoint.label),
        });
      } catch (error) {
        if (req.signal?.aborted) break;
        recordEndpointFailure(endpoint);
        const status = error instanceof UpstreamVideoError ? error.status : undefined;
        attempts.push({
          label: endpoint.label,
          host: safeEndpointHost(endpoint.baseURL),
          ok: false,
          ms: Date.now() - attemptStartedAt,
          ...(status ? { status } : {}),
          reason: status ? `http-${status}` : error instanceof Error && error.message.includes("timed out") ? "timeout" : "upstream-error",
        });
        failures.push(status ? `HTTP ${status}` : "upstream error");
      }
    }
  } finally {
    if (quotaReserved && !delivered) {
      try {
        await refundImageQuota(authResult.user.id, requiredQuota);
        refunded = true;
      } catch (error) {
        console.error(`[video-billing] refund failed requestId=${requestId}`, error);
      }
    }
  }

  await emitEvent(budgetExhausted ? "budget-exhausted" : "exhausted", undefined, refunded);
  return NextResponse.json({ error: `Video generation failed: ${failures.join("; ") || "upstream unavailable"}` }, { status: 503 });
}
