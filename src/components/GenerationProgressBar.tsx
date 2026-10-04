"use client";

export const NORMAL_PROGRESS_DURATION_MS = 50000;
export const FALLBACK_PROGRESS_DURATION_MS = 80000;

function easeOut(progress: number) {
  return 1 - Math.pow(1 - progress, 3);
}

export function calculateGenerationProgress(
  startedAt: number,
  now: number,
  durationMs = NORMAL_PROGRESS_DURATION_MS,
) {
  const elapsed = Math.max(0, now - startedAt);
  const ratio = Math.min(1, elapsed / Math.max(1, durationMs));
  if (ratio >= 1) return 100;
  return Math.max(1, Math.min(99, Math.round(easeOut(ratio) * 100)));
}
