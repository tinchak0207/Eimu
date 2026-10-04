"use client";

import { useEffect } from "react";
import { applyModelPricingOverrides } from "@/lib/generation-model-catalog";

const STORAGE_KEY = "model-pricing-overrides.v1";
const POLL_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// 覆写结构由核心层定价模组定义，这里只取 applyModelPricingOverrides 的参数型别，
// 不重复宣告，核心层改签名时此处自动跟随。
type PricingOverrides = Parameters<typeof applyModelPricingOverrides>[0];

interface PricingSyncPayload {
  overrides: PricingOverrides;
  revision?: number;
  ttlMs?: number;
}

interface CachedPricing extends PricingSyncPayload {
  savedAt: number;
}

// 模组级 guard：同一页若被挂载多次（HMR、多入口），只跑一份轮询与事件监听，
// 避免叠出多个 interval 对同一端点重复打。
let activeSyncCount = 0;
let pollingTimer: number | null = null;
let listenersAttached = false;
let controller: AbortController | null = null;

function writeCache(payload: PricingSyncPayload): void {
  const cached: CachedPricing = { ...payload, savedAt: Date.now() };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // 隐私模式或磁碟已满时写入失败可忽略。
  }
}

function hydrateFromCache(): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const cached = JSON.parse(raw) as Partial<CachedPricing>;
    if (typeof cached !== "object" || cached === null) throw new Error("malformed cache");
    if (typeof cached.savedAt !== "number" || Date.now() - cached.savedAt > STALE_AFTER_MS) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    // 回访用户第一帧就用快取价格套上，避免先闪基准价再跳到覆写价。
    applyModelPricingOverrides(cached.overrides as PricingOverrides);
  } catch {
    // 快取 JSON 损毁就静默清掉，让它走完整同步。
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}

async function syncNow(): Promise<void> {
  if (!controller || controller.signal.aborted) return;
  try {
    const res = await fetch("/api/model-pricing", { cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new Error(`pricing sync http ${res.status}`);
    const payload = (await res.json()) as PricingSyncPayload;
    applyModelPricingOverrides(payload.overrides);
    writeCache(payload);
  } catch (error) {
    // 卸载时 abort 造成的 rejection 不是错误；其余失败一律静默降级，绝不影响页面。
    if (controller?.signal.aborted) return;
    console.warn("[PricingSync] 同步定价覆写失败", error);
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") void syncNow();
}

function onWindowFocus(): void {
  void syncNow();
}

/**
 * 挂在 root layout 的纯副作用元件：拉取管理员最新模型定价覆写并套进目录，
 * 让展示端的 usePricingRevision 订阅触发报价重算。回 null，不渲染任何节点。
 */
export function PricingSync() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    if (activeSyncCount === 0) {
      controller = new AbortController();
      hydrateFromCache();
      void syncNow();
      pollingTimer = window.setInterval(() => void syncNow(), POLL_INTERVAL_MS);
      if (!listenersAttached) {
        document.addEventListener("visibilitychange", onVisibilityChange);
        window.addEventListener("focus", onWindowFocus);
        listenersAttached = true;
      }
    }
    activeSyncCount += 1;

    return () => {
      activeSyncCount -= 1;
      // 最后一个实例卸载时才清共享资源。
      if (activeSyncCount === 0) {
        if (pollingTimer !== null) {
          window.clearInterval(pollingTimer);
          pollingTimer = null;
        }
        if (listenersAttached) {
          document.removeEventListener("visibilitychange", onVisibilityChange);
          window.removeEventListener("focus", onWindowFocus);
          listenersAttached = false;
        }
        controller?.abort();
        controller = null;
      }
    };
  }, []);

  return null;
}

export default PricingSync;
