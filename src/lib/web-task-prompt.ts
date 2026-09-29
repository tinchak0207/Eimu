// Web durable 任務（POST /api/generation-jobs）的 prompt 組裝與顯示還原。
//
// 為什麼在分發層組：generation-core 的 adapter 只讀 job 的單一 prompt 欄位，完全不消費
// workflow.negativePrompt / workflow.referenceImages 角色；不在這裡組就會被靜默丟掉。
// 組法與 legacy `/api/generate-images`（readWorkflowMetadata → buildWorkflowPrompt，route.ts:493）
// 同一函式、同一歸一，位元組一致。
//
// 只用「本次請求 body 帶的 workflow」組（與 legacy 同口徑）：
// - canvas 已預組 prompt 且不送 workflow → 原樣透傳，不會被重複套用；
// - retry 合併進來的舊 workflow 不參與組裝（避免把上一單的段落再套一次）。
//
// job 只有一個 prompt 欄位（供給要吃組好的長 prompt），用戶原文存 workflow.originalPrompt，
// 歷史/重跑/任務投影讀 `displayGenerationPrompt` 還原原文。
import { WORKFLOW_SCHEMA_VERSION, buildWorkflowPrompt, normalizeGenerationWorkflowMetadata } from "./generation-workflow";
import type { GenerationWorkflowMetadata } from "./image-types";

export const ORIGINAL_PROMPT_KEY = "originalPrompt";

/** 與 generate-images 的 readWorkflowMetadata 同語義：物件或 JSON 字串皆收，非物件回 undefined。 */
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

/** 供給要收的最終 prompt：與 legacy generate-images 位元組一致。 */
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
 * 在即將落庫的 workflow 上記下用戶原文：組過才記，沒組過就移除（防 retry 合併帶進上一單的舊原文）。
 */
export function withOriginalPrompt<T extends Record<string, unknown>>(
  workflow: T,
  originalPrompt: string,
  submittedPrompt: string,
): T {
  const { [ORIGINAL_PROMPT_KEY]: _stale, ...rest } = workflow;
  return (submittedPrompt === originalPrompt ? rest : { ...rest, [ORIGINAL_PROMPT_KEY]: originalPrompt }) as T;
}

/** 顯示用 prompt：有原文就回原文，否則回 job 的 prompt（存量任務/canvas 任務不變）。 */
export function displayGenerationPrompt(
  prompt: string | undefined,
  workflow: Record<string, unknown> | null | undefined,
): string | undefined {
  const original = workflow?.[ORIGINAL_PROMPT_KEY];
  return typeof original === "string" && original.trim() ? original : prompt;
}
