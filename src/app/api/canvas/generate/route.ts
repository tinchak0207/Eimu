// POST /api/canvas/generate — 畫布節點觸發的圖片生成。
//
// 與生產平面的關係（2026-09-28 V-09 修正）：這裡是畫布專用的分發薄殼。
// 預設走 durable job——每張圖 `POST /api/generation-jobs`（帶 Idempotency-Key）→
// 伺服器端輪詢 `GET /api/generation-jobs/{id}` → 取件，聚合成畫布 reducer 可直接吃的
// 陣列（回應形狀與舊版相容：只加 images[i].task_id＝durable job id，供 LOD3 工程透析回查；legacy 為 null）。同步形狀只在本層做，生產只認異步 job
// （docs/architecture/planes.md §3.3；範本 use-image-generation.ts:627、openai-compat/generation.ts）。
// 等待上限 = maxDuration − 20s；超時回 504 generation_timeout，**不取消任務**
// （job 仍在帳本裡跑完/退款，完成後出現在生成記錄）。
//
// 仍走 legacy /api/generate-images 的情境（只有這些；durable 不支援、不准靜默丟）：
//   ① 帶 LoRA——generation-core 沒有任何 adapter 消費 workflow.loraModelVersionIds；
//   ② 帶參考圖但模型能力 referenceImages === false——durable 會 400 拒單，legacy 會照送上游；
//   ③ 參考圖不是 PNG/JPEG/WEBP 或超過 12MB——durable 的 persistReferences 會拒。
// 負面詞與參考圖角色在 durable 路徑由本層用 legacy 同一函式 buildWorkflowPrompt
// 預先組進 prompt（generation-core 不消費 workflow.negativePrompt/referenceImages），
// 角色另經 referenceMetadata 落到參考圖 artifact 的 referenceRole。
//
// 認證立場（2026-08-15 修正）：generation-jobs 與 generate-images 的 authenticateImageUser
// 吃的都是 `Authorization: Bearer` + `x-user-id` header（與 playground 的 getStoredToken 一致），
// 不是站上 Cookie。這裡不自作 Cookie 認證——原樣轉發兩個 header，讓下游
// 唯一收口驗證與扣費（曾經轉發 Cookie 導致整條鏈路必然 401）。
//
// 誠實原則：cost_coins 算不出來就給 null，絕不填 0 假裝免費；count 部分成功
// 就回部分結果，不假裝全成；參考圖取不回來直接報錯，不靜默丟棄。

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
export const preferredRegion = "sfo1"; // 與 VPS（閘道/控制面 DB，矽谷）同區：每次上游往返省一趟橫跨美國（2026-10-01 效能審計）

export interface CanvasGenerateRequest {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  count?: number;
  source_image?: string | null;
  reference_image_urls?: string[];
  /**
   * 語義參考圖（2026-08-22）：帶角色的 reference 節點輸出。
   * 與 reference_image_urls 併存（後者無角色，視為 general）。
   */
  reference_images?: { url?: unknown; role?: unknown; name?: unknown }[];
  /**
   * 負面詞（P2 角色/場景卡）：與參考圖角色一起走既有 workflow 鏈路
   * （generate-images 的 buildWorkflowPrompt 會寫成 "Avoid:" 段）。
   */
  negative_prompt?: string;
  /**
   * 風格（P1-8／對稱差 D34）：**風格是可引用的一等 id**（`STYLE_LIBRARY` 的 id，
   * 例 `ads-advertising`）——對手 `CreateProject.VisualPromptId` 的對應物。
   * 伺服器端把 id 展開成風格全文併入 prompt／負面詞（對手 `VisualMeta.VisualStyle` 全文
   * 素材化的那一步），所以風格不再只是前端把字串拼進 prompt 的行為。
   * 未知 id ⇒ 400 `style_id_unknown`（提交上游前擋，不燒錢）；不帶 ⇒ 逐位零回歸。
   */
  style_id?: string;
  /**
   * LoRA（2026-08-27 自專業工作站遷入）：選中的 LoRA 模型版本 id，
   * 單選；轉發 generate-images 的 loraModelVersionIds（JSON 陣列字串）。
   * 模型不支援時由 generate-images 的能力歸一裁掉。
   */
  loraModelVersionIds?: string[];
}

export interface CanvasImageResult {
  url: string;
  cost_coins: number | null;
  natural_width: number | null;
  natural_height: number | null;
  /**
   * 產出本張圖的 durable generation job id（`GET /api/generation-jobs/{id}` 可查真參數）；
   * legacy generate-images 路徑沒有 job＝null（不編造）。前端落為節點 `metadata.imageTaskId`。
   */
  task_id: string | null;
}

export interface CanvasGenerateResponse {
  ok: boolean;
  task_id?: string | null;
  images?: CanvasImageResult[];
  error?: string;
  code?: string;
  /** 本次生成實際套用的風格 id（null＝未套風格）。 */
  style_id?: string | null;
  /** 風格來源：`request`／`none`（專案綁定由呼叫端帶 id，故此層只會回這兩種）。 */
  style_source?: AppliedStyleSource;
}

/** 單次生成最多帶的參考圖張數（含 source_image）。 */
const MAX_REFERENCE_IMAGES = 5;
/** 參考圖單張大小上限（bytes）。 */
const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;
/** 參考圖取回逾時（ms）。 */
const REFERENCE_FETCH_TIMEOUT_MS = 10_000;

// ── durable job 輪詢參數（照 openai-compat/generation.ts:63-66 的慣例） ──
const POLL_INTERVAL_MS = 2_500;
const POLL_INTERVAL_MAX_MS = 5_000;
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_REQUEST_TIMEOUT_MS = 15_000;
/** 總等待上限：maxDuration 減 20s 餘裕（從請求進站起算，含參考圖取回）。 */
const WAIT_BUDGET_MS = (maxDuration - 20) * 1000;
/** durable persistReferences 的限制（generation-jobs/route.ts:31 + validateImageBuffer）。 */
const DURABLE_REFERENCE_MAX_BYTES = 12 * 1024 * 1024;
const DURABLE_REFERENCE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const FAILED_TASK_STATUSES = new Set(["failed", "cancelled", "refunded", "unknown"]);

/** 等待超過上限：任務仍在跑，不取消。 */
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

/** 參考圖 URL → Buffer。https 取回（限時/限量/驗 content-type）；data:image 直接解碼。 */
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
  // 認證前置檢查：缺 header 直接 401，省一次下游往返。真正驗證在下游（generation-jobs／generate-images）。
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
  // P2：卡鎖定的負面詞（可選；空字串 = 未帶，行為與舊路徑一致）。
  const rawNegativePrompt =
    typeof body.negative_prompt === "string" ? body.negative_prompt.trim().slice(0, 1000) : "";

  // 風格素材化（P1-8／D34）：`style_id` 是**一等 id**，伺服器端展開成風格全文。
  // 未知 id 具名 400（在提交上游前擋）；無 id ⇒ prompt／負面詞逐位不變（零回歸）。
  //
  // 為什麼生成路由不自己去讀專案綁定（`CanvasProject.styleId`）：本路由的認證立場是
  // **原樣轉發 header、由下游唯一收口驗證與扣費**（見檔頭）；按未經上游驗證的 x-user-id
  // 去讀別人的專案，等於開一條跨租戶讀取。而風格註冊表（`STYLE_LIBRARY`）是**靜態**的，
  // 所以「專案級綁定」以 `CanvasProject.styleId` 持久化（隨專案存檔／匯出／agent op 走），
  // 由呼叫端帶 id 進來；本層只負責「id → 全文」的素材化與值域把關。
  const rawStyleId = typeof body.style_id === "string" ? body.style_id.trim() : "";
  if (rawStyleId && !normalizeProjectStyleId(rawStyleId)) {
    return fail(400, `未知的风格 id：${truncate(rawStyleId, 60)}`, "style_id_unknown");
  }
  const appliedStyle = applyProjectStyle({
    style: resolveProjectStyle({ requestStyleId: rawStyleId }),
    prompt: body.prompt.trim(),
    negativePrompt: rawNegativePrompt,
  });
  /** 已素材化的提示詞（含風格全文；無風格＝與改動前逐位相同）。 */
  const styledPrompt = appliedStyle.prompt;
  /** 已合併的負面詞；空字串＝不帶（保持既有的 falsy 判準）。 */
  const negativePrompt = appliedStyle.negativePrompt ?? "";
  // LoRA（2026-08-27）：最多 1 個（單選鐵律，與專業工作站/generation-jobs 同款）。
  const loraModelVersionIds = Array.isArray(body.loraModelVersionIds)
    ? body.loraModelVersionIds.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 1)
    : [];

  // 參考圖：source_image 排首位，語義參考圖（帶角色）與 @引用其後；
  // 只收 https/data:image，最多 5 張。角色走 workflow.referenceImages 既有鏈路
  // （generate-images 的 buildWorkflowPrompt 會把「name as role」寫進最終 prompt）。
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
  // 同 URL 去重後限量。
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

  // 有任何非 general 角色或負面詞才帶 workflow（兩者皆無時請求位元組與舊路徑完全一致，零行為漂移）。
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

  // 展示價：與扣費同源（syncModelPricing 先灌 admin 覆寫）。算不出 → null，不騙 0。
  let costCoins: number | null = null;
  try {
    await syncModelPricing();
    const coins = imageGenerationCoins(modelId, qualityMode);
    costCoins = Number.isFinite(coins) ? coins : null;
  } catch {
    costCoins = null;
  }

  // R5：站內生成呼叫沿用同一個 trace id。inbound 有合法 X-Request-Id 就原樣沿用，
  // 否則新生成——下游 legacy /api/generate-images、/api/generation-jobs 提交與輪詢
  // 共用這一個 id，整條鏈在日誌與帳本裡可串；重試同一邏輯請求時 id 不變。
  const forwardHeaders: Record<string, string> = {
    Authorization: authorization,
    "x-user-id": userId,
    [GENERATION_TRACE_ID_HEADER]: resolveGenerationTraceId(req),
  };

  /** 單次呼叫 legacy generate-images（僅限檔頭列出的 durable 不支援情境）：有參考圖走 multipart（File 每次重建），否則 JSON。 */
  const generateLegacyOnce = async (): Promise<CanvasImageResult> => {
    let res: Response;
    if (referenceBuffers.length > 0) {
      const form = new FormData();
      form.append("prompt", styledPrompt);
      form.append("provider", "image_tinchak");
      form.append("modelId", modelId);
      form.append("qualityMode", qualityMode);
      form.append("aspectRatio", aspectRatio);
      // 參考圖角色（reference 節點語義）：交給 generate-images 的既有
      // workflow.referenceImages 鏈路 → buildWorkflowPrompt 寫進最終 prompt。
      if (workflowField) form.append("workflow", workflowField);
      // LoRA 走 generate-images 的既有 form 欄位（JSON 陣列字串）。
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
          provider: "image_tinchak",
          modelId,
          qualityMode,
          aspectRatio,
          // JSON body 的 workflow 欄位 generate-images 同样接收（字串會被
          // readWorkflowMetadata 解析）；無卡負面詞時不帶，位元組不變。
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

  // ── 路徑判定：durable 為預設；只有 durable 不支援的欄位才留在 legacy（見檔頭 ①②③）。
  const capabilities = generationCapabilities(modelId);
  const useLegacy =
    loraModelVersionIds.length > 0 ||
    (referenceBuffers.length > 0 && capabilities?.referenceImages === false) ||
    referenceBuffers.some(
      (ref) =>
        ref.buffer.byteLength > DURABLE_REFERENCE_MAX_BYTES ||
        !DURABLE_REFERENCE_MIMES.has(ref.mime.split(";")[0].trim().toLowerCase()),
    );

  // durable 路徑：負面詞/角色由 legacy 同一函式預組進 prompt（與 generate-images:493 位元組一致）。
  const workflowMetadata = workflowField
    ? normalizeGenerationWorkflowMetadata({
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        ...(JSON.parse(workflowField) as GenerationWorkflowMetadata),
      })
    : undefined;
  const durablePrompt = buildWorkflowPrompt(styledPrompt, workflowMetadata);
  // 與 legacy 同一解析度推導（generate-images：quality→2k、fast→1k，再由目錄歸一）。
  const outputResolution = qualityMode === "quality" ? "2k" : "1k";
  const batchId = randomUUID();

  /** 單張 durable：提交 → 輪詢 → 取件。超時拋 CanvasJobWaitTimeout，不取消任務。 */
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
        // 網路斷/逾時：任務仍在跑，退避後再問（不把任務誤判為失敗）。
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

  // 明示用了哪個風格（不靜默）。**沒套風格時不吐這兩個鍵**——與本檔「無風格的請求
  // 逐位元組不變」的既有紀律一致（舊客戶端看到的回應形狀一字不改）。
  return NextResponse.json<CanvasGenerateResponse>({
    ok: true,
    // 頂層 task_id＝首張圖的 job id（舊客戶端只讀頂層）；逐張以 images[i].task_id 為準。
    task_id: images[0]?.task_id ?? null,
    images,
    ...(appliedStyle.styleId
      ? { style_id: appliedStyle.styleId, style_source: appliedStyle.styleSource }
      : {}),
  });
}
