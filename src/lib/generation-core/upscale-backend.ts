/**
 * 超分後端選擇與參數規劃（`/v1/upscale` 的第二條後端）。
 *
 * ── 為什麼有這條後端（2026-09-30 暴君指令「4k超分可以走 gpt image 2 執行超分」）──
 * ① PixAI 渠道當日已死（站點風控加強）——legacy 後端（`proxyPixai("upscale")`）只會回 502；
 * ② 4K 檔位在 legacy 後端上本來就卡 `factor=4` 未校準（見 `upscale-tier.ts` 檔頭）。
 * 因此 4K 超分改由 **gpt-image-2 生成式重繪**承接：原圖當參考圖提交 durable
 * `image_edit` 任務，檔位挑輸出解析度、原圖比例挑可提交比例——上游變體名即
 * `firefly-gpt-image-{resolution}-{ratio}`（`generation-core/adobe2api-upstream.ts:82`，
 * `resolveAdobe2ApiImageModelId`）。**變體由 檔位×比例 決定，不看像素 `size`。**
 *
 * ── 語義（必須對外說清楚，不可含糊）──────────────────────────────────────────
 * 這**不是保真像素放大**（不是原圖 ×N），是**重新繪製**：內容會被模型重畫一遍，
 * 細節可能與原圖不同。所以回應必須帶實測 `width/height` 供呼叫端自證，
 * 而且 4K 未校準前照樣 fail-closed（`upscale_4k_upstream_unverified`）。
 *
 * ── 錢的邊界（違反＝事故）──────────────────────────────────────────────────
 * 換後端會把單次成本從 `pixai-upscale` 的一口價 0.001 币變成 gpt-image-2 的檔位價
 * （catalog：1k=10／2k=20／4k=80 币）。這是**定價決策**，未經暴君裁定不得擅自切換
 * （2026-09-27 付費硬閘）。故默認＝legacy，切換要控面逐字設 `UPSCALE_BACKEND=gpt-image-2`。
 *
 * 本檔被 route import，故**不可**放進 route 檔（Next.js 15 只允許 route 檔匯出
 * handler 與 config；多餘匯出會讓 `next build` 的型別檢查直接失敗，2026-09-30 實錘）。
 */

import { generationModel, imageSizeForAspectRatio } from "../generation-model-catalog";
import { aspectRatioValue, nearestAspectRatio } from "../generation-model-catalog/resolution";
import type { AspectRatio } from "../generation-model-catalog/types";
import { DEFAULT_IMAGE_MODEL_ID } from "../image-model-ids.js";

export type UpscaleBackend = "pixai-bridge" | "gpt-image-2";

/** 切換後端的 env 名（控面）：只有逐字 `gpt-image-2` 才切，其餘（含未設）＝legacy。 */
export const UPSCALE_BACKEND_ENV = "UPSCALE_BACKEND";

/** 新後端跑的平台模型（上游變體名 = `firefly-gpt-image-{resolution}-{ratio}`）。 */
export const UPSCALE_BACKEND_MODEL_ID = DEFAULT_IMAGE_MODEL_ID;

export function resolveUpscaleBackend(env: NodeJS.ProcessEnv = process.env): UpscaleBackend {
  return (env[UPSCALE_BACKEND_ENV] ?? "").trim().toLowerCase() === "gpt-image-2" ? "gpt-image-2" : "pixai-bridge";
}

/** 等待 durable 任務的預算（同 openai-compat 的 240s：函數 300s 留 60s 結算餘裕）。 */
export const UPSCALE_AWAIT_MS = 240_000;
export const UPSCALE_POLL_INTERVAL_MS = 2_500;
export const UPSCALE_POLL_INTERVAL_MAX_MS = 5_000;

/** 後端能力（`resolution`×`ratio`＝上游變體）與檔位的對應：檔位就是解析度，不加倍率。 */
export interface GptImageUpscalePlan {
  modelId: string;
  resolution: string;
  ratio: AspectRatio;
  /** 比例來源（診斷用）：顯式 `ratio`／原圖像素折算／預設。 */
  ratioSource: "explicit" | "source_pixels" | "default";
  /** 折算後與原圖比例的相對差（>0 表示畫面比例被貼近到最接近的可提交檔），0＝沒有折算。 */
  ratioDeviation: number;
  size: string;
  prompt: string;
}

/**
 * 檔位契約 → gpt-image-2 後端參數（**純函式**，測試直接斷言映射）。
 *
 * 兩個真源：① 檔位（1k／2k／4k）逐字就是 `resolution`；② 原圖比例要落在模型
 * **已宣告的 `aspectRatios`** 內——上游變體只認宣告內的比例，宣告外的比例上游拿不到，
 * 所以這裡用 `nearestAspectRatio` 貼近最接近的可提交比例，並把實際偏差回報出去
 * （不靜默：偏離時呼叫端看得到 `ratio` 與 `ratio_deviation`）。
 */
export function planGptImageUpscale(input: {
  tier: string;
  ratio?: unknown;
  sourcePixels?: { width: number; height: number } | null;
}): GptImageUpscalePlan {
  const model = generationModel(UPSCALE_BACKEND_MODEL_ID);
  const supported = (model?.aspectRatios ?? ["1:1"]) as readonly AspectRatio[];
  const explicit = typeof input.ratio === "string" ? input.ratio.trim() : "";

  let ratio: AspectRatio;
  let ratioSource: GptImageUpscalePlan["ratioSource"];
  let target: number | null = null;
  if (explicit && supported.includes(explicit as AspectRatio)) {
    ratio = explicit as AspectRatio;
    ratioSource = "explicit";
  } else {
    if (explicit) target = aspectRatioValue(explicit as AspectRatio);
    else if (input.sourcePixels) target = input.sourcePixels.width / input.sourcePixels.height;
    ratio = target === null ? "1:1" : nearestAspectRatio(target, supported);
    ratioSource = target === null ? "default" : explicit ? "explicit" : "source_pixels";
  }
  const ratioDeviation = target === null ? 0 : Math.abs(aspectRatioValue(ratio) - target) / target;

  return {
    modelId: UPSCALE_BACKEND_MODEL_ID,
    resolution: input.tier,
    ratio,
    ratioSource,
    ratioDeviation,
    size: imageSizeForAspectRatio(ratio),
    // 「一鍵超分」的提示詞：把「只提升解析度」寫死，避免模型順手重新設計畫面。
    prompt:
      `把輸入的這張圖做高清放大，輸出檔位 ${input.tier}。`
      + "嚴格保留原圖的內容、主體、構圖、比例、色彩與風格，只提升解析度與細節清晰度"
      + "（去噪、銳化邊緣、補足紋理）；不要新增、刪除或替換任何元素，不要改動畫面中的文字，不要重新設計。",
  };
}