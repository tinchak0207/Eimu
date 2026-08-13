"use client";

import { useEffect } from "react";
import { applyModelPricingOverrides } from "@/lib/generation-model-catalog";

const STORAGE_KEY = "model-pricing-overrides.v1";
const POLL_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// 覆寫結構由核心層定價模組定義，這裡只取 applyModelPricingOverrides 的參數型別，
// 不重複宣告，核心層改簽名時此處自動跟隨。
type PricingOverrides = Parameters<typeof applyModelPricingOverrides>[0];

interface PricingSyncPayload {
  overrides: PricingOverrides;
  revision?: number;
  ttlMs?: number;
}

interface CachedPricing extends PricingSyncPayload {
  savedAt: number;
}

// 模組級 guard：同一頁若被掛載多次（HMR、多入口），只跑一份輪詢與事件監聽，
// 避免疊出多個 interval 對同一端點重複打。
let activeSyncCount = 0;
let pollingTimer: number | null = null;
let listenersAttached = false;
let controller: AbortController | null = null;

function writeCache(payload: PricingSyncPayload): void {
  const cached: CachedPricing = { ...payload, savedAt: Date.now() };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // 隱私模式或磁碟已滿時寫入失敗可忽略。
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
    // 回訪用戶第一幀就用快取價格套上，避免先閃基準價再跳到覆寫價。
    applyModelPricingOverrides(cached.overrides as PricingOverrides);
  } catch {
    // 快取 JSON 損毀就靜默清掉，讓它走完整同步。
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
    // 卸載時 abort 造成的 rejection 不是錯誤；其餘失敗一律靜默降級，絕不影響頁面。
    if (controller?.signal.aborted) return;
    console.warn("[PricingSync] 同步定價覆寫失敗", error);
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") void syncNow();
}

function onWindowFocus(): void {
  void syncNow();
}

/**
 * 掛在 root layout 的純副作用元件：拉取管理員最新模型定價覆寫並套進目錄，
 * 讓展示端的 usePricingRevision 訂閱觸發報價重算。回 null，不渲染任何節點。
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
      // 最後一個實例卸載時才清共享資源。
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
