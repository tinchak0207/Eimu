// POST /api/canvas/generate — 畫布節點觸發的圖片生成。
//
// 與 /api/generate-images 的關係：這裡是畫布專用的薄殼，把畫布欄位
// （prompt / model / size / quality / count / source_image / reference_image_urls）
// 翻譯成 generate-images 的請求，並把單張回應聚合成畫布 reducer 可直接吃的陣列。
//
// 認證立場（2026-08-15 修正）：generate-images 的 authenticateImageUser 吃的是
// `Authorization: Bearer` + `x-user-id` header（與 playground 的 getStoredToken 一致），
// 不是站上 Cookie。這裡不再自作 Cookie 認證——原樣轉發兩個 header，讓下游
// 唯一收口驗證與扣費（曾經轉發 Cookie 導致整條鏈路必然 401）。
//
// 誠實原則：cost_coins 算不出來就給 null，絕不填 0 假裝免費；count 部分成功
// 就回部分結果，不假裝全成；參考圖取不回來直接報錯，不靜默丟棄。

import { NextRequest, NextResponse } from "next/server";
import { generationModel } from "@/lib/generation-model-catalog";
import { imageGenerationCoins, type ModelMode } from "@/lib/provider-config";
import { DEFAULT_IMAGE_MODEL_ID, SUPPORTED_GENERATION_MODEL_IDS } from "@/lib/image-model-ids.js";
import { isReferenceImageRole, toReferenceImageRole, type ReferenceImageRole } from "@/lib/image-types";
import { syncModelPricing } from "@/lib/pricing-runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

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
}

export interface CanvasGenerateResponse {
  ok: boolean;
  task_id?: string | null;
  images?: CanvasImageResult[];
  error?: string;
  code?: string;
}

/** 單次生成最多帶的參考圖張數（含 source_image）。 */
const MAX_REFERENCE_IMAGES = 5;
/** 參考圖單張大小上限（bytes）。 */
const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;
/** 參考圖取回逾時（ms）。 */
const REFERENCE_FETCH_TIMEOUT_MS = 10_000;

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
  // 認證前置檢查：缺 header 直接 401，省一次下游往返。真正驗證在 generate-images。
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
  const negativePrompt =
    typeof body.negative_prompt === "string" ? body.negative_prompt.trim().slice(0, 1000) : "";
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

  const forwardHeaders: Record<string, string> = {
    Authorization: authorization,
    "x-user-id": userId,
  };

  /** 單次呼叫 generate-images：有參考圖走 multipart（File 每次重建），否則 JSON。 */
  const generateOnce = async (): Promise<CanvasImageResult> => {
    let res: Response;
    if (referenceBuffers.length > 0) {
      const form = new FormData();
      form.append("prompt", body.prompt.trim());
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
          prompt: body.prompt.trim(),
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
    return { url, cost_coins: costCoins, natural_width: null, natural_height: null };
  };

  const settled = await Promise.allSettled(Array.from({ length: count }, () => generateOnce()));
  const images = settled
    .filter((s): s is PromiseFulfilledResult<CanvasImageResult> => s.status === "fulfilled")
    .map((s) => s.value);

  if (images.length === 0) {
    const firstError = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    const reason = firstError?.reason instanceof Error ? firstError.reason.message : "生成请求失败，请稍后再试";
    return fail(502, truncate(reason, 200), "generation_failed");
  }

  return NextResponse.json<CanvasGenerateResponse>({ ok: true, task_id: null, images });
}
