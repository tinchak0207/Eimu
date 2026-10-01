/**
 * 超分後端選擇與參數規劃（`/v1/upscale` 的第二條後端）。
 *
 * ── 為什麼有這條後端（2026-09-30 暴君指令「4k超分可以走 gpt image 2 執行超分」）──
 * ① PixAI 渠道當日已死（站點風控加強）——legacy 後端（`proxyPixai("upscale")`）只會回 502；
 * ② 4K 檔位在 legacy 後端上本來就卡 `factor=4` 未校準（見 `upscale-tier.ts` 檔頭）。
 * 因此 4K 超分改由 **gpt-image-2 生成式重繪**承接：原圖當參考圖提交 durable
 * `image_edit` 任務，檔位折算成像素尺寸、原圖比例挑可提交比例。
 * **檔位只在 `size` 上表達**（不是 `resolution`）——理由見下方 `planGptImageUpscale`
 * 的「檔位怎麼送到上游」節（實查實有渠道得出的結論）。
 *
 * ── 語義（必須對外說清楚，不可含糊）──────────────────────────────────────────
 * 這**不是保真像素放大**（不是原圖 ×N），是**重新繪製**：內容會被模型重畫一遍，
 * 細節可能與原圖不同。所以回應必須帶實測 `width/height` 供呼叫端自證，
 * 而且 4K 未校準前照樣 fail-closed（`upscale_4k_upstream_unverified`）。
 *
 * ── 錢的邊界（違反＝事故）──────────────────────────────────────────────────
 * **收費跟後端走（2026-10-01 暴君授權「4K放大后端你自己决定 做好就行」）**：後端既然從
 * legacy 的一口價換成 gpt-image-2 的一次生成式重繪（有真實上游成本），收費就按 gpt-image-2
 * 在該檔位的 **catalog 價**（`imageCredits` 1k=10／2k=20／4k=80 credits ⇒ `generationCoins`
 * 1／2／8 币）；legacy 仍維持 `pixai-upscale` 的 0.001 币不動。價表**不另寫**：唯一來源仍是
 * `generation-model-catalog`，本檔只做「後端 → 定價鍵 → 檔位價」的選擇（`upscaleChargeQuota`）。
 * 默認＝legacy，切換要控面逐字設 `UPSCALE_BACKEND=gpt-image-2`。
 *
 * 本檔被 route import，故**不可**放進 route 檔（Next.js 15 只允許 route 檔匯出
 * handler 與 config；多餘匯出會讓 `next build` 的型別檢查直接失敗，2026-09-30 實錘）。
 */

import { generationCoins, generationModel, imageSizeForAspectRatio } from "../generation-model-catalog";
import { aspectRatioValue, nearestAspectRatio } from "../generation-model-catalog/resolution";
import type { AspectRatio, UpscaleTier } from "../generation-model-catalog/types";
import { DEFAULT_IMAGE_MODEL_ID, PIXAI_UPSCALE_MODEL_ID } from "../image-model-ids.js";
import {
  DURABLE_IMAGE_SIZES,
  DURABLE_TIER_SCALE,
  isDurableImageSize,
  scaleDurableImageSize,
} from "./durable-image-sizes";

export type UpscaleBackend = "pixai-bridge" | "gpt-image-2";

/** 切換後端的 env 名（控面）：只有逐字 `gpt-image-2` 才切，其餘（含未設）＝legacy。 */
export const UPSCALE_BACKEND_ENV = "UPSCALE_BACKEND";

/** 新後端跑的平台模型（上游變體名 = `firefly-gpt-image-{resolution}-{ratio}`）。 */
export const UPSCALE_BACKEND_MODEL_ID = DEFAULT_IMAGE_MODEL_ID;

export function resolveUpscaleBackend(env: NodeJS.ProcessEnv = process.env): UpscaleBackend {
  return (env[UPSCALE_BACKEND_ENV] ?? "").trim().toLowerCase() === "gpt-image-2" ? "gpt-image-2" : "pixai-bridge";
}

// ── 收費（價表唯一來源＝generation-model-catalog；本節只做選擇與換算）──────────

/**
 * 收費的定價鍵（**不複製任何價目數字**，只是「後端 → 定價鍵」的選擇）：
 * - `gpt-image-2`：一次生成式重繪（真實上游成本）⇒ 定價鍵＝該模型本身，
 *   價＝gpt-image-2 在該檔位的 `imageCredits`（1k=10／2k=20／4k=80 credits）。
 * - `pixai-bridge`（legacy）：定價鍵＝`pixai-upscale`，仍是 0.001 币一口價，不被新後端打到。
 */
export function upscaleChargeModelId(backend: UpscaleBackend): string {
  return backend === "gpt-image-2" ? UPSCALE_BACKEND_MODEL_ID : PIXAI_UPSCALE_MODEL_ID;
}

/**
 * 一次超分在**同步層**（`/v1/upscale`）要預扣的 quota＝catalog 檔位價 × `quotaPerCoin`。
 * 價走 `generationCoins`／`imageCredits`／`fixedCoins`（與 admin 覆寫層同源），此處僅把
 * 「後端 → 定價鍵 → 檔位價」串起來；禁在此另寫價目（否則就是第二份價表）。
 */
export function upscaleChargeQuota(backend: UpscaleBackend, tier: UpscaleTier, quotaPerCoin: number): number {
  return Math.round(generationCoins(upscaleChargeModelId(backend), { resolution: tier }) * quotaPerCoin);
}

/**
 * 提交 durable 上游任務時帶的 `billingAmount`：**恆 0**。
 * 錢已在同步層的 `reserveSyncCharge` 收過（見 `upscaleChargeQuota`）；上游若再記一次金額
 * ＝同一筆請求扣兩次（雙扣事故）。此常數是「同一筆只收一次」契約的唯一出口，route 消費它。
 */
export const UPSCALE_UPSTREAM_BILLING_AMOUNT = 0;

/** 等待 durable 任務的預算（同 openai-compat 的 240s：函數 300s 留 60s 結算餘裕）。 */
export const UPSCALE_AWAIT_MS = 240_000;
export const UPSCALE_POLL_INTERVAL_MS = 2_500;
export const UPSCALE_POLL_INTERVAL_MAX_MS = 5_000;

/** 後端能力（`size`＋`ratio`）與檔位的對應：**檔位靠像素尺寸承載**，不加倍率。 */
export interface GptImageUpscalePlan {
  modelId: string;
  resolution: string;
  ratio: AspectRatio;
  /** 比例來源（診斷用）：顯式 `ratio`／原圖像素折算／預設。 */
  ratioSource: "explicit" | "source_pixels" | "default";
  /** 折算後與原圖比例的相對差（>0 表示畫面比例被貼近到最接近的可提交檔），0＝沒有折算。 */
  ratioDeviation: number;
  /** 送給管線的像素尺寸：**這才是檔位在實有渠道上的表達**（見檔頭「檔位怎麼送到上游」）。 */
  size: string;
  prompt: string;
}

export type GptImageUpscalePlanResult =
  | { ok: true; plan: GptImageUpscalePlan }
  | { ok: false; code: string; message: string };

/**
 * 檔位契約 → gpt-image-2 後端參數（**純函式**，測試直接斷言映射）。
 *
 * ── 檔位怎麼送到上游（2026-09-30 讀實有渠道後定案，不靠推測）────────────────
 * gpt-image-2 的 `image_edit` 現行渠道是 **openai_images** 型（控面 `supplier` 表：
 * env:sub2api／env:hublinuxdo／env:yyds／env:fallback），其 adapter 走
 * `/images/edits` multipart 分支——該分支**只送 `size` 與 `quality`，完全不送
 * `resolution`**（`generation-core/openai-images-adapter.ts:154-163`）。
 * 也就是說：在這條真實路徑上，**檔位只能用像素 `size` 表達**；
 * 若 `size` 填 1k 的尺寸而檔位說 4k，上游就只會交 1k ⇒ 付 4K 的錢拿 1K 的圖。
 * 所以本函式把檔位**折算成尺寸**（1k 基準尺寸 × 檔位倍率），並要求折算結果落在
 * `DURABLE_IMAGE_SIZES`（已知上游收得下的集合）；落不進去＝**未驗證**，具名拒
 * （不靜默降級成較低檔位，也不拿客戶的錢賭上游會收）。
 *
 * 比例的挑選同理：原圖比例要落在模型**已宣告的 `aspectRatios`** 內，宣告外的比例
 * 用 `nearestAspectRatio` 貼近最接近的可提交比例，並把實際偏差回報出去
 * （不靜默：呼叫端看得到 `ratio` 與 `ratio_deviation`）。
 */
export function planGptImageUpscale(input: {
  tier: string;
  ratio?: unknown;
  sourcePixels?: { width: number; height: number } | null;
}): GptImageUpscalePlanResult {
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

  const tier = input.tier as keyof typeof DURABLE_TIER_SCALE;
  const scale = DURABLE_TIER_SCALE[tier];
  const baseSize = imageSizeForAspectRatio(ratio);
  const size = Number.isFinite(scale) ? scaleDurableImageSize(baseSize, scale) : null;
  if (!size || !isDurableImageSize(size)) {
    return {
      ok: false,
      code: "upscale_backend_size_unavailable",
      message:
        `檔位 ${input.tier} 在比例 ${ratio} 上沒有已知可交的輸出尺寸`
        + `（1k 基準 ${baseSize} ×${Number.isFinite(scale) ? scale : "?"} ⇒ ${size ?? "無法折算"}；`
        + `已知可交尺寸：${DURABLE_IMAGE_SIZES.join("／")}）。未驗證的尺寸不放行——`
        + `要開這個組合得先有一次真單量到輸出（同 4K 檔位的校準紀律）。`,
    };
  }

  return {
    ok: true,
    plan: {
      modelId: UPSCALE_BACKEND_MODEL_ID,
      resolution: input.tier,
      ratio,
      ratioSource,
      ratioDeviation,
      size,
      // 「一鍵超分」的提示詞：把「只提升解析度」寫死，避免模型順手重新設計畫面。
      prompt:
        `把輸入的這張圖做高清放大，輸出檔位 ${input.tier}。`
        + "嚴格保留原圖的內容、主體、構圖、比例、色彩與風格，只提升解析度與細節清晰度"
        + "（去噪、銳化邊緣、補足紋理）；不要新增、刪除或替換任何元素，不要改動畫面中的文字，不要重新設計。",
    },
  };
}