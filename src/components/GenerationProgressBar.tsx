"use client";

export const NORMAL_PROGRESS_DURATION_MS = 50000;
export const FALLBACK_PROGRESS_DURATION_MS = 80000;

function easeOut(progress: number) {
  return 1 - Math.pow(1 - progress, 3);
}

// 生成完成前绝不报 100：进度是时间估算，提前满格会让排队/重试中的用户看到「卡 100%」。
export function calculateGenerationProgress(
  startedAt: number,
  now: number,
  durationMs = NORMAL_PROGRESS_DURATION_MS,
) {
  const elapsed = Math.max(0, now - startedAt);
  const ratio = Math.min(1, elapsed / Math.max(1, durationMs));
  if (ratio >= 1) return 99;
  return Math.max(1, Math.min(99, Math.round(easeOut(ratio) * 100)));
}
