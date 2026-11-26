/**
 * 等待进度契约（与 AgentBatchProgress 同一口径）：
 * - 无真分母 → indeterminate（流动指示，不报 %）
 * - 有真分母 → determinate（done/total → pct）
 * 禁止用时间估算冒充分母；禁止假 % 读屏（role=progressbar + 时间假 valuenow）。
 */

export type WaitingProgress =
  | { kind: "indeterminate" }
  | { kind: "determinate"; done: number; total: number; pct: number };

export function resolveWaitingProgress(
  done?: number,
  total?: number,
): WaitingProgress {
  const hasTotal =
    typeof total === "number" && Number.isFinite(total) && total > 0;
  if (!hasTotal) return { kind: "indeterminate" };
  const safeDone =
    typeof done === "number" && Number.isFinite(done) && done >= 0 ? done : 0;
  const pct = Math.min(100, Math.round((safeDone / (total as number)) * 100));
  return { kind: "determinate", done: safeDone, total: total as number, pct };
}
