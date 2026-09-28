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
import { generationTaskProjection } from "@/lib/generation-core/task-projection";
import type { CreateGenerationReferenceArtifactInput, GenerationReference } from "@/lib/generation-core/types";
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

const MAX_REFERENCE_IMAGES = 8;
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 8_000;

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

/** 任務投影：job.prompt 是組好給供給的長 prompt，對用戶顯示還原成原文（workflow.originalPrompt）。 */
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
    data: jobs.map(webTaskProjection),
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
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) return fail(400, "画面描述为空或过长。", "invalid_prompt");
  const capabilities = generationCapabilities(modelId);
  const dreaminaImageModel = modelId === "image-5-pro" || modelId === "image-5-lite" || modelId === "seedream-2.0";
  if (!capabilities && !dreaminaImageModel) return fail(400, "所选模型不可用。", "model_not_found");

  const rawLora = Array.isArray(parsed.body.loraModelVersionIds) ? parsed.body.loraModelVersionIds.map(String) : [];
  const rawDuration = parsed.body.durationSeconds;
  const rawAudio = parsed.body.generateAudio;
  const normalized = capabilities
    ? normalizeGenerationConfig(modelId, {
        aspectRatio: cleanString(parsed.body.aspectRatio),
        outputResolution: cleanString(parsed.body.outputResolution),
        durationSeconds: rawDuration === undefined || rawDuration === null || rawDuration === "" ? undefined : Number(rawDuration),
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

  // 管理員改價需立即對扣費生效：算價前先把最新定價覆寫同步進目錄（核心層內部吞錯，失敗不擋生成）。
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
    const requestWorkflow = readRequestWorkflow(parsed.body.workflow);
    const requestedWorkflow = requestWorkflow ?? {};
    // 負面詞/參考圖角色：generation-core 不讀 workflow，這裡用 legacy 同一函式組進供給 prompt；
    // 只看本次 body 的 workflow（canvas 已預組且不送 workflow → 原樣透傳，不重複套用）。
    const submittedPrompt = composeWebTaskPrompt(prompt, requestWorkflow);
    const workflow = withOriginalPrompt({ ...(retryJob?.workflow ?? {}), ...requestedWorkflow }, prompt, submittedPrompt);
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
      size: normalized.config.mediaType === "image" ? imageSizeForAspectRatio(normalized.config.aspectRatio) : null,
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
    // 模型可用性閘：該模型近期真實生成全失敗 → 建單/扣費前拒單，回誠實原因與替代模型。
    if (error instanceof GenerationModelUnavailableError) {
      return fail(503, error.message, "model_unavailable");
    }
    console.error("[web-generation-task] submission failed", error);
    return fail(503, "任务提交失败，请稍后重试。", "task_submission_failed");
  }
}
