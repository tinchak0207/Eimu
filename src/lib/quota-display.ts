// R1/R3（W5）：額度顯示語義 —— 純函式，零 IO、零 React。
//
// 為什麼要有這一支：`/v1/quota` 的伺服器決策（`src/app/api/v1/quota/decision.ts`）
// 已經把「讀不到帳本」表達成 503 `quota_unavailable`，**刻意不畫假的 0**。但客戶端
// 若自己把「沒有數字」畫成「0 幣」，等於把伺服器好不容易守住的那條誠實線在展示層
// 又抹掉。這支把三態（權威／不可用／估算）的文案、色調、時效收斂成單一真源：
//
//   - authoritative：我方可見權威帳本的讀數，直接顯示；不是「估」。
//   - unavailable：**一律回「暂不可用」且 tone=unknown，永不顯示 0**（這條是 oracle）。
//   - estimated：本地快取／推算值，必帶時效標記；超過門檻即 stale。
//
// 展示用文案沿用產品的簡體中文（與 /v1/quota 503 的「余额查询暂不可用」同一語域），
// 不自立繁體變體。本檔只交付 lib＋測試，不碰任何 UI 元件（避免與其他包衝突）。

export type QuotaTone = "ok" | "warn" | "unknown";

export type QuotaDisplayState =
  /** 權威讀數（我方帳本 pool 口徑）。 */
  | { kind: "authoritative"; balanceCoins: number }
  /** 讀不到權威帳本（對應伺服器 503 quota_unavailable）；不得畫成 0。 */
  | { kind: "unavailable"; reason: string }
  /** 估算值（本地快取／推算）：必帶時效。 */
  | { kind: "estimated"; balanceCoins: number; asOf: number };

export interface QuotaDisplay {
  label: string;
  tone: QuotaTone;
  stale: boolean;
}

/** 不可用時的固定文案（單一真源；測試釘死不得含數字 0）。 */
export const QUOTA_UNAVAILABLE_LABEL = "暂不可用";

/** estimated 的時效門檻：超過視為 stale。 */
export const QUOTA_STALE_AFTER_MS = 5 * 60_000;

function unavailable(): QuotaDisplay {
  // stale=true：資料不是「權威且新鮮」的；展示層據此可弱化或提示重試。
  return { label: QUOTA_UNAVAILABLE_LABEL, tone: "unknown", stale: true };
}

function formatCoins(coins: number): string {
  return `${coins} 币`;
}

/**
 * 把額度狀態翻成展示語義。純函式：給定 state 與 now，輸出恆定。
 *
 * 防禦：任何非有限數字（NaN/Infinity）都不會被渲染成數字——authoritative/estimated
 * 的 balanceCoins 非有限時一律降級成 unavailable，不讓 "NaN 币" 或假 0 上畫面。
 */
export function describeQuota(state: QuotaDisplayState, now: number): QuotaDisplay {
  switch (state.kind) {
    case "authoritative": {
      if (!Number.isFinite(state.balanceCoins)) return unavailable();
      return { label: formatCoins(state.balanceCoins), tone: "ok", stale: false };
    }
    case "estimated": {
      if (!Number.isFinite(state.balanceCoins)) return unavailable();
      const age = now - state.asOf;
      const stale = !Number.isFinite(age) ? true : age > QUOTA_STALE_AFTER_MS;
      return { label: `约 ${formatCoins(state.balanceCoins)}`, tone: stale ? "warn" : "ok", stale };
    }
    case "unavailable":
      return unavailable();
    default: {
      // 執行期收到未預期的 kind（伺服器契約漂移）：寧可說不可用，也不畫假數字。
      return unavailable();
    }
  }
}
