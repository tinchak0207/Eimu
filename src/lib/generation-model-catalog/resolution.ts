import { generationModel } from "./capabilities";
import type { AspectRatio, ImageResolution, OutputResolution } from "./types";

export function resolveSupportedAspectRatio(
  modelId: string,
  requested?: string,
): AspectRatio {
  const model = generationModel(modelId);
  const ratios = model?.aspectRatios ?? ["1:1"];
  return ratios.includes(requested as AspectRatio)
    ? requested as AspectRatio
    : model?.defaultAspectRatio ?? "1:1";
}

export function resolveSupportedResolution(
  modelId: string,
  requested?: string,
): OutputResolution {
  const model = generationModel(modelId);
  const resolutions = model?.resolutions ?? ["1k"];
  return resolutions.includes(requested as OutputResolution)
    ? requested as OutputResolution
    : model?.defaultResolution ?? "1k";
}

export function resolveSupportedDuration(
  modelId: string,
  requested?: number,
): number | undefined {
  const model = generationModel(modelId);
  if (!model?.durations?.length) return undefined;
  return model.durations.includes(Number(requested))
    ? Number(requested)
    : model.defaultDuration ?? model.durations[0];
}

export function aspectRatioFromImageSize(size?: string): AspectRatio {
  const [width, height] = String(size ?? "").split("x").map(Number);
  if (!width || !height) return "1:1";
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}` as AspectRatio;
}

/** "W:H" 比例字串的数值宽高比（W/H）；解析失败回 1。 */
export function aspectRatioValue(ratio: AspectRatio): number {
  const [width, height] = String(ratio).split(":").map(Number);
  return width > 0 && height > 0 ? width / height : 1;
}

/**
 * 目标宽高比（width/height）映射到支持清单中最接近的一档。
 * 相对差 = |候选比值 − 目标比值| / 目标比值，取最小者；目标非法或清单为空回 "1:1"。
 * 「跟随参考图」比例档的唯一映射真源：状态里落的永远是清单内的合法 AspectRatio。
 */
export function nearestAspectRatio(target: number, supported: readonly AspectRatio[]): AspectRatio {
  if (!Number.isFinite(target) || target <= 0) return supported[0] ?? "1:1";
  let best: AspectRatio = supported[0] ?? "1:1";
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const ratio of supported) {
    const diff = Math.abs(aspectRatioValue(ratio) - target) / target;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = ratio;
    }
  }
  return best;
}

/**
 * 最近档与目标宽高比的相对差（0–1）。UI 据此诚实提示：差距 >15% 时在 chip
 * title 说明「最接近的支持比例」，不静默吞掉比例失真。
 */
export function aspectRatioDeviation(target: number, ratio: AspectRatio): number {
  if (!Number.isFinite(target) || target <= 0) return 0;
  return Math.abs(aspectRatioValue(ratio) - target) / target;
}

/**
 * 把 "WxH" 尺寸归类到 1k/2k/4k（改图/放大等按解析度浮动定价用，前后端共用）：
 * 最大边 ≤ 1536 → 1k（含 1024x1024、1536x1024、768x1365 等 1K 级输出），
 * ≤ 3072 → 2k，其余 4k。非法/缺省回 1k。
 */
export function resolutionFromImageSize(size?: string): ImageResolution {
  const [width, height] = String(size ?? "").split("x").map(Number);
  const maxDim = Math.max(width || 0, height || 0);
  if (maxDim <= 0) return "1k";
  if (maxDim <= 1536) return "1k";
  if (maxDim <= 3072) return "2k";
  return "4k";
}

const IMAGE_SIZE_BY_ASPECT_RATIO: Partial<Record<AspectRatio, string>> = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "16:9": "1792x1024",
  "9:16": "1024x1792",
  "4:3": "1365x1024",
  "3:4": "1024x1365",
  "4:5": "1024x1280",
  "5:4": "1280x1024",
  "21:9": "1792x768",
  "9:21": "768x1792",
  "1:4": "512x2048",
  "4:1": "2048x512",
  "1:8": "384x3072",
  "8:1": "3072x384",
};

/**
 * 所有可作为 workflow.imageSize 落库的尺寸。
 *
 * 之前 generation-workflow.ts 里硬编码了 3 个尺寸的白名单，任何非 1:1 / 3:2 / 2:3
 * 的画幅在写入 workflow 元数据时会被静默丢弃 —— 于是「重试」「回填参数」拿回来的
 * 是 1024x1024，用户改过的画幅无声消失。这里导出唯一真源，白名单从它派生。
 */
export const SUPPORTED_IMAGE_SIZES: string[] = Array.from(
  new Set(Object.values(IMAGE_SIZE_BY_ASPECT_RATIO)),
);

export function imageSizeForAspectRatio(ratio: AspectRatio): string {
  return IMAGE_SIZE_BY_ASPECT_RATIO[ratio] ?? "1024x1024";
}

// ── 提交端解析度（严格版；2026-09-30 打开 4K 这一格）─────────────────────────

/** 呼叫端是用哪一种说法指出档位的（诊断/回报用，不影响语义）。 */
export type SubmitResolutionSource = "explicit" | "size_tier" | "size_pixels" | "quality" | "default";

export type SubmitResolutionResult =
  | { ok: true; resolution: ImageResolution; source: SubmitResolutionSource }
  | { ok: false; code: string; message: string };

/** 像素长边超过这个值才按像素折算成 4k（≤3072 沿用旧品质规则，保持既有行为逐位元不变）。 */
const PIXEL_4K_LONG_EDGE = 3072;

/**
 * 请求 → **提交**解析度（严格，禁静默降级）。
 *
 * 为什么要严格版：同档的 `resolveSupportedResolution` 对未宣告的档位**回退模型预设**
 * （给 UI 挑选用，友善）；但提交端一旦回退，就是「卖一个上游不认的档位」或静默降级
 * ——P1-4 在 PixAI 桥的 size 白名单上吃过同一颗雷（`size:"4k"` 被静默回退成 1k）。
 * 所以这里不合法就具名拒，让呼叫端在付费之前看到 `unsupported_resolution`。
 *
 * 语义优先序：
 *   ① 显式 `resolution`／`output_resolution`＝它说话（须是 1k/2k/4k，否则具名拒）；
 *   ② `size` 本身是档位字串（`"4k"`）＝该档位；
 *   ③ `size` 是像素写法且长边 > 3072（如 4096x4096）＝按长边折算（新开的 4K 通道）；
 *   ④ 其余（含 1024x1024／2048x2048 等既有尺寸）＝沿用旧品质规则：`quality`⇒2k、其余⇒1k；
 *   ⑤ 什么都没给＝1k。
 * 最后仍要过「该模型宣告的 `resolutions`」这一关（宣告了才准提交）。
 */
export function resolveSubmitResolution(
  modelId: string,
  input: { resolution?: unknown; size?: unknown; quality?: string } = {},
): SubmitResolutionResult {
  const model = generationModel(modelId);
  const declared = model?.resolutions ?? [];

  let resolution: ImageResolution;
  let source: SubmitResolutionSource;

  const explicit = input.resolution;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== "") {
    const raw = String(explicit).trim().toLowerCase();
    if (raw !== "1k" && raw !== "2k" && raw !== "4k") {
      return {
        ok: false,
        code: "unsupported_resolution",
        message: `不支持的解析度 ${raw}。可选：1k、2k、4k。`,
      };
    }
    resolution = raw as ImageResolution;
    source = "explicit";
  } else {
    const rawSize = typeof input.size === "string" ? input.size.trim() : "";
    const lowered = rawSize.toLowerCase();
    if (lowered === "1k" || lowered === "2k" || lowered === "4k") {
      resolution = lowered as ImageResolution;
      source = "size_tier";
    } else {
      const pixels = /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/u.exec(rawSize);
      const maxDim = pixels ? Math.max(Number(pixels[1]), Number(pixels[2])) : 0;
      if (maxDim > PIXEL_4K_LONG_EDGE) {
        resolution = resolutionFromImageSize(rawSize);
        source = "size_pixels";
      } else if (input.quality === "quality" || input.quality === "hd" || input.quality === "high") {
        resolution = "2k";
        source = "quality";
      } else {
        resolution = "1k";
        source = "default";
      }
    }
  }

  if (declared.length > 0 && !declared.includes(resolution)) {
    return {
      ok: false,
      code: "resolution_not_declared_by_model",
      message: `模型 ${modelId} 未宣告解析度 ${resolution}（已宣告：${declared.join("／")}）——未宣告即不许提交，避免上游静默降级。`,
    };
  }
  return { ok: true, resolution, source };
}
