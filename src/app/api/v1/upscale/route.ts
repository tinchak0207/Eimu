// POST /v1/upscale — B 端高清放大。
//
// 2026-08-05：原先只在 VPS 上，且扣費空轉（見 pixai-proxy.ts 頭部說明）。
// 定價走 generationCoins(pixai-upscale)，與 admin 覆寫層同源。
// 錯誤體與 trace id 與 /v1/images/generations 對齊。
//
// ── 後端（2026-09-30 暴君指令「4k超分可以走 gpt image 2 執行超分」）────────────
// 事實：① PixAI 渠道已死（當日裁定，站點風控），legacy 後端只會回 502；
//      ② 4K 檔位在 legacy 後端上本來就卡 `factor=4` 未校準（fail-closed）。
// 新後端＝**gpt-image-2 生成式重繪**：把原圖當參考圖、走 durable `image_edit` 任務，
// 檔位挑 `resolution`（1k／2k／4k）、原圖比例挑 `ratio`——上游變體名即
// `firefly-gpt-image-{resolution}-{ratio}`（`generation-core/adobe2api-upstream.ts:82`），
// 由**檔位×比例**決定輸出變體，不看像素 `size`。
//
// **語義變了，必須說清楚**：這不是保真的像素放大（不是原圖 ×N），是**重新繪製**——
// 內容會被模型重畫一遍，細節可能與原圖不同。文件（`/v1/openapi.json`）同步改成這個口徑。
//
// **默認仍是 legacy（PixAI bridge）**：換後端會把成本從 `pixai-upscale` 的一口價
// 0.001 币變成 gpt-image-2 的檔位價（catalog：1k=10／2k=20／4k=80 币）。那是**定價決策**，
// 未經裁定不得擅自切換（2026-09-27 付費硬閘）。切換＝控面設 `UPSCALE_BACKEND=gpt-image-2`。

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { after } from "next/server";
import { authenticateBizApiKey, flushBizApiKeyUsage, recordBizApiKeyUsage } from "@/lib/biz-api-key-store";
import { readBearerToken } from "@/lib/biz-api-keys";
import { declaredUpscaleTiers, generationCoins } from "@/lib/generation-model-catalog";
import { PIXAI_UPSCALE_MODEL_ID } from "@/lib/image-model-ids.js";
import {
  UPSCALE_AWAIT_MS,
  UPSCALE_POLL_INTERVAL_MAX_MS,
  UPSCALE_POLL_INTERVAL_MS,
  planGptImageUpscale,
  resolveUpscaleBackend,
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
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

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

  // 認證成功後的所有回應（成功 + 錯誤）都帶限流預測頭；401/403/429 不走這裡。
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

  // 超分檔位（P1-4）：`size` 在此入口是**檔位**語義（1k／2k／4k）；像素尺寸寫法
  // （"1024x1024"）只作計費提示。舊碼 `body.size === "2k" ? "2k" : "1k"` 讓
  // `size:"4k"` 靜默降級成 1k——本刀改成具名拒絕／具名檔位契約。
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

  // ── 後端（預設 legacy PixAI bridge；切 gpt-image-2 需控面設 env）──────────────
  const backend = resolveUpscaleBackend();
  let plan: GptImageUpscalePlan | null = null;
  let reference: GenerationReference | null = null;
  if (backend === "gpt-image-2") {
    if (!generationControlPlaneEnabled()) {
      // 沒有控制面（＝沒有 durable 任務與 DB）就沒有這條後端：具名拒，不假裝成功。
      return respond(
        pixaiRequestError(
          `超分後端 gpt-image-2 需要生成控制面（GENERATION_CONTROL_PLANE_ENABLED=true 且 GENERATION_DATABASE_URL 已配置）。`,
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
      // 未驗證的 檔位×比例 組合：具名拒（不靜默降級成較低檔位、不拿客戶的錢賭上游收得下）。
      return respond(pixaiRequestError(planned.message, planned.code, traceId), 400);
    }
    plan = planned.plan;
    // 誠實預檢（碰額度之前）：跑完 job 才發現沒有該 比例×檔位 的 image_edit 渠道，
    // 就是「先扣費、進場才失敗退款」的殭屍往返。與提交同參數（ratio×resolution）。
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
          `超分後端 ${plan.modelId} 沒有 ${plan.ratio}×${plan.resolution} 的改圖渠道`
            + `（image_edit capability 不存在或已停用）——不販售沒有供給的檔位。`,
          "upscale_backend_capability_missing",
          traceId,
        ),
        400,
      );
    }
    // 參考圖解析同樣放在扣費之前：非法 image（400／413）不該先動錢再退錢。
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
  const quota = Math.round(generationCoins(PIXAI_UPSCALE_MODEL_ID, { resolution: size }) * QUOTA_PER_COIN);

  // ── 冪等（reserveSyncCharge 之前）：同 key 重試不重複扣費 ──────
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

  // 錢走生產平面帳本（V-07）：同步 job 列 + billing_operation，失敗退款可被 reconcile 撈回。
  const charged = await reserveSyncCharge({
    userId: auth.key.userId,
    quota,
    keyId: auth.key.id,
    action: "upscale",
    modelId: PIXAI_UPSCALE_MODEL_ID,
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
    // factor 由檔位契約決定（1k／2k⇒2、4k⇒4），不再吃呼叫端任意倍率。
    factor: submission.factor,
    ratio: typeof body.ratio === "string" ? body.ratio : undefined,
    // 只送 bridge 白名單內的 size；4K 靠 (size="2k", factor=4) 表達——
    // 送 "4k" 會被上游靜默回退 1k（見 upscale-tier.ts 檔頭）。
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

// ── 後端二：gpt-image-2 生成式重繪（durable image_edit 任務，同步等待）─────────

type UpscaleCharge = SyncCharge;

interface UpscaleDeliverContext {
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
 * 交付（2026-09-30）：把原圖當參考圖提交 durable `image_edit`，同步等到終態再回
 * `{ created, data: [...] }`（＝對外文件 `SyncImageResponse`；呼叫端契約不變）。
 *
 * 為什麼用 `billingAmount: 0` 提交：**錢已經在這一層收過了**（`reserveSyncCharge`
 * 的同步 job 列＋billing_operation）。讓 job 再記一次金額＝同一筆請求扣兩次。
 * 交付後由本層 commit、失敗由本層 refund，帳仍然只有一本（同 quota-precheck 的 0 額提交手法）。
 *
 * 任務不取消：超時只是本層放棄等待，任務仍在控面後台跑（與 openai-compat 同政策）。
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
      billingAmount: 0,
      workflow: { references: [ctx.reference], prompt: ctx.plan.prompt },
    });
    jobId = submitted.job.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[upscale] gpt-image-2 submit failed key=${ctx.key.id}`, error);
    await refundUpscaleDelivery(ctx.charged.charge, 502, `submit failed: ${message}`);
    return ctx.respond(pixaiRequestError(`超分任務提交失敗：${message}`, "upscale_backend_submit_failed", ctx.traceId), 502);
  }

  const settled = await awaitUpscaleJob(jobId, tenantId);
  if (settled.kind === "succeeded") {
    // `data` 逐項帶 width/height：檔位是不是真的交付到（4K＝長邊 ≥3840）由呼叫端可自證，不必信文案。
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
        `超分超時：任務 ${jobId} 仍在後台執行，可稍後以 GET /v1/images/${jobId} 查詢；本次未交付，已提交退款。`,
        "upscale_backend_timeout",
        ctx.traceId,
      ),
      504,
    );
  }

  await refundUpscaleDelivery(ctx.charged.charge, 502, `task ${jobId} ${settled.status}: ${settled.message}`);
  return ctx.respond(
    pixaiRequestError(
      `超分任務 ${jobId} 未交付（${settled.status}）：${settled.message}；已提交退款。`,
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
 * 本地輪詢 durable 任務到終態（直讀 DB，不繞 HTTP）：控面自己承載這條路由，
 * 沒有理由再對自己做一次帶鑑權的 HTTP 往返。終態判定用既有 `taskStatus`
 * （唯一狀態映射真源），查詢本身失敗只拉長間隔、不當終態（同 openai-compat 政策）。
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
          message: job.failureDetail?.trim() || "生成失敗，未出圖。",
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

/** 同步超分交付成功：commit 實耗 + 用量記帳 + 冪等快取（兩條後端共用同一結算）。 */
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

/** 同步超分交付失敗：先落 pending refund op、job → failed，再嘗試外部退款（reconcile 可補退）。 */
async function refundUpscaleDelivery(charge: UpscaleCharge, status: number, detail?: string): Promise<void> {
  after(await refundSyncCharge(charge, { status, ...(detail ? { detail } : {}) }));
}
