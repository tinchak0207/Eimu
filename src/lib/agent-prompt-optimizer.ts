/**
 * Agent Prompt Optimizer — Vercel 端呼叫 VPS gateway 的同步 prompt 优化。
 *
 * 优化链：Agent 层（deepseek，走 store.tinchak0207.xyz/agent/v1/optimize-prompt）
 * → 失败 fallback 规则层（invisible-prompt-director）→ 原 prompt。
 * 全程服务端背景执行，用户无感。
 */

import { directVideoPrompt, type DirectorOptions } from "./invisible-prompt-director";

export interface OptimizeResult {
  ok: boolean;
  prompt: string;
  /** 走的是 agent 还是规则层 fallback。 */
  usedAgent: boolean;
  model?: string;
  ms?: number;
}

const OPTIMIZE_TIMEOUT_MS = 30_000;

/**
 * 尝试用 deepseek agent 优化。失败（连不上/超时/无结果）不 throw，
 * 回 { ok:false } 由呼叫方决定 fallback。
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
 * 影片 prompt 优化总入口：Agent 优先，规则层兜底，两者皆败原样。
 * 规则层同步零成本，Agent 层失败不阻塞生成。
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