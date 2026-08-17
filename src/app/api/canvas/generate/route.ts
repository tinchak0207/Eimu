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

  // 參考圖：source_image 排首位，@引用其後；只收 https/data:image，最多 5 張。
  const refUrls: string[] = [];
  if (body.source_image) refUrls.push(body.source_image);
  for (const url of body.reference_image_urls ?? []) {
    if (typeof url === "string" && (url.startsWith("https:") || url.startsWith("data:image/"))) {
      refUrls.push(url);
    }
  }
  const limitedRefUrls = refUrls.slice(0, MAX_REFERENCE_IMAGES);

  const referenceBuffers: { buffer: Buffer; mime: string }[] = [];
  for (const url of limitedRefUrls) {
    try {
      referenceBuffers.push(await fetchReferenceBuffer(url));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fail(400, `参考图获取失败（${truncate(url, 80)}）：${truncate(reason, 100)}`, "reference_fetch_failed");
    }
  }

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
