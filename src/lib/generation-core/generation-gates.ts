// 生成品质门 v1 —— 确定性代码，不是交给模型自觉的 checklist。
//
// 三条铁律：
//   1. 门 = 确定性代码：可判定的才拦（空提示词、超长、非法宽高比、负面词反噬风格）。
//   2. 误拦的门比没有门更糟：不可判定的一律 status="skip"（仅记录，不阻断）。
//   3. 跳过 ≠ 失败：gatesBlock 只看 "fail"，skip 永远不拦。
//
// 零外部依赖：只消费本仓库的纯数据 —— STYLE_PRESETS（prompt-enhancer，
// 即 StylePresets.tsx 组件渲染的同一份数据）与 ASPECT_RATIO_VALUES
// （generation-model-catalog/types，全站宽高比枚举 owner）。

import { ASPECT_RATIO_VALUES } from "./generation-model-catalog";
import type { StylePreset } from "./prompt-enhancer";

export type GateStatus = "pass" | "fail" | "skip";

export interface GateCheck {
  id: string;
  label: string;
  status: GateStatus;
  detail?: string;
}

export interface PreGenerationGateInput {
  prompt: string;
  modelId: string;
  aspectRatio?: string | null;
  referenceImageCount?: number;
  negativePrompt?: string | null;
  stylePresetId?: string | null;
  loraIds?: string[];
}

const MAX_PROMPT_LENGTH = 6000;

/**
 * 各风格 preset 的核心风格短语——负面词里不该出现所选风格的主体词
 * （如水彩风 preset + 负面词「水彩」= 自相矛盾）。
 * key 必须恰好覆盖 STYLE_PRESETS 的全部条目（测试钉死），数据源头仍是
 * prompt-enhancer，这里只补「核心短语」这层确定性映射。
 */
export const CORE_STYLE_PHRASES: Record<Exclude<StylePreset, "none">, readonly string[]> = {
  realistic: ["真实摄影", "photorealistic"],
  anime: ["动漫", "anime"],
  street: ["街拍", "街头", "street photography"],
  product: ["产品", "product photography"],
  poster: ["海报", "poster"],
  watercolor: ["水彩", "watercolor"],
};

function containsPhrase(haystack: string, phrase: string): boolean {
  return haystack.toLowerCase().includes(phrase.toLowerCase());
}

export function runPreGenerationGates(input: PreGenerationGateInput): GateCheck[] {
  const checks: GateCheck[] = [];
  const rawPrompt = input.prompt ?? "";

  // ── prompt_nonempty：trim 后非空 ──────────────────────────────────────
  checks.push(
    rawPrompt.trim()
      ? { id: "prompt_nonempty", label: "提示词非空", status: "pass" }
      : { id: "prompt_nonempty", label: "提示词非空", status: "fail", detail: "提示词去除首尾空白后为空" },
  );

  // ── prompt_length：≤6000 字符（按原始字符数，上游计费同口径）──────────
  checks.push(
    rawPrompt.length <= MAX_PROMPT_LENGTH
      ? { id: "prompt_length", label: "提示词长度上限", status: "pass" }
      : {
          id: "prompt_length",
          label: "提示词长度上限",
          status: "fail",
          detail: `提示词 ${rawPrompt.length} 字符，超过上限 ${MAX_PROMPT_LENGTH}`,
        },
  );

  // ── size_legal：只判「是否为全站合法枚举值」。某模型支不支持该比例是
  //    resolution 层的归一化职责（resolveSupportedAspectRatio），这里不二次猜，
  //    否则会对已被平台静默归一化的请求误拦。未提供时用默认值，属于 skip。
  const aspectRatio = typeof input.aspectRatio === "string" ? input.aspectRatio.trim() : "";
  if (!aspectRatio) {
    checks.push({
      id: "size_legal",
      label: "宽高比合法",
      status: "skip",
      detail: "未提供宽高比，沿用模型默认值",
    });
  } else if ((ASPECT_RATIO_VALUES as readonly string[]).includes(aspectRatio)) {
    checks.push({ id: "size_legal", label: "宽高比合法", status: "pass" });
  } else {
    checks.push({
      id: "size_legal",
      label: "宽高比合法",
      status: "fail",
      detail: `不支持的宽高比 "${aspectRatio}"`,
    });
  }

  // ── negative_antonym：负面词与风格 preset 同时存在才评估；preset 未知
  //    （如 style-library 模板 id）或为 "none" 时不可判定 → skip。
  const negative = typeof input.negativePrompt === "string" ? input.negativePrompt.trim() : "";
  const presetId = typeof input.stylePresetId === "string" ? input.stylePresetId.trim() : "";
  const presetPhrases =
    presetId && presetId !== "none" && presetId in CORE_STYLE_PHRASES
      ? CORE_STYLE_PHRASES[presetId as Exclude<StylePreset, "none">]
      : null;
  if (!negative || !presetId) {
    checks.push({
      id: "negative_antonym",
      label: "负面词与风格不冲突",
      status: "skip",
      detail: "未同时提供负面词与风格预设",
    });
  } else if (!presetPhrases) {
    checks.push({
      id: "negative_antonym",
      label: "负面词与风格不冲突",
      status: "skip",
      detail: `未知的风格预设 "${presetId}"，v1 门仅覆盖 STYLE_PRESETS`,
    });
  } else {
    const hit = presetPhrases.find((phrase) => containsPhrase(negative, phrase));
    checks.push(
      hit
        ? {
            id: "negative_antonym",
            label: "负面词与风格不冲突",
            status: "fail",
            detail: `负面词包含所选风格的核心短语「${hit}」，与风格预设自相矛盾`,
          }
        : { id: "negative_antonym", label: "负面词与风格不冲突", status: "pass" },
    );
  }

  // ── lora_single：多 LoRA 只记录不阻断——平台既有 slice(0,1) 归一化兜底
  //    （generation-model-catalog/capabilities.ts 与 agent-lora.ts）。
  const loraCount = input.loraIds?.length ?? 0;
  checks.push(
    loraCount > 1
      ? {
          id: "lora_single",
          label: "LoRA 单选",
          status: "skip",
          detail: `传入 ${loraCount} 个 LoRA；平台按 slice(0,1) 归一化只取第一个，不阻断`,
        }
      : { id: "lora_single", label: "LoRA 单选", status: "pass" },
  );

  return checks;
}

/** 存在任一 fail 即 true。skip 不是失败，永远不阻断。 */
export function gatesBlock(checks: GateCheck[]): boolean {
  return checks.some((check) => check.status === "fail");
}
