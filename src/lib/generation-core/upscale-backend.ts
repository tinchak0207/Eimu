/**
 * 超分后端选择与参数规划（`/v1/upscale` 的第二条后端）。
 *
 * ── 为什么有这条后端（2026-09-30 项目负责人指令「4k超分可以走 gpt image 2 执行超分」）──
 * ① PixAI 渠道当日已死（站点风控加强）——legacy 后端（`proxyPixai("upscale")`）只会回 502；
 * ② 4K 档位在 legacy 后端上本来就卡 `factor=4` 未校准（见 `upscale-tier.ts` 档头）。
 * 因此 4K 超分改由 **gpt-image-2 生成式重绘**承接：原图当参考图提交 durable
 * `image_edit` 任务，档位折算成像素尺寸、原图比例挑可提交比例。
 * **档位只在 `size` 上表达**（不是 `resolution`）——理由见下方 `planGptImageUpscale`
 * 的「档位怎么送到上游」节（实查实有渠道得出的结论）。
 *
 * ── 语义（必须对外说清楚，不可含糊）──────────────────────────────────────────
 * 这**不是保真像素放大**（不是原图 ×N），是**重新绘制**：内容会被模型重画一遍，
 * 细节可能与原图不同。所以回应必须带实测 `width/height` 供呼叫端自证，
 * 而且 4K 未校准前照样 fail-closed（`upscale_4k_upstream_unverified`）。
 *
 * ── 钱的边界（违反＝事故）──────────────────────────────────────────────────
 * **收费跟后端走（2026-10-01 项目负责人授权「4K放大后端你自己决定 做好就行」）**：后端既然从
 * legacy 的一口价换成 gpt-image-2 的一次生成式重绘（有真实上游成本），收费就按 gpt-image-2
 * 在该档位的 **catalog 价**（`imageCredits` 1k=10／2k=20／4k=80 credits ⇒ `generationCoins`
 * 1／2／8 币）；legacy 仍维持 `pixai-upscale` 的 0.001 币不动。价表**不另写**：唯一来源仍是
 * `generation-model-catalog`，本档只做「后端 → 定价键 → 档位价」的选择（`upscaleChargeQuota`）。
 * 默认＝legacy，切换要控面逐字设 `UPSCALE_BACKEND=gpt-image-2`。
 *
 * 本档被 route import，故**不可**放进 route 档（Next.js 15 只允许 route 档汇出
 * handler 与 config；多余汇出会让 `next build` 的型别检查直接失败，2026-09-30 实锤）。
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

/** 切换后端的 env 名（控面）：只有逐字 `gpt-image-2` 才切，其余（含未设）＝legacy。 */
export const UPSCALE_BACKEND_ENV = "UPSCALE_BACKEND";

/** 新后端跑的平台模型（上游变体名 = `firefly-gpt-image-{resolution}-{ratio}`）。 */
export const UPSCALE_BACKEND_MODEL_ID = DEFAULT_IMAGE_MODEL_ID;

export function resolveUpscaleBackend(env: NodeJS.ProcessEnv = process.env): UpscaleBackend {
  return (env[UPSCALE_BACKEND_ENV] ?? "").trim().toLowerCase() === "gpt-image-2" ? "gpt-image-2" : "pixai-bridge";
}

// ── 收费（价表唯一来源＝generation-model-catalog；本节只做选择与换算）──────────

/**
 * 收费的定价键（**不复制任何价目数字**，只是「后端 → 定价键」的选择）：
 * - `gpt-image-2`：一次生成式重绘（真实上游成本）⇒ 定价键＝该模型本身，
 *   价＝gpt-image-2 在该档位的 `imageCredits`（1k=10／2k=20／4k=80 credits）。
 * - `pixai-bridge`（legacy）：定价键＝`pixai-upscale`，仍是 0.001 币一口价，不被新后端打到。
 */
export function upscaleChargeModelId(backend: UpscaleBackend): string {
  return backend === "gpt-image-2" ? UPSCALE_BACKEND_MODEL_ID : PIXAI_UPSCALE_MODEL_ID;
}

/**
 * 一次超分在**同步层**（`/v1/upscale`）要预扣的 quota＝catalog 档位价 × `quotaPerCoin`。
 * 价走 `generationCoins`／`imageCredits`／`fixedCoins`（与 admin 覆写层同源），此处仅把
 * 「后端 → 定价键 → 档位价」串起来；禁在此另写价目（否则就是第二份价表）。
 */
export function upscaleChargeQuota(backend: UpscaleBackend, tier: UpscaleTier, quotaPerCoin: number): number {
  return Math.round(generationCoins(upscaleChargeModelId(backend), { resolution: tier }) * quotaPerCoin);
}

/**
 * 提交 durable 上游任务时带的 `billingAmount`：**恒 0**。
 * 钱已在同步层的 `reserveSyncCharge` 收过（见 `upscaleChargeQuota`）；上游若再记一次金额
 * ＝同一笔请求扣两次（双扣事故）。此常数是「同一笔只收一次」契约的唯一出口，route 消费它。
 */
export const UPSCALE_UPSTREAM_BILLING_AMOUNT = 0;

/** 等待 durable 任务的预算（同 openai-compat 的 240s：函数 300s 留 60s 结算余裕）。 */
export const UPSCALE_AWAIT_MS = 240_000;
export const UPSCALE_POLL_INTERVAL_MS = 2_500;
export const UPSCALE_POLL_INTERVAL_MAX_MS = 5_000;

/** 后端能力（`size`＋`ratio`）与档位的对应：**档位靠像素尺寸承载**，不加倍率。 */
export interface GptImageUpscalePlan {
  modelId: string;
  resolution: string;
  ratio: AspectRatio;
  /** 比例来源（诊断用）：显式 `ratio`／原图像素折算／预设。 */
  ratioSource: "explicit" | "source_pixels" | "default";
  /** 折算后与原图比例的相对差（>0 表示画面比例被贴近到最接近的可提交档），0＝没有折算。 */
  ratioDeviation: number;
  /** 送给管线的像素尺寸：**这才是档位在实有渠道上的表达**（见档头「档位怎么送到上游」）。 */
  size: string;
  prompt: string;
}

export type GptImageUpscalePlanResult =
  | { ok: true; plan: GptImageUpscalePlan }
  | { ok: false; code: string; message: string };

/**
 * 档位契约 → gpt-image-2 后端参数（**纯函式**，测试直接断言映射）。
 *
 * ── 档位怎么送到上游（2026-09-30 读实有渠道后定案，不靠推测）────────────────
 * gpt-image-2 的 `image_edit` 现行渠道是 **openai_images** 型（控面 `supplier` 表：
 * env:sub2api／env:hublinuxdo／env:yyds／env:fallback），其 adapter 走
 * `/images/edits` multipart 分支——该分支**只送 `size` 与 `quality`，完全不送
 * `resolution`**（`generation-core/openai-images-adapter.ts:154-163`）。
 * 也就是说：在这条真实路径上，**档位只能用像素 `size` 表达**；
 * 若 `size` 填 1k 的尺寸而档位说 4k，上游就只会交 1k ⇒ 付 4K 的钱拿 1K 的图。
 * 所以本函式把档位**折算成尺寸**（1k 基准尺寸 × 档位倍率），并要求折算结果落在
 * `DURABLE_IMAGE_SIZES`（已知上游收得下的集合）；落不进去＝**未验证**，具名拒
 * （不静默降级成较低档位，也不拿客户的钱赌上游会收）。
 *
 * 比例的挑选同理：原图比例要落在模型**已宣告的 `aspectRatios`** 内，宣告外的比例
 * 用 `nearestAspectRatio` 贴近最接近的可提交比例，并把实际偏差回报出去
 * （不静默：呼叫端看得到 `ratio` 与 `ratio_deviation`）。
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
        `档位 ${input.tier} 在比例 ${ratio} 上没有已知可交的输出尺寸`
        + `（1k 基准 ${baseSize} ×${Number.isFinite(scale) ? scale : "?"} ⇒ ${size ?? "无法折算"}；`
        + `已知可交尺寸：${DURABLE_IMAGE_SIZES.join("／")}）。未验证的尺寸不放行——`
        + `要开这个组合得先有一次真单量到输出（同 4K 档位的校准纪律）。`,
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
      // 「一键超分」的提示词：把「只提升解析度」写死，避免模型顺手重新设计画面。
      prompt:
        `把输入的这张图做高清放大，输出档位 ${input.tier}。`
        + "严格保留原图的内容、主体、构图、比例、色彩与风格，只提升解析度与细节清晰度"
        + "（去噪、锐化边缘、补足纹理）；不要新增、删除或替换任何元素，不要改动画面中的文字，不要重新设计。",
    },
  };
}