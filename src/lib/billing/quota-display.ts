// R1/R3（W5）：额度显示语义 —— 纯函式，零 IO、零 React。
//
// 为什么要有这一支：`/v1/quota` 的伺服器决策（`src/app/api/v1/quota/decision.ts`）
// 已经把「读不到帐本」表达成 503 `quota_unavailable`，**刻意不画假的 0**。但客户端
// 若自己把「没有数字」画成「0 币」，等于把伺服器好不容易守住的那条诚实线在展示层
// 又抹掉。这支把三态（权威／不可用／估算）的文案、色调、时效收敛成单一真源：
//
//   - authoritative：我方可见权威帐本的读数，直接显示；不是「估」。
//   - unavailable：**一律回「暂不可用」且 tone=unknown，永不显示 0**（这条是 oracle）。
//   - estimated：本地快取／推算值，必带时效标记；超过门槛即 stale。
//
// 展示用文案沿用产品的简体中文（与 /v1/quota 503 的「余额查询暂不可用」同一语域），
// 不自立繁体变体。本档只交付 lib＋测试，不碰任何 UI 元件（避免与其他包冲突）。

export type QuotaTone = "ok" | "warn" | "unknown";

export type QuotaDisplayState =
  /** 权威读数（我方帐本 pool 口径）。 */
  | { kind: "authoritative"; balanceCoins: number }
  /** 读不到权威帐本（对应伺服器 503 quota_unavailable）；不得画成 0。 */
  | { kind: "unavailable"; reason: string }
  /** 估算值（本地快取／推算）：必带时效。 */
  | { kind: "estimated"; balanceCoins: number; asOf: number };

export interface QuotaDisplay {
  label: string;
  tone: QuotaTone;
  stale: boolean;
}

/** 不可用时的固定文案（单一真源；测试钉死不得含数字 0）。 */
export const QUOTA_UNAVAILABLE_LABEL = "暂不可用";

/** estimated 的时效门槛：超过视为 stale。 */
export const QUOTA_STALE_AFTER_MS = 5 * 60_000;

function unavailable(): QuotaDisplay {
  // stale=true：资料不是「权威且新鲜」的；展示层据此可弱化或提示重试。
  return { label: QUOTA_UNAVAILABLE_LABEL, tone: "unknown", stale: true };
}

function formatCoins(coins: number): string {
  return `${coins} 币`;
}

/**
 * 把额度状态翻成展示语义。纯函式：给定 state 与 now，输出恒定。
 *
 * 防御：任何非有限数字（NaN/Infinity）都不会被渲染成数字——authoritative/estimated
 * 的 balanceCoins 非有限时一律降级成 unavailable，不让 "NaN 币" 或假 0 上画面。
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
      // 执行期收到未预期的 kind（伺服器契约漂移）：宁可说不可用，也不画假数字。
      return unavailable();
    }
  }
}
