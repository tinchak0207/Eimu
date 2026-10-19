"use client";

import { useEffect, useState } from "react";

export type ModelAvailability = "available" | "unavailable" | "unknown";

/**
 * C 端模型活性字典：GET /api/user/model-status（与 AI 助理 /v1/model-status
 * 执行侧同源：supplier health 信号 + 欠费覆写，60s 服务端缓存）。
 *
 * 消费方把 unavailable 当「死」（禁用 + 排后），available/unknown/缺省当「活」——
 * 死活未知绝不拦用户，与后端 fail-open 纪律一致。
 *
 * 模组级缓存 + in-flight 去重：同页多个 ModelPicker 共用一次请求。
 */
const TTL_MS = 60_000;
let cache: { expiresAt: number; data: Record<string, ModelAvailability> } | null = null;
let inflight: Promise<Record<string, ModelAvailability>> | null = null;

async function fetchModelAvailability(): Promise<Record<string, ModelAvailability>> {
  try {
    const res = await fetch("/api/user/model-status", { cache: "no-store" });
    if (!res.ok) return {};
    const payload = (await res.json().catch(() => null)) as { models?: Record<string, ModelAvailability> } | null;
    return payload?.models ?? {};
  } catch {
    // 网路/解析失败 → 空字典（全当活），绝不让活性拉取拖垮选单。
    return {};
  }
}

function load(): Promise<Record<string, ModelAvailability>> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return Promise.resolve(cache.data);
  if (!inflight) {
    inflight = fetchModelAvailability()
      .then((data) => {
        cache = { expiresAt: Date.now() + TTL_MS, data };
        return data;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** 模型是否「活」：只有明确 unavailable 才算死，其余（含未知/缺省）都当活。 */
export function isModelAlive(modelId: string, availability: Record<string, ModelAvailability>): boolean {
  return availability[modelId] !== "unavailable";
}

export function useModelAvailability(): Record<string, ModelAvailability> {
  const [availability, setAvailability] = useState<Record<string, ModelAvailability>>({});
  useEffect(() => {
    let cancelled = false;
    load().then((data) => {
      if (!cancelled) setAvailability(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return availability;
}
