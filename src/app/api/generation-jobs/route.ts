import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { put } from "@/lib/blob-backend";
import {
  generationCapabilities,
  generationCoins,
  imageSizeForAspectRatio,
  normalizeGenerationConfig,
} from "@/lib/generation-model-catalog";
import { syncModelPricing } from "@/lib/pricing-runtime";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";
import { submitGenerationCommand } from "@/lib/generation-core/command-service";
import { GenerationModelUnavailableError } from "@/lib/generation-core/model-availability-gate";
import {
  getGenerationArtifactForTenant,
  getGenerationJobForTenant,
  listGenerationJobsForTenant,
} from "@/lib/generation-core/job-repository";
import { validateImageBuffer } from "@/lib/generation-core/artifact-service";
import {
  DURABLE_TIER_SCALE,
  isDurableImageSize,
  scaleDurableImageSize,
} from "@/lib/generation-core/durable-image-sizes";
import { generationTaskProjection } from "@/lib/generation-core/task-projection";
import {
  VideoPostProductionError,
  effectiveVideoPrompt,
  parseVideoPostProduction,
  videoPostProductionGeneratedSeconds,
} from "@/lib/generation-core/video-post-production";
import type { CreateGenerationReferenceArtifactInput, GenerationReference } from "@/lib/generation-core/types";
import { publicObjectUrl } from "@/lib/two-phase-upload";
import { authenticateImageUser } from "@/lib/image-billing";
import {
  composeWebTaskPrompt,
  displayGenerationPrompt,
  readRequestWorkflow,
  withOriginalPrompt,
} from "@/lib/web-task-prompt";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const preferredRegion = "sfo1"; // 与 VPS（闸道/控制面 DB，矽谷）同区：每次上游往返省一趟横跨美国（2026-10-01 效能审计）

const MAX_REFERENCE_IMAGES = 8;
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 8_000;

/**
 * C 端生成任务列表只认这六种 kind。`film_export` 是 agent 成片导出记录
 * （master-ingest-service 写入，model_id 可能是 catalog 没有的 `timeline_master`），
 * 不属于用户生成任务；在 route 层滤掉，不动 job-repository 的通用查询语义。
 */
const GENERATION_TASK_KINDS: ReadonlySet<string> = new Set([
  "image_generate",
  "image_edit",
  "video_generate",
  "tts",
  "avatar",
  "lipsync",
]);

type ReferenceRole = "general" | "character" | "product" | "style" | "composition";

interface WebTaskBody {
  prompt?: unknown;
  modelId?: unknown;
  qualityMode?: unknown;
  aspectRatio?: unknown;
  outputResolution?: unknown;
  durationSeconds?: unknown;
  generateAudio?: unknown;
  loraModelVersionIds?: unknown;
  workflow?: unknown;
  retryOfTaskId?: unknown;
}

interface ReferenceMetadata {
  id?: string;
  name?: string;
  role?: string;
  sourceResultId?: string;
  sourceGenerationId?: string;
}

/** 任务投影：job.prompt 是组好给供给的长 prompt，对用户显示还原成原文（workflow.originalPrompt）。 */
function webTaskProjection(job: Parameters<typeof generationTaskProjection>[0]) {
  const projection = generationTaskProjection(job, { includePrompt: true });
  return { ...projection, prompt: displayGenerationPrompt(projection.prompt, job.workflow) };
}

function fail(status: number, message: string, code: string) {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJson(value: FormDataEntryValue | null): unknown {
  if (typeof value !== "string" || !value) return undefined;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function referenceRole(value: unknown): ReferenceRole {
  if (value === "character" || value === "face") return "character";
  if (value === "product" || value === "style" || value === "composition") return value;
  return "general";
}

async function readBody(req: NextRequest): Promise<{ body: WebTaskBody; files: File[]; metadata: ReferenceMetadata[] }> {
  if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const form = await req.formData();
    const files = form.getAll("referenceImages").filter((value): value is File => value instanceof File).slice(0, MAX_REFERENCE_IMAGES);
    const rawMetadata = parseJson(form.get("referenceMetadata"));
    return {
      body: {
        prompt: form.get("prompt"),
        modelId: form.get("modelId"),
        qualityMode: form.get("qualityMode"),
        aspectRatio: form.get("aspectRatio"),
        outputResolution: form.get("outputResolution"),
        durationSeconds: form.get("durationSeconds"),
        generateAudio: form.get("generateAudio"),
        loraModelVersionIds: parseJson(form.get("loraModelVersionIds")),
        workflow: parseJson(form.get("workflow")),
        retryOfTaskId: form.get("retryOfTaskId"),
      },
      files,
      metadata: Array.isArray(rawMetadata) ? rawMetadata.filter((item): item is ReferenceMetadata => typeof item === "object" && item !== null) : [],
    };
  }
  const body = await req.json() as WebTaskBody;
  return { body, files: [], metadata: [] };
}

function extension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

async function persistReferences(input: {
  files: File[];
  metadata: ReferenceMetadata[];
  tenantId: string;
  idempotencyKey: string;
}): Promise<{ artifacts: CreateGenerationReferenceArtifactInput[]; references: GenerationReference[]; uploadedUrls: string[] }> {
  const artifacts: CreateGenerationReferenceArtifactInput[] = [];
  const references: GenerationReference[] = [];
  const uploadedUrls: string[] = [];

  for (let index = 0; index < input.files.length; index += 1) {
    const file = input.files[index];
    if (file.size <= 0 || file.size > MAX_REFERENCE_BYTES) throw new Error(`参考图 ${file.name || index + 1} 超出体积限制。`);
    const buffer = Buffer.from(await file.arrayBuffer());
    const validated = validateImageBuffer(buffer);
    if ("error" in validated) throw new Error(`参考图 ${file.name || index + 1} 无效：${validated.error}`);
    const stable = createHash("sha256")
      .update(`${input.tenantId}|${input.idempotencyKey}|${index}|${validated.sha256}`)
      .digest("hex");
    const artifactId = `ref-${stable}`;
    const objectKey = `generation/references/${stable}.${extension(validated.mimeType)}`;
    const blob = await put(objectKey, buffer, {
      access: "public",
      contentType: validated.mimeType,
      allowOverwrite: true,
      cacheControlMaxAge: 31_536_000,
    });
    uploadedUrls.push(blob.url);

    const meta = input.metadata[index] ?? {};
    const claimedResultId = cleanString(meta.sourceResultId);
    const ownedSource = claimedResultId
      ? await getGenerationArtifactForTenant(claimedResultId, input.tenantId)
      : null;
    const role = referenceRole(meta.role);
    const artifact: CreateGenerationReferenceArtifactInput = {
      id: artifactId,
      objectKey,
      deliveryUrl: blob.url,
      mimeType: validated.mimeType,
      sha256: validated.sha256,
      byteSize: buffer.length,
      width: validated.width,
      height: validated.height,
      ...(ownedSource ? { sourceResultId: ownedSource.artifactId, sourceGenerationId: ownedSource.taskId } : {}),
      referenceRole: role,
      metadata: { name: cleanString(meta.name) ?? file.name ?? `reference-${index + 1}` },
    };
    artifacts.push(artifact);
    references.push({
      artifactId,
      url: blob.url,
      mimeType: validated.mimeType,
      name: cleanString(meta.name) ?? file.name ?? `reference-${index + 1}`,
      ...(ownedSource ? { sourceResultId: ownedSource.artifactId, sourceGenerationId: ownedSource.taskId } : {}),
      referenceRole: role,
    });
  }
  return { artifacts, references, uploadedUrls };
}

export async function GET(req: NextRequest) {
  const auth = await authenticateImageUser(req.headers, 0);
  if (!auth.ok) return fail(auth.status, auth.message, "unauthorized");
  if (!generationControlPlaneEnabled()) {
    return NextResponse.json({ success: true, enabled: false, data: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  const { searchParams } = new URL(req.url);
  const limit = Math.max(1, Math.min(100, Number(searchParams.get("limit")) || 50));
  const jobs = await listGenerationJobsForTenant(`web:${auth.user.id}`, { limit });
  return NextResponse.json({
    success: true,
    enabled: true,
    data: jobs.filter((job) => GENERATION_TASK_KINDS.has(job.kind)).map(webTaskProjection),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!generationControlPlaneEnabled()) return fail(503, "Generation control plane is not enabled.", "control_plane_disabled");

  let parsed: Awaited<ReturnType<typeof readBody>>;
  try {
    parsed = await readBody(req);
  } catch {
    return fail(400, "请求体格式无效。", "invalid_request");
  }

  const prompt = cleanString(parsed.body.prompt) ?? "";
  const modelId = cleanString(parsed.body.modelId) ?? "";
  const requestWorkflow = readRequestWorkflow(parsed.body.workflow);
  // 局部改片允许用「改动描述」当画面描述，故带 videoPostProduction 的请求把这道
  // 检查下移到契约解析之后（见下）；其余请求的检查顺序与错误码一字不变。
  const hasPostProductionRequest =
    requestWorkflow?.videoPostProduction !== undefined && requestWorkflow?.videoPostProduction !== null;
  if (!hasPostProductionRequest && (!prompt || prompt.length > MAX_PROMPT_LENGTH)) {
    return fail(400, "画面描述为空或过长。", "invalid_prompt");
  }
  const capabilities = generationCapabilities(modelId);
  const dreaminaImageModel = modelId === "image-5-pro" || modelId === "image-5-lite" || modelId === "seedream-2.0";
  if (!capabilities && !dreaminaImageModel) return fail(400, "所选模型不可用。", "model_not_found");

  // 生成式后期（P1-3／对称差 D22）：B/C 端都用同一份契约与能力闸。
  // 来源影片：`url` 直用，`objectKey` 走两段式上传的公网 URL 推导（P1-10 同一轮子）；
  // 解不出＝具名拒绝，不猜 URL、不静默降级成普通生成。
  let postProduction: ReturnType<typeof parseVideoPostProduction> = null;
  try {
    postProduction = parseVideoPostProduction(requestWorkflow?.videoPostProduction, {
      modelId,
      resolveObjectKeyUrl: publicObjectUrl,
    });
  } catch (error) {
    if (error instanceof VideoPostProductionError) return fail(error.status, error.message, error.code);
    throw error;
  }
  const requestedPrompt = effectiveVideoPrompt(prompt, postProduction);
  if (!requestedPrompt || requestedPrompt.length > MAX_PROMPT_LENGTH) return fail(400, "画面描述为空或过长。", "invalid_prompt");
  const generatedSeconds = postProduction ? videoPostProductionGeneratedSeconds(postProduction) : undefined;

  const rawLora = Array.isArray(parsed.body.loraModelVersionIds) ? parsed.body.loraModelVersionIds.map(String) : [];
  const rawDuration = parsed.body.durationSeconds;
  const rawAudio = parsed.body.generateAudio;
  const normalized = capabilities
    ? normalizeGenerationConfig(modelId, {
        aspectRatio: cleanString(parsed.body.aspectRatio),
        outputResolution: cleanString(parsed.body.outputResolution),
        // 生成式后期：本次生成秒数＝续长／区段长（契约校验已确认落在 catalog 档位），
        // 覆盖 body 的 durationSeconds——扣费、成本闸、上游同源。
        durationSeconds: generatedSeconds
          ?? (rawDuration === undefined || rawDuration === null || rawDuration === "" ? undefined : Number(rawDuration)),
        generateAudio: rawAudio === undefined || rawAudio === null || rawAudio === "" ? undefined : rawAudio === true || rawAudio === "true",
        qualityMode: cleanString(parsed.body.qualityMode),
        referenceCount: parsed.files.length,
        loraModelVersionIds: rawLora,
      })
    : {
        config: {
          modelId,
          mediaType: "image" as const,
          aspectRatio: "1:1" as const,
          outputResolution: "1k" as const,
          qualityMode: "fast" as const,
          referenceCount: parsed.files.length,
          loraModelVersionIds: [],
        },
        clearedFields: [],
      };
  if (parsed.files.length && capabilities?.referenceImages === false) return fail(400, "所选模型不支持参考图。", "reference_images_unsupported");
  if (rawLora.length && capabilities?.lora !== true) return fail(400, "所选模型不支持 LoRA。", "lora_unsupported");

  // 档位只在 size 上表达（上游 openai_images 只认 size）：不按档位折算就等于
  // 「选 2k/4k 却交 1k 图、还按高档位扣费」；而 16:9/4:3/21:9 的基准尺寸
  // （1792x1024 / 1365x1024 / 1792x768）不在 durable 白名单内，2026-10-04 起
  // 两个可用供给全部 503，任务空转到 120 分钟。落不进白名单＝未验证，具名拒，
  // 不静默降级（与 upscale-backend 的 planGptImageUpscale 同一纪律）。
  // 必须放在鉴权/扣费/建单之前：拒绝时零扣费、零建单。
  let imageSize: string | null = null;
  if (normalized.config.mediaType === "image") {
    const baseSize = imageSizeForAspectRatio(normalized.config.aspectRatio);
    const tierScale = DURABLE_TIER_SCALE[normalized.config.outputResolution as keyof typeof DURABLE_TIER_SCALE] ?? 1;
    const scaledSize = scaleDurableImageSize(baseSize, tierScale);
    if (!scaledSize || !isDurableImageSize(scaledSize)) {
      return fail(
        400,
        `画幅 ${normalized.config.aspectRatio} × ${normalized.config.outputResolution} 没有已知可交的输出尺寸（基准 ${baseSize} ×${tierScale}），请改选 1:1/3:2/2:3 或更低档位。`,
        "unsupported_size",
      );
    }
    imageSize = scaledSize;
  }

  // 管理员改价需立即对扣费生效：算价前先把最新定价覆写同步进目录（核心层内部吞错，失败不挡生成）。
  await syncModelPricing();

  const requiredCoins = generationCoins(modelId, normalized.config);
  const auth = await authenticateImageUser(req.headers, requiredCoins * QUOTA_PER_COIN);
  if (!auth.ok) return fail(auth.status, auth.message, auth.status === 402 ? "insufficient_quota" : "unauthorized");
  const tenantId = `web:${auth.user.id}`;

  const retryOfTaskId = cleanString(parsed.body.retryOfTaskId);
  const retryJob = retryOfTaskId ? await getGenerationJobForTenant(retryOfTaskId, tenantId) : null;
  if (retryOfTaskId && !retryJob) {
    return fail(400, "无法重试不属于当前账号的任务。", "invalid_retry_source");
  }

  const idempotencyKey = cleanString(req.headers.get("idempotency-key")) ?? `web-${randomUUID()}`;
  let persisted: Awaited<ReturnType<typeof persistReferences>> = { artifacts: [], references: [], uploadedUrls: [] };
  try {
    persisted = await persistReferences({
      files: parsed.files,
      metadata: parsed.metadata,
      tenantId,
      idempotencyKey,
    });
    const requestedWorkflow = requestWorkflow ?? {};
    // 负面词/参考图角色：generation-core 不读 workflow，这里用 legacy 同一函式组进供给 prompt；
    // 只看本次 body 的 workflow（canvas 已预组且不送 workflow → 原样透传，不重复套用）。
    const submittedPrompt = composeWebTaskPrompt(requestedPrompt, requestWorkflow);
    const workflow = withOriginalPrompt({
      ...(retryJob?.workflow ?? {}),
      ...requestedWorkflow,
      // 后期参数一律以本次正规化结果为准（重试时沿用上一单的后期参数＝不静默降级）。
      ...(postProduction ? { videoPostProduction: postProduction } : {}),
    }, requestedPrompt, submittedPrompt);
    const references = persisted.references.length
      ? persisted.references
      : retryJob?.workflow.references ?? [];
    const submitted = await submitGenerationCommand({
      tenantId,
      billingUserId: auth.user.id,
      source: "web",
      idempotencyKey,
      kind: normalized.config.mediaType === "video" ? "video_generate" : references.length ? "image_edit" : "image_generate",
      modelId,
      prompt: submittedPrompt,
      size: imageSize,
      ratio: normalized.config.aspectRatio,
      resolution: normalized.config.outputResolution,
      quality: normalized.config.qualityMode,
      workflow: {
        ...workflow,
        references,
        durationSeconds: normalized.config.durationSeconds,
        generateAudio: normalized.config.generateAudio,
        loraModelVersionIds: normalized.config.loraModelVersionIds,
      },
      responseFormat: "url",
      requestedCount: 1,
      billingAmount: requiredCoins * QUOTA_PER_COIN,
      retryOfTaskId,
      referenceArtifacts: persisted.artifacts,
    });
    if (!submitted.created && persisted.uploadedUrls.length) {
      // Same idempotent request already owns the durable references.
      // Keep deterministic objects in place; allowOverwrite made this a no-op refresh.
    }
    return NextResponse.json({
      success: true,
      data: webTaskProjection(submitted.job),
    }, {
      status: submitted.created ? 202 : 200,
      headers: {
        "Location": `/api/generation-jobs/${submitted.job.id}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    // 模型可用性闸：该模型近期真实生成全失败 → 建单/扣费前拒单，回诚实原因与替代模型。
    if (error instanceof GenerationModelUnavailableError) {
      return fail(503, error.message, "model_unavailable");
    }
    console.error("[web-generation-task] submission failed", error);
    return fail(503, "任务提交失败，请稍后重试。", "task_submission_failed");
  }
}
