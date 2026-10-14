// POST /v1/upscale — B 端高清放大。
//
// 2026-08-05：原先只在 VPS 上，且扣费空转（见 pixai-proxy.ts 头部说明）。
// 定价跟**后端**走（见下方「钱的边界」）；价表唯一来源仍是 generation-model-catalog，
// 与 admin 覆写层同源。
// 错误体与 trace id 与 /v1/images/generations 对齐。
//
// ── 后端（2026-09-30 暴君指令「4k超分可以走 gpt image 2 执行超分」）────────────
// 事实：① PixAI 渠道已死（当日裁定，站点风控），legacy 后端只会回 502；
//      ② 4K 档位在 legacy 后端上本来就卡 `factor=4` 未校准（fail-closed）。
// 新后端＝**gpt-image-2 生成式重绘**：把原图当参考图、走 durable `image_edit` 任务，
// 档位挑 `resolution`（1k／2k／4k）、原图比例挑 `ratio`——上游变体名即
// `firefly-gpt-image-{resolution}-{ratio}`（`generation-core/adobe2api-upstream.ts:82`），
// 由**档位×比例**决定输出变体，不看像素 `size`。
//
// **语义变了，必须说清楚**：这不是保真的像素放大（不是原图 ×N），是**重新绘制**——
// 内容会被模型重画一遍，细节可能与原图不同。文件（`/v1/openapi.json`）同步改成这个口径。
//
// **默认仍是 legacy（PixAI bridge）**；切换＝控面设 `UPSCALE_BACKEND=gpt-image-2`。
//
// ── 钱的边界（违反＝事故；2026-10-01 暴君授权「4K放大后端你自己决定 做好就行」）────
// **收费跟后端、档位走**：后端从 legacy 的一口价换成 gpt-image-2 的一次生成式重绘
// （有真实上游成本），收费就按 gpt-image-2 在该档位的 **catalog 价**（`imageCredits`
// 1k=10／2k=20／4k=80 credits ⇒ `generationCoins` 1／2／8 币）；`pixai-bridge`（legacy）
// 仍维持 `pixai-upscale` 的 0.001 币不动。
// **价表不另写**：唯一来源仍是 `generation-model-catalog`，本路由只做「后端 → 定价键 →
// 档位价」的选择（`generation-core/upscale-backend.ts` 的 `upscaleChargeQuota`／
// `upscaleChargeModelId`）。钱只在**这一层**收一次：durable 上游提交一律带
// `billingAmount: 0`（`UPSCALE_UPSTREAM_BILLING_AMOUNT`），再记一次＝双扣。

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { after } from "next/server";
import { authenticateBizApiKey, flushBizApiKeyUsage, recordBizApiKeyUsage } from "@/lib/biz-api-key-store";
import { readBearerToken } from "@/lib/biz-api-keys";
import { declaredUpscaleTiers } from "@/lib/generation-model-catalog";
import { PIXAI_UPSCALE_MODEL_ID } from "@/lib/image-model-ids.js";
import {
  UPSCALE_AWAIT_MS,
  UPSCALE_POLL_INTERVAL_MAX_MS,
  UPSCALE_POLL_INTERVAL_MS,
  UPSCALE_UPSTREAM_BILLING_AMOUNT,
  planGptImageUpscale,
  resolveUpscaleBackend,
  upscaleChargeModelId,
  upscaleChargeQuota,
  type GptImageUpscalePlan,
} from "@/lib/generation-core/upscale-backend";
import {
  jsonWithTrace,
  pixaiAuthError,
  pixaiError,
  pixaiRequestError,
  proxyPixai,
} from "@/lib/pixai-proxy";
import { EditInputError, resolveEditReference } from "@/lib/biz-image-references";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";
import { submitGenerationCommand } from "@/lib/generation-core/command-service";
import { getGenerationJobForTenant, hasGenerationCapability } from "@/lib/generation-core/job-repository";
import { taskStatus } from "@/lib/generation-core/task-response";
import type { GenerationArtifactResult, GenerationReference } from "@/lib/generation-core/types";
import type { BizApiKey } from "@/lib/biz-api-keys";
import { commitSyncCharge, refundSyncCharge, reserveSyncCharge, type SyncCharge } from "@/lib/generation-core/sync-charge";
import { resolveUpscaleSubmission, UpscaleTierError } from "@/lib/generation-core/upscale-tier";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { syncModelPricing } from "@/lib/pricing-runtime";
import { getOrCreateTraceId } from "@/lib/request-trace";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import {
  checkOrReserveSyncIdempotency,
  commitSyncIdempotency,
  computeRequestHash,
  SyncIdempotencyConflictError,
} from "@/lib/generation-core/sync-idempotency";

export const runtime = "nodejs";
export const maxDuration = 300;
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

export async function POST(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);

  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) {
    return jsonWithTrace(
      pixaiAuthError(auth.status, auth.message, auth.code, traceId),
      auth.status,
      traceId,
      auth.retryAfterSeconds ? { "Retry-After": String(auth.retryAfterSeconds) } : undefined,
    );
  }

  // 认证成功后的所有回应（成功 + 错误）都带限流预测头；401/403/429 不走这里。
  const respond = (data: unknown, status: number, headers?: Record<string, string>) =>
    addRateLimitHeaders(jsonWithTrace(data, status, traceId, headers), auth.key);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return respond(pixaiRequestError("Invalid JSON body.", "invalid_json", traceId), 400);
  }

  const image = typeof body.image === "string" ? body.image.trim() : "";
  if (!image) {
    return respond(pixaiRequestError("image is required.", "missing_image", traceId), 400);
  }

  // 超分档位（P1-4）：`size` 在此入口是**档位**语义（1k／2k／4k）；像素尺寸写法
  // （"1024x1024"）只作计费提示。旧码 `body.size === "2k" ? "2k" : "1k"` 让
  // `size:"4k"` 静默降级成 1k——本刀改成具名拒绝／具名档位契约。
  let submission: ReturnType<typeof resolveUpscaleSubmission>;
  try {
    submission = resolveUpscaleSubmission({
      declaredTiers: declaredUpscaleTiers(PIXAI_UPSCALE_MODEL_ID),
      modelId: PIXAI_UPSCALE_MODEL_ID,
      input: body,
    });
  } catch (error) {
    if (error instanceof UpscaleTierError) {
      return respond(pixaiRequestError(error.message, error.code, traceId), error.status);
    }
    throw error;
  }
  const size = submission.tier;

  // ── 后端（预设 legacy PixAI bridge；切 gpt-image-2 需控面设 env）──────────────
  const backend = resolveUpscaleBackend();
  let plan: GptImageUpscalePlan | null = null;
  let reference: GenerationReference | null = null;
  if (backend === "gpt-image-2") {
    if (!generationControlPlaneEnabled()) {
      // 没有控制面（＝没有 durable 任务与 DB）就没有这条后端：具名拒，不假装成功。
      return respond(
        pixaiRequestError(
          `超分后端 gpt-image-2 需要生成控制面（GENERATION_CONTROL_PLANE_ENABLED=true 且 GENERATION_DATABASE_URL 已配置）。`,
          "upscale_backend_unavailable",
          traceId,
        ),
        503,
      );
    }
    const planned = planGptImageUpscale({
      tier: submission.tier,
      ratio: body.ratio,
      sourcePixels: submission.requestedPixelSize,
    });
    if (!planned.ok) {
      // 未验证的 档位×比例 组合：具名拒（不静默降级成较低档位、不拿客户的钱赌上游收得下）。
      return respond(pixaiRequestError(planned.message, planned.code, traceId), 400);
    }
    plan = planned.plan;
    // 诚实预检（碰额度之前）：跑完 job 才发现没有该 比例×档位 的 image_edit 渠道，
    // 就是「先扣费、进场才失败退款」的僵尸往返。与提交同参数（ratio×resolution）。
    const capable = await hasGenerationCapability({
      modelId: plan.modelId,
      kind: "image_edit",
      ratio: plan.ratio,
      resolution: plan.resolution,
      routingClass: "generic",
    });
    if (!capable) {
      return respond(
        pixaiRequestError(
          `超分后端 ${plan.modelId} 没有 ${plan.ratio}×${plan.resolution} 的改图渠道`
            + `（image_edit capability 不存在或已停用）——不贩售没有供给的档位。`,
          "upscale_backend_capability_missing",
          traceId,
        ),
        400,
      );
    }
    // 参考图解析同样放在扣费之前：非法 image（400／413）不该先动钱再退钱。
    try {
      reference = await resolveEditReference(image, `biz:${auth.key.id}`, `biz-upscale-${randomUUID()}`);
    } catch (error) {
      if (error instanceof EditInputError) {
        return respond(pixaiRequestError(error.message, error.code, traceId), error.status);
      }
      throw error;
    }
  }

  await syncModelPricing();
  // 收费跟后端走（价表唯一来源＝generation-model-catalog）：gpt-image-2 后端按该模型的
  // 档位价（1k／2k／4k），legacy pixai-bridge 仍是一口价 0.001 币（同源价，禁另写价目）。
  const pricingModelId = upscaleChargeModelId(backend);
  const quota = upscaleChargeQuota(backend, size, QUOTA_PER_COIN);
  if (body.cap_coins != null && (typeof body.cap_coins !== "number" || !Number.isFinite(body.cap_coins) || body.cap_coins < 0 || quota / QUOTA_PER_COIN > body.cap_coins)) {
    return respond(pixaiRequestError("本次权威报价超过单请求硬预算，尚未提交且未扣费。", "task_budget_exceeded", traceId), 402);
  }

  // ── 幂等（reserveSyncCharge 之前）：同 key 重试不重复扣费 ──────
  const idempotencyKey = req.headers.get("idempotency-key")?.trim() || null;
  let reservedIdempotency: { tenantId: string; key: string } | null = null;
  if (idempotencyKey) {
    const tenantId = `biz:${auth.key.id}`;
    try {
      const outcome = await checkOrReserveSyncIdempotency({
        tenantId,
        idempotencyKey,
        requestHash: computeRequestHash(body),
      });
      if (outcome.cached) return respond(outcome.body, outcome.status);
      reservedIdempotency = { tenantId, key: idempotencyKey };
    } catch (error) {
      if (error instanceof SyncIdempotencyConflictError) {
        return respond(
          {
            error: {
              message: error.message,
              type: "invalid_request_error",
              code: "idempotency_key_conflict",
              param: null,
              trace_id: traceId,
            },
          },
          409,
        );
      }
      throw error;
    }
  }

  // 钱走生产平面帐本（V-07）：同步 job 列 + billing_operation，失败退款可被 reconcile 捞回。
  const charged = await reserveSyncCharge({
    userId: auth.key.userId,
    quota,
    keyId: auth.key.id,
    action: "upscale",
    // 帐本定价键跟后端走（显示＝实际）：gpt-image-2 后端记 gpt-image-2，legacy 记 pixai-upscale。
    modelId: pricingModelId,
    kind: "image_edit",
    source: "biz",
    tenantId: `biz:${auth.key.id}`,
    apiKeyId: auth.key.id,
    requestedCount: 1,
    resolution: size,
    ratio: typeof body.ratio === "string" ? body.ratio : null,
  });
  if (!charged.ok) return respond(charged.body, charged.status);

  if (backend === "gpt-image-2" && plan && reference) {
    return await deliverGptImageUpscale({
      plan,
      reference,
      metadata: typeof body.workflow === "object" && body.workflow ? (body.workflow as {metadata?:Record<string,unknown>}).metadata : undefined,
      key: auth.key,
      charged,
      traceId,
      respond,
      reservedIdempotency,
      idempotencyKey,
    });
  }

  const { status, data } = await proxyPixai("upscale", {
    image,
    // factor 由档位契约决定（1k／2k⇒2、4k⇒4），不再吃呼叫端任意倍率。
    factor: submission.factor,
    ratio: typeof body.ratio === "string" ? body.ratio : undefined,
    // 只送 bridge 白名单内的 size；4K 靠 (size="2k", factor=4) 表达——
    // 送 "4k" 会被上游静默回退 1k（见 upscale-tier.ts 档头）。
    size: submission.bridgeSize,
  });

  const delivered = Array.isArray((data as { data?: unknown[] } | null)?.data)
    ? (data as { data: unknown[] }).data.length
    : 0;

  if (status === 200 && delivered > 0) {
    await commitUpscaleDelivery({
      charge: charged.charge,
      keyId: auth.key.id,
      data,
      reservedIdempotency,
    });
    return respond(data, 200);
  }

  after(await refundSyncCharge(charged.charge, { status }));
  return respond(pixaiError(data, "Upscale failed.", traceId), status >= 400 ? status : 502);
}

// ── 后端二：gpt-image-2 生成式重绘（durable image_edit 任务，同步等待）─────────

type UpscaleCharge = SyncCharge;

interface UpscaleDeliverContext {
  metadata?:Record<string,unknown>;
  plan: GptImageUpscalePlan;
  reference: GenerationReference;
  key: BizApiKey;
  charged: Extract<Awaited<ReturnType<typeof reserveSyncCharge>>, { ok: true }>;
  traceId: string;
  respond: (data: unknown, status: number, headers?: Record<string, string>) => Response;
  reservedIdempotency: { tenantId: string; key: string } | null;
  idempotencyKey: string | null;
}

/**
 * 交付（2026-09-30）：把原图当参考图提交 durable `image_edit`，同步等到终态再回
 * `{ created, data: [...] }`（＝对外文件 `SyncImageResponse`；呼叫端契约不变）。
 *
 * 为什么用 `billingAmount: UPSCALE_UPSTREAM_BILLING_AMOUNT`（＝0）提交：**钱已经在这一层收过了**
 * （`reserveSyncCharge` 的同步 job 列＋billing_operation，价见 `upscaleChargeQuota`）。
 * 让 job 再记一次金额＝同一笔请求扣两次。
 * 交付后由本层 commit、失败由本层 refund，帐仍然只有一本（同 quota-precheck 的 0 额提交手法）。
 *
 * 任务不取消：超时只是本层放弃等待，任务仍在控面后台跑（与 openai-compat 同政策）。
 */
async function deliverGptImageUpscale(ctx: UpscaleDeliverContext): Promise<Response> {
  const tenantId = `biz:${ctx.key.id}`;
  let jobId: string;
  try {
    const submitted = await submitGenerationCommand({
      tenantId,
      apiKeyId: ctx.key.id,
      billingUserId: ctx.key.userId,
      source: "biz",
      idempotencyKey: ctx.idempotencyKey,
      kind: "image_edit",
      modelId: ctx.plan.modelId,
      prompt: ctx.plan.prompt,
      size: ctx.plan.size,
      ratio: ctx.plan.ratio,
      resolution: ctx.plan.resolution,
      quality: "quality",
      responseFormat: "url",
      requestedCount: 1,
      billingAmount: UPSCALE_UPSTREAM_BILLING_AMOUNT,
      workflow: { references: [ctx.reference], prompt: ctx.plan.prompt, metadata:ctx.metadata },
    });
    jobId = submitted.job.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[upscale] gpt-image-2 submit failed key=${ctx.key.id}`, error);
    await refundUpscaleDelivery(ctx.charged.charge, 502, `submit failed: ${message}`);
    return ctx.respond(pixaiRequestError(`超分任务提交失败：${message}`, "upscale_backend_submit_failed", ctx.traceId), 502);
  }

  const settled = await awaitUpscaleJob(jobId, tenantId);
  if (settled.kind === "succeeded") {
    // `data` 逐项带 width/height：档位是不是真的交付到（4K＝长边 ≥3840）由呼叫端可自证，不必信文案。
    const data = {
      created: Math.floor(Date.now() / 1000),
      data: settled.artifacts.map((artifact) => ({
        url: artifact.url,
        ...(artifact.b64Json ? { b64_json: artifact.b64Json } : {}),
        width: artifact.width,
        height: artifact.height,
        mime_type: artifact.mimeType,
      })),
      upscale: {
        tier: ctx.plan.resolution,
        model: ctx.plan.modelId,
        ratio: ctx.plan.ratio,
        ratio_source: ctx.plan.ratioSource,
        ratio_deviation: Number(ctx.plan.ratioDeviation.toFixed(4)),
        task_id: jobId,
      },
    };
    await commitUpscaleDelivery({
      charge: ctx.charged.charge,
      keyId: ctx.key.id,
      data,
      reservedIdempotency: ctx.reservedIdempotency,
    });
    return ctx.respond(data, 200);
  }

  if (settled.kind === "timeout") {
    await refundUpscaleDelivery(ctx.charged.charge, 504, `await timeout, task ${jobId}`);
    return ctx.respond(
      pixaiRequestError(
        `超分超时：任务 ${jobId} 仍在后台执行，可稍后以 GET /v1/images/${jobId} 查询；本次未交付，已提交退款。`,
        "upscale_backend_timeout",
        ctx.traceId,
      ),
      504,
    );
  }

  await refundUpscaleDelivery(ctx.charged.charge, 502, `task ${jobId} ${settled.status}: ${settled.message}`);
  return ctx.respond(
    pixaiRequestError(
      `超分任务 ${jobId} 未交付（${settled.status}）：${settled.message}；已提交退款。`,
      settled.code || "upscale_backend_failed",
      ctx.traceId,
    ),
    502,
  );
}

type UpscaleJobOutcome =
  | { kind: "succeeded"; artifacts: GenerationArtifactResult[] }
  | { kind: "timeout" }
  | { kind: "failed"; status: string; code: string; message: string };

/**
 * 本地轮询 durable 任务到终态（直读 DB，不绕 HTTP）：控面自己承载这条路由，
 * 没有理由再对自己做一次带鉴权的 HTTP 往返。终态判定用既有 `taskStatus`
 * （唯一状态映射真源），查询本身失败只拉长间隔、不当终态（同 openai-compat 政策）。
 */
async function awaitUpscaleJob(jobId: string, tenantId: string): Promise<UpscaleJobOutcome> {
  const deadlineAt = Date.now() + UPSCALE_AWAIT_MS;
  let interval = UPSCALE_POLL_INTERVAL_MS;
  for (;;) {
    if (Date.now() >= deadlineAt) return { kind: "timeout" };
    let job: Awaited<ReturnType<typeof getGenerationJobForTenant>> = null;
    try {
      job = await getGenerationJobForTenant(jobId, tenantId);
    } catch (error) {
      console.error(`[upscale] job poll failed job=${jobId}`, error);
    }
    if (job) {
      const status = taskStatus(job);
      if (status === "succeeded") {
        return { kind: "succeeded", artifacts: job.result?.artifacts ?? [] };
      }
      if (status === "failed" || status === "cancelled" || status === "refunded" || status === "unknown") {
        return {
          kind: "failed",
          status,
          code: "",
          message: job.failureDetail?.trim() || "生成失败，未出图。",
        };
      }
      interval = UPSCALE_POLL_INTERVAL_MS;
    } else {
      interval = Math.min(Math.round(interval * 1.5), UPSCALE_POLL_INTERVAL_MAX_MS);
    }
    const wait = Math.min(interval, Math.max(0, deadlineAt - Date.now()));
    if (wait <= 0) return { kind: "timeout" };
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** 同步超分交付成功：commit 实耗 + 用量记帐 + 幂等快取（两条后端共用同一结算）。 */
async function commitUpscaleDelivery(input: {
  charge: UpscaleCharge;
  keyId: string;
  data: unknown;
  reservedIdempotency: { tenantId: string; key: string } | null;
}): Promise<void> {
  after(await commitSyncCharge(input.charge, { delivered: 1 }));
  recordBizApiKeyUsage(input.keyId, 1);
  after(() => flushBizApiKeyUsage().catch(() => undefined));
  if (input.reservedIdempotency) {
    await commitSyncIdempotency({
      tenantId: input.reservedIdempotency.tenantId,
      idempotencyKey: input.reservedIdempotency.key,
      status: 200,
      body: input.data,
    }).catch((error) => {
      console.error(`[pixai] idempotency commit failed action=upscale`, error);
    });
  }
}

/** 同步超分交付失败：先落 pending refund op、job → failed，再尝试外部退款（reconcile 可补退）。 */
async function refundUpscaleDelivery(charge: UpscaleCharge, status: number, detail?: string): Promise<void> {
  after(await refundSyncCharge(charge, { status, ...(detail ? { detail } : {}) }));
}
