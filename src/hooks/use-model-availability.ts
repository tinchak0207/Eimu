"use client";

import { useEffect, useState } from "react";

export type ModelAvailability = "available" | "unavailable" | "unknown";

/**
 * C 端模型活性字典：GET /api/user/model-status（與 AI 助理 /v1/model-status
 * 執行側同源：supplier health 信號 + 欠費覆寫，60s 服務端緩存）。
 *
 * 消費方把 unavailable 當「死」（禁用 + 排後），available/unknown/缺省當「活」——
 * 死活未知絕不攔用戶，與後端 fail-open 紀律一致。
 *
 * 模組級緩存 + in-flight 去重：同頁多個 ModelPicker 共用一次請求。
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
    // 網路/解析失敗 → 空字典（全當活），絕不讓活性拉取拖垮選單。
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

/** 模型是否「活」：只有明確 unavailable 才算死，其餘（含未知/缺省）都當活。 */
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
