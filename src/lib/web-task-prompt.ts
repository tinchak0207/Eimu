// Web durable 任务（POST /api/generation-jobs）的 prompt 组装与显示还原。
//
// 为什么在分发层组：generation-core 的 adapter 只读 job 的单一 prompt 栏位，完全不消费
// workflow.negativePrompt / workflow.referenceImages 角色；不在这里组就会被静默丢掉。
// 组法与 legacy `/api/generate-images`（readWorkflowMetadata → buildWorkflowPrompt，route.ts:493）
// 同一函式、同一归一，位元组一致。
//
// 只用「本次请求 body 带的 workflow」组（与 legacy 同口径）：
// - canvas 已预组 prompt 且不送 workflow → 原样透传，不会被重复套用；
// - retry 合并进来的旧 workflow 不参与组装（避免把上一单的段落再套一次）。
//
// job 只有一个 prompt 栏位（供给要吃组好的长 prompt），用户原文存 workflow.originalPrompt，
// 历史/重跑/任务投影读 `displayGenerationPrompt` 还原原文。
import { WORKFLOW_SCHEMA_VERSION, buildWorkflowPrompt, normalizeGenerationWorkflowMetadata } from "./generation-workflow";
import type { GenerationWorkflowMetadata } from "./image-types";

export const ORIGINAL_PROMPT_KEY = "originalPrompt";

/** 与 generate-images 的 readWorkflowMetadata 同语义：物件或 JSON 字串皆收，非物件回 undefined。 */
export function readRequestWorkflow(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return undefined;
        }
      })()
    : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/** 供给要收的最终 prompt：与 legacy generate-images 位元组一致。 */
export function composeWebTaskPrompt(prompt: string, requestWorkflow: Record<string, unknown> | undefined): string {
  if (!requestWorkflow) return prompt.trim();
  const { [ORIGINAL_PROMPT_KEY]: _ignored, ...rest } = requestWorkflow;
  const metadata = normalizeGenerationWorkflowMetadata({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    ...(rest as GenerationWorkflowMetadata),
  });
  return buildWorkflowPrompt(prompt, metadata);
}

/**
 * 在即将落库的 workflow 上记下用户原文：组过才记，没组过就移除（防 retry 合并带进上一单的旧原文）。
 */
export function withOriginalPrompt<T extends Record<string, unknown>>(
  workflow: T,
  originalPrompt: string,
  submittedPrompt: string,
): T {
  const { [ORIGINAL_PROMPT_KEY]: _stale, ...rest } = workflow;
  return (submittedPrompt === originalPrompt ? rest : { ...rest, [ORIGINAL_PROMPT_KEY]: originalPrompt }) as T;
}

/** 显示用 prompt：有原文就回原文，否则回 job 的 prompt（存量任务/canvas 任务不变）。 */
export function displayGenerationPrompt(
  prompt: string | undefined,
  workflow: Record<string, unknown> | null | undefined,
): string | undefined {
  const original = workflow?.[ORIGINAL_PROMPT_KEY];
  return typeof original === "string" && original.trim() ? original : prompt;
}
