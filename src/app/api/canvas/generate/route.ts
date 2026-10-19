// POST /api/canvas/generate — 画布节点触发的图片生成。
//
// 与生产平面的关系（2026-09-28 V-09 修正）：这里是画布专用的分发薄壳。
// 预设走 durable job——每张图 `POST /api/generation-jobs`（带 Idempotency-Key）→
// 伺服器端轮询 `GET /api/generation-jobs/{id}` → 取件，聚合成画布 reducer 可直接吃的
// 阵列（回应形状与旧版相容：只加 images[i].task_id＝durable job id，供 LOD3 工程透析回查；legacy 为 null）。同步形状只在本层做，生产只认异步 job
// （docs/architecture/planes.md §3.3；范本 use-image-generation.ts:627、openai-compat/generation.ts）。
// 等待上限 = maxDuration − 20s；超时回 504 generation_timeout，**不取消任务**
// （job 仍在帐本里跑完/退款，完成后出现在生成记录）。
//
// 仍走 legacy /api/generate-images 的情境（只有这些；durable 不支援、不准静默丢）：
//   ① 带 LoRA——generation-core 没有任何 adapter 消费 workflow.loraModelVersionIds；
//   ② 带参考图但模型能力 referenceImages === false——durable 会 400 拒单，legacy 会照送上游；
//   ③ 参考图不是 PNG/JPEG/WEBP 或超过 12MB——durable 的 persistReferences 会拒。
// 负面词与参考图角色在 durable 路径由本层用 legacy 同一函式 buildWorkflowPrompt
// 预先组进 prompt（generation-core 不消费 workflow.negativePrompt/referenceImages），
// 角色另经 referenceMetadata 落到参考图 artifact 的 referenceRole。
//
// 认证立场（2026-08-15 修正）：generation-jobs 与 generate-images 的 authenticateImageUser
// 吃的都是 `Authorization: Bearer` + `x-user-id` header（与 playground 的 getStoredToken 一致），
// 不是站上 Cookie。这里不自作 Cookie 认证——原样转发两个 header，让下游
// 唯一收口验证与扣费（曾经转发 Cookie 导致整条链路必然 401）。
//
// 诚实原则：cost_coins 算不出来就给 null，绝不填 0 假装免费；count 部分成功
// 就回部分结果，不假装全成；参考图取不回来直接报错，不静默丢弃。

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { generationCapabilities, generationModel } from "@/lib/generation-model-catalog";
import { WORKFLOW_SCHEMA_VERSION, buildWorkflowPrompt, normalizeGenerationWorkflowMetadata } from "@/lib/generation-workflow";
import type { GenerationTaskProjection } from "@/lib/generation-task-types";
import type { GenerationWorkflowMetadata } from "@/lib/image-types";
import { imageGenerationCoins, type ModelMode } from "@/lib/provider-config";
import { DEFAULT_IMAGE_MODEL_ID, SUPPORTED_GENERATION_MODEL_IDS } from "@/lib/image-model-ids.js";
import { isReferenceImageRole, toReferenceImageRole, type ReferenceImageRole } from "@/lib/image-types";
import {
  applyProjectStyle,
  normalizeProjectStyleId,
  resolveProjectStyle,
  type AppliedStyleSource,
} from "@/lib/canvas/project-style";
import { syncModelPricing } from "@/lib/pricing-runtime";
import { GENERATION_TRACE_ID_HEADER, resolveGenerationTraceId } from "@/lib/generation-request-headers";

export const runtime = "nodejs";
export const maxDuration = 300;
export const preferredRegion = "sfo1"; // 与 VPS（闸道/控制面 DB，矽谷）同区：每次上游往返省一趟横跨美国（2026-10-01 效能审计）

export interface CanvasGenerateRequest {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  count?: number;
  source_image?: string | null;
  reference_image_urls?: string[];
  /**
   * 语义参考图（2026-08-22）：带角色的 reference 节点输出。
   * 与 reference_image_urls 并存（后者无角色，视为 general）。
   */
  reference_images?: { url?: unknown; role?: unknown; name?: unknown }[];
  /**
   * 负面词（P2 角色/场景卡）：与参考图角色一起走既有 workflow 链路
   * （generate-images 的 buildWorkflowPrompt 会写成 "Avoid:" 段）。
   */
  negative_prompt?: string;
  /**
   * 风格（P1-8／对称差 D34）：**风格是可引用的一等 id**（`STYLE_LIBRARY` 的 id，
   * 例 `ads-advertising`）——对手 `CreateProject.VisualPromptId` 的对应物。
   * 伺服器端把 id 展开成风格全文并入 prompt／负面词（对手 `VisualMeta.VisualStyle` 全文
   * 素材化的那一步），所以风格不再只是前端把字串拼进 prompt 的行为。
   * 未知 id ⇒ 400 `style_id_unknown`（提交上游前挡，不烧钱）；不带 ⇒ 逐位零回归。
   */
  style_id?: string;
  /**
   * LoRA（2026-08-27 自专业工作站迁入）：选中的 LoRA 模型版本 id，
   * 单选；转发 generate-images 的 loraModelVersionIds（JSON 阵列字串）。
   * 模型不支援时由 generate-images 的能力归一裁掉。
   */
  loraModelVersionIds?: string[];
}

export interface CanvasImageResult {
  url: string;
  cost_coins: number | null;
  natural_width: number | null;
  natural_height: number | null;
  /**
   * 产出本张图的 durable generation job id（`GET /api/generation-jobs/{id}` 可查真参数）；
   * legacy generate-images 路径没有 job＝null（不编造）。前端落为节点 `metadata.imageTaskId`。
   */
  task_id: string | null;
}

export interface CanvasGenerateResponse {
  ok: boolean;
  task_id?: string | null;
  images?: CanvasImageResult[];
  error?: string;
  code?: string;
  /** 本次生成实际套用的风格 id（null＝未套风格）。 */
  style_id?: string | null;
  /** 风格来源：`request`／`none`（专案绑定由呼叫端带 id，故此层只会回这两种）。 */
  style_source?: AppliedStyleSource;
}

/** 单次生成最多带的参考图张数（含 source_image）。 */
const MAX_REFERENCE_IMAGES = 5;
/** 参考图单张大小上限（bytes）。 */
const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;
/** 参考图取回逾时（ms）。 */
const REFERENCE_FETCH_TIMEOUT_MS = 10_000;

// ── durable job 轮询参数（照 openai-compat/generation.ts:63-66 的惯例） ──
const POLL_INTERVAL_MS = 2_500;
const POLL_INTERVAL_MAX_MS = 5_000;
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_REQUEST_TIMEOUT_MS = 15_000;
/** 总等待上限：maxDuration 减 20s 余裕（从请求进站起算，含参考图取回）。 */
const WAIT_BUDGET_MS = (maxDuration - 20) * 1000;
/** durable persistReferences 的限制（generation-jobs/route.ts:31 + validateImageBuffer）。 */
const DURABLE_REFERENCE_MAX_BYTES = 12 * 1024 * 1024;
const DURABLE_REFERENCE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const FAILED_TASK_STATUSES = new Set(["failed", "cancelled", "refunded", "unknown"]);

/** 等待超过上限：任务仍在跑，不取消。 */
class CanvasJobWaitTimeout extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(status: number, message: string, code: string): NextResponse<CanvasGenerateResponse> {
  return NextResponse.json({ ok: false, error: message, code }, { status });
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 参考图 URL → Buffer。https 取回（限时/限量/验 content-type）；data:image 直接解码。 */
async function fetchReferenceBuffer(url: string): Promise<{ buffer: Buffer; mime: string }> {
  if (url.startsWith("data:image/")) {
    const comma = url.indexOf(",");
    if (comma < 0) throw new Error("data URL 格式无效");
    const meta = url.slice(5, comma); // e.g. "image/png;base64"
    const mime = meta.split(";")[0] || "image/png";
    const buffer = Buffer.from(url.slice(comma + 1), "base64");
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_REFERENCE_BYTES) {
      throw new Error("data URL 图片为空或超过 15MB");
    }
    return { buffer, mime };
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(REFERENCE_FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`上游返回 ${res.status}`);
  const mime = res.headers.get("content-type") ?? "";
  if (!mime.startsWith("image/")) throw new Error(`不是图片（${mime || "无 content-type"}）`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_REFERENCE_BYTES) {
    throw new Error("图片为空或超过 15MB");
  }
  return { buffer, mime };
}

export async function POST(req: NextRequest) {
  const deadlineAt = Date.now() + WAIT_BUDGET_MS;
  // 认证前置检查：缺 header 直接 401，省一次下游往返。真正验证在下游（generation-jobs／generate-images）。
  const authorization = req.headers.get("authorization");
  const userId = req.headers.get("x-user-id") ?? req.headers.get("new-api-user");
  if (!authorization || !userId) {
    return fail(401, "请先登录再生成图片。", "unauthorized");
  }

  let body: CanvasGenerateRequest;
  try {
    body = (await req.json()) as CanvasGenerateRequest;
  } catch {
    return fail(400, "请求体必须是合法 JSON", "invalid_json");
  }

  if (!body.prompt || typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return fail(400, "缺少 prompt", "missing_prompt");
  }
  if (body.prompt.length > 4000) {
    return fail(400, "prompt 过长", "prompt_too_long");
  }

  const modelId = body.model ?? DEFAULT_IMAGE_MODEL_ID;
  if (!(SUPPORTED_GENERATION_MODEL_IDS as readonly string[]).includes(modelId) || generationModel(modelId)?.kind === "video") {
    return fail(400, `不支持的模型：${truncate(modelId, 60)}`, "unsupported_model");
  }

  const count = Math.min(Math.max(1, Math.round(body.count ?? 1)), 4);
  const aspectRatio = body.size ?? "1:1";
  const qualityMode: ModelMode = body.quality === "high" || body.quality === "quality" ? "quality" : "fast";
  // P2：卡锁定的负面词（可选；空字串 = 未带，行为与旧路径一致）。
  const rawNegativePrompt =
    typeof body.negative_prompt === "string" ? body.negative_prompt.trim().slice(0, 1000) : "";

  // 风格素材化（P1-8／D34）：`style_id` 是**一等 id**，伺服器端展开成风格全文。
  // 未知 id 具名 400（在提交上游前挡）；无 id ⇒ prompt／负面词逐位不变（零回归）。
  //
  // 为什么生成路由不自己去读专案绑定（`CanvasProject.styleId`）：本路由的认证立场是
  // **原样转发 header、由下游唯一收口验证与扣费**（见档头）；按未经上游验证的 x-user-id
  // 去读别人的专案，等于开一条跨租户读取。而风格注册表（`STYLE_LIBRARY`）是**静态**的，
  // 所以「专案级绑定」以 `CanvasProject.styleId` 持久化（随专案存档／汇出／agent op 走），
  // 由呼叫端带 id 进来；本层只负责「id → 全文」的素材化与值域把关。
  const rawStyleId = typeof body.style_id === "string" ? body.style_id.trim() : "";
  if (rawStyleId && !normalizeProjectStyleId(rawStyleId)) {
    return fail(400, `未知的风格 id：${truncate(rawStyleId, 60)}`, "style_id_unknown");
  }
  const appliedStyle = applyProjectStyle({
    style: resolveProjectStyle({ requestStyleId: rawStyleId }),
    prompt: body.prompt.trim(),
    negativePrompt: rawNegativePrompt,
  });
  /** 已素材化的提示词（含风格全文；无风格＝与改动前逐位相同）。 */
  const styledPrompt = appliedStyle.prompt;
  /** 已合并的负面词；空字串＝不带（保持既有的 falsy 判准）。 */
  const negativePrompt = appliedStyle.negativePrompt ?? "";
  // LoRA（2026-08-27）：最多 1 个（单选铁律，与专业工作站/generation-jobs 同款）。
  const loraModelVersionIds = Array.isArray(body.loraModelVersionIds)
    ? body.loraModelVersionIds.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 1)
    : [];

  // 参考图：source_image 排首位，语义参考图（带角色）与 @引用其后；
  // 只收 https/data:image，最多 5 张。角色走 workflow.referenceImages 既有链路
  // （generate-images 的 buildWorkflowPrompt 会把「name as role」写进最终 prompt）。
  interface RefSpec {
    url: string;
    role: ReferenceImageRole;
    name: string;
  }
  const refSpecs: RefSpec[] = [];
  if (body.source_image && typeof body.source_image === "string") {
    refSpecs.push({ url: body.source_image, role: "general", name: "source-image" });
  }
  for (const ref of Array.isArray(body.reference_images) ? body.reference_images : []) {
    if (!ref || typeof ref.url !== "string") continue;
    if (!(ref.url.startsWith("https:") || ref.url.startsWith("data:image/"))) continue;
    refSpecs.push({
      url: ref.url,
      role: isReferenceImageRole(ref.role) ? ref.role : toReferenceImageRole(ref.role),
      name:
        typeof ref.name === "string" && ref.name.trim()
          ? truncate(ref.name.trim(), 60)
          : "reference-" + String(refSpecs.length + 1),
    });
  }
  for (const url of body.reference_image_urls ?? []) {
    if (typeof url === "string" && (url.startsWith("https:") || url.startsWith("data:image/"))) {
      refSpecs.push({ url, role: "general", name: "reference-" + String(refSpecs.length + 1) });
    }
  }
  // 同 URL 去重后限量。
  const seenRefUrls = new Set<string>();
  const limitedRefSpecs = refSpecs
    .filter((r) => {
      if (seenRefUrls.has(r.url)) return false;
      seenRefUrls.add(r.url);
      return true;
    })
    .slice(0, MAX_REFERENCE_IMAGES);

  const referenceBuffers: { buffer: Buffer; mime: string }[] = [];
  for (const spec of limitedRefSpecs) {
    try {
      referenceBuffers.push(await fetchReferenceBuffer(spec.url));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fail(400, `参考图获取失败（${truncate(spec.url, 80)}）：${truncate(reason, 100)}`, "reference_fetch_failed");
    }
  }

  // 有任何非 general 角色或负面词才带 workflow（两者皆无时请求位元组与旧路径完全一致，零行为漂移）。
  const roleMetadata = limitedRefSpecs
    .filter((r) => r.role !== "general")
    .map((r) => ({ name: r.name, role: r.role }));
  const workflowField =
    roleMetadata.length > 0 || negativePrompt
      ? JSON.stringify({
          schemaVersion: 2,
          ...(roleMetadata.length > 0 ? { referenceImages: roleMetadata } : {}),
          ...(negativePrompt ? { negativePrompt } : {}),
        })
      : undefined;

  // 展示价：与扣费同源（syncModelPricing 先灌 admin 覆写）。算不出 → null，不骗 0。
  let costCoins: number | null = null;
  try {
    await syncModelPricing();
    const coins = imageGenerationCoins(modelId, qualityMode);
    costCoins = Number.isFinite(coins) ? coins : null;
  } catch {
    costCoins = null;
  }

  // R5：站内生成呼叫沿用同一个 trace id。inbound 有合法 X-Request-Id 就原样沿用，
  // 否则新生成——下游 legacy /api/generate-images、/api/generation-jobs 提交与轮询
  // 共用这一个 id，整条链在日志与帐本里可串；重试同一逻辑请求时 id 不变。
  const forwardHeaders: Record<string, string> = {
    Authorization: authorization,
    "x-user-id": userId,
    [GENERATION_TRACE_ID_HEADER]: resolveGenerationTraceId(req),
  };

  /** 单次呼叫 legacy generate-images（仅限档头列出的 durable 不支援情境）：有参考图走 multipart（File 每次重建），否则 JSON。 */
  const generateLegacyOnce = async (): Promise<CanvasImageResult> => {
    let res: Response;
    if (referenceBuffers.length > 0) {
      const form = new FormData();
      form.append("prompt", styledPrompt);
      form.append("provider", "image_eimu");
      form.append("modelId", modelId);
      form.append("qualityMode", qualityMode);
      form.append("aspectRatio", aspectRatio);
      // 参考图角色（reference 节点语义）：交给 generate-images 的既有
      // workflow.referenceImages 链路 → buildWorkflowPrompt 写进最终 prompt。
      if (workflowField) form.append("workflow", workflowField);
      // LoRA 走 generate-images 的既有 form 栏位（JSON 阵列字串）。
      if (loraModelVersionIds.length > 0) form.append("loraModelVersionIds", JSON.stringify(loraModelVersionIds));
      referenceBuffers.forEach((ref, i) => {
        form.append(
          "referenceImages",
          new File([new Uint8Array(ref.buffer)], `ref-${i}.png`, { type: ref.mime || "image/png" }),
        );
      });
      res = await fetch(`${req.nextUrl.origin}/api/generate-images`, {
        method: "POST",
        headers: forwardHeaders,
        body: form,
      });
    } else {
      res = await fetch(`${req.nextUrl.origin}/api/generate-images`, {
        method: "POST",
        headers: { ...forwardHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: styledPrompt,
          provider: "image_eimu",
          modelId,
          qualityMode,
          aspectRatio,
          // JSON body 的 workflow 栏位 generate-images 同样接收（字串会被
          // readWorkflowMetadata 解析）；无卡负面词时不带，位元组不变。
          ...(workflowField ? { workflow: workflowField } : {}),
          ...(loraModelVersionIds.length > 0 ? { loraModelVersionIds } : {}),
        }),
      });
    }

    const data = (await res.json().catch(() => null)) as
      | { imageUrl?: string | null; image?: string | null; error?: string }
      | null;
    if (!res.ok) {
      throw new Error(data?.error ? truncate(data.error, 200) : `生成服务返回 ${res.status}`);
    }
    const url = data?.imageUrl || (data?.image ? `data:image/png;base64,${data.image}` : "");
    if (!url) throw new Error("生成服务未返回图片");
    return { url, cost_coins: costCoins, natural_width: null, natural_height: null, task_id: null };
  };

  // ── 路径判定：durable 为预设；只有 durable 不支援的栏位才留在 legacy（见档头 ①②③）。
  const capabilities = generationCapabilities(modelId);
  const useLegacy =
    loraModelVersionIds.length > 0 ||
    (referenceBuffers.length > 0 && capabilities?.referenceImages === false) ||
    referenceBuffers.some(
      (ref) =>
        ref.buffer.byteLength > DURABLE_REFERENCE_MAX_BYTES ||
        !DURABLE_REFERENCE_MIMES.has(ref.mime.split(";")[0].trim().toLowerCase()),
    );

  // durable 路径：负面词/角色由 legacy 同一函式预组进 prompt（与 generate-images:493 位元组一致）。
  const workflowMetadata = workflowField
    ? normalizeGenerationWorkflowMetadata({
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        ...(JSON.parse(workflowField) as GenerationWorkflowMetadata),
      })
    : undefined;
  const durablePrompt = buildWorkflowPrompt(styledPrompt, workflowMetadata);
  // 与 legacy 同一解析度推导（generate-images：quality→2k、fast→1k，再由目录归一）。
  const outputResolution = qualityMode === "quality" ? "2k" : "1k";
  const batchId = randomUUID();

  /** 单张 durable：提交 → 轮询 → 取件。超时抛 CanvasJobWaitTimeout，不取消任务。 */
  const generateDurableOnce = async (index: number): Promise<CanvasImageResult> => {
    let submitBody: BodyInit;
    const submitHeaders: Record<string, string> = { ...forwardHeaders, "Idempotency-Key": `canvas-${batchId}-${index}` };
    if (referenceBuffers.length > 0) {
      const form = new FormData();
      form.append("prompt", durablePrompt);
      form.append("modelId", modelId);
      form.append("qualityMode", qualityMode);
      form.append("aspectRatio", aspectRatio);
      form.append("outputResolution", outputResolution);
      form.append(
        "referenceMetadata",
        JSON.stringify(limitedRefSpecs.map((spec) => ({ name: spec.name, role: spec.role }))),
      );
      referenceBuffers.forEach((ref, i) => {
        form.append(
          "referenceImages",
          new File([new Uint8Array(ref.buffer)], `ref-${i}.png`, { type: ref.mime || "image/png" }),
          limitedRefSpecs[i]?.name ?? `ref-${i}.png`,
        );
      });
      submitBody = form;
    } else {
      submitHeaders["Content-Type"] = "application/json";
      submitBody = JSON.stringify({ prompt: durablePrompt, modelId, qualityMode, aspectRatio, outputResolution });
    }

    const submitRes = await fetch(`${req.nextUrl.origin}/api/generation-jobs`, {
      method: "POST",
      headers: submitHeaders,
      body: submitBody,
      signal: AbortSignal.timeout(Math.max(1, Math.min(SUBMIT_TIMEOUT_MS, deadlineAt - Date.now()))),
    });
    const submitted = (await submitRes.json().catch(() => null)) as
      | { data?: GenerationTaskProjection; error?: string; code?: string }
      | null;
    if (!submitRes.ok || !submitted?.data || typeof submitted.data.taskId !== "string") {
      throw new Error(submitted?.error ? truncate(submitted.error, 200) : `任务提交失败（${submitRes.status}）`);
    }

    let task: GenerationTaskProjection = submitted.data;
    let interval = POLL_INTERVAL_MS;
    while (task.status !== "succeeded" && !FAILED_TASK_STATUSES.has(task.status)) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new CanvasJobWaitTimeout(task.taskId);
      await sleep(Math.min(interval, remaining));
      if (deadlineAt - Date.now() <= 0) throw new CanvasJobWaitTimeout(task.taskId);
      let pollRes: Response;
      try {
        pollRes = await fetch(`${req.nextUrl.origin}/api/generation-jobs/${encodeURIComponent(task.taskId)}`, {
          headers: forwardHeaders,
          cache: "no-store",
          signal: AbortSignal.timeout(Math.max(1, Math.min(POLL_REQUEST_TIMEOUT_MS, deadlineAt - Date.now()))),
        });
      } catch {
        // 网路断/逾时：任务仍在跑，退避后再问（不把任务误判为失败）。
        interval = Math.min(Math.round(interval * 1.5), POLL_INTERVAL_MAX_MS);
        continue;
      }
      if (pollRes.status >= 500 || pollRes.status === 429) {
        interval = Math.min(Math.round(interval * 1.5), POLL_INTERVAL_MAX_MS);
        continue;
      }
      const polled = (await pollRes.json().catch(() => null)) as (GenerationTaskProjection & { error?: string }) | null;
      if (!pollRes.ok) {
        throw new Error(polled?.error ? truncate(polled.error, 200) : `任务查询失败（${pollRes.status}）`);
      }
      if (!polled || typeof polled.taskId !== "string" || typeof polled.status !== "string") {
        interval = Math.min(Math.round(interval * 1.5), POLL_INTERVAL_MAX_MS);
        continue;
      }
      task = polled;
      interval = POLL_INTERVAL_MS;
    }

    if (task.status !== "succeeded") {
      throw new Error(truncate(task.errorMessage || `生成任务结束于 ${task.status}`, 200));
    }
    const url = task.results?.[0]?.url;
    if (!url) throw new Error("生成服务未返回图片");
    return { url, cost_coins: costCoins, natural_width: null, natural_height: null, task_id: task.taskId };
  };

  const settled = await Promise.allSettled(
    Array.from({ length: count }, (_, index) => (useLegacy ? generateLegacyOnce() : generateDurableOnce(index))),
  );
  const images = settled
    .filter((s): s is PromiseFulfilledResult<CanvasImageResult> => s.status === "fulfilled")
    .map((s) => s.value);

  if (images.length === 0) {
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    if (rejected.some((s) => s.reason instanceof CanvasJobWaitTimeout)) {
      return fail(504, "生成仍在进行中，已超过等待上限；任务未取消，完成后可在生成记录中查看。", "generation_timeout");
    }
    const firstError = rejected[0];
    const reason = firstError?.reason instanceof Error ? firstError.reason.message : "生成请求失败，请稍后再试";
    return fail(502, truncate(reason, 200), "generation_failed");
  }

  // 明示用了哪个风格（不静默）。**没套风格时不吐这两个键**——与本档「无风格的请求
  // 逐位元组不变」的既有纪律一致（旧客户端看到的回应形状一字不改）。
  return NextResponse.json<CanvasGenerateResponse>({
    ok: true,
    // 顶层 task_id＝首张图的 job id（旧客户端只读顶层）；逐张以 images[i].task_id 为准。
    task_id: images[0]?.task_id ?? null,
    images,
    ...(appliedStyle.styleId
      ? { style_id: appliedStyle.styleId, style_source: appliedStyle.styleSource }
      : {}),
  });
}
