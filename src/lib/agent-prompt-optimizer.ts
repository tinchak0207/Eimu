/**
 * Agent Prompt Optimizer — Vercel 端呼叫 VPS gateway 的同步 prompt 優化。
 *
 * 優化鏈：Agent 層（deepseek，走 store.tinchak0207.xyz/agent/v1/optimize-prompt）
 * → 失敗 fallback 規則層（invisible-prompt-director）→ 原 prompt。
 * 全程服務端背景執行，用戶無感。
 */

import { directVideoPrompt, type DirectorOptions } from "./invisible-prompt-director";

export interface OptimizeResult {
  ok: boolean;
  prompt: string;
  /** 走的是 agent 還是規則層 fallback。 */
  usedAgent: boolean;
  model?: string;
  ms?: number;
}

const OPTIMIZE_TIMEOUT_MS = 30_000;

/**
 * 嘗試用 deepseek agent 優化。失敗（連不上/超時/無結果）不 throw，
 * 回 { ok:false } 由呼叫方決定 fallback。
 */
export async function optimizeVideoPromptWithAgent(
  rawPrompt: string,
  options: DirectorOptions = {},
): Promise<OptimizeResult> {
  const origin = (process.env.AGENT_GATEWAY_ORIGIN ?? "https://store.tinchak0207.xyz").replace(/\/+$/, "");
  const key = process.env.AGENT_OPTIMIZE_KEY?.trim();
  if (!key) return { ok: false, prompt: rawPrompt, usedAgent: false };

  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPTIMIZE_TIMEOUT_MS);
    try {
      const response = await fetch(`${origin}/agent/v1/optimize-prompt`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: rawPrompt,
          duration_seconds: options.durationSeconds,
          generate_audio: options.generateAudio,
        }),
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) return { ok: false, prompt: rawPrompt, usedAgent: false };
      const data = (await response.json()) as { ok?: boolean; prompt?: string; model?: string };
      const optimized = data.prompt?.trim();
      if (!data.ok || !optimized) return { ok: false, prompt: rawPrompt, usedAgent: false };
      return {
        ok: true,
        prompt: optimized,
        usedAgent: true,
        model: data.model,
        ms: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return { ok: false, prompt: rawPrompt, usedAgent: false };
  }
}

/**
 * 影片 prompt 優化總入口：Agent 優先，規則層兜底，兩者皆敗原樣。
 * 規則層同步零成本，Agent 層失敗不阻塞生成。
 */
export async function optimizeVideoPrompt(
  rawPrompt: string,
  options: DirectorOptions = {},
): Promise<OptimizeResult> {
  const agent = await optimizeVideoPromptWithAgent(rawPrompt, options);
  if (agent.ok) return agent;

  const ruled = directVideoPrompt(rawPrompt, options);
  if (ruled !== rawPrompt.trim()) {
    return { ok: true, prompt: ruled, usedAgent: false };
  }
  return { ok: false, prompt: rawPrompt.trim(), usedAgent: false };
}