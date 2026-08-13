"use client";

import { useEffect, useState } from "react";

export const NORMAL_PROGRESS_DURATION_MS = 50000;
export const FALLBACK_PROGRESS_DURATION_MS = 80000;

interface GenerationProgressBarProps {
  visible: boolean;
  startedAt?: number;
  durationMs?: number;
}

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

export function GenerationProgressBar({
  visible,
  startedAt,
  durationMs = NORMAL_PROGRESS_DURATION_MS,
}: GenerationProgressBarProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [visible]);

  if (!visible || !startedAt) return null;

  const progress = calculateGenerationProgress(startedAt, now, durationMs);

  return (
    <div className="generation-progress-glass">
      <div className="generation-progress-header">
        <span className="generation-progress-dot" aria-hidden="true" />
        <span className="generation-progress-title">生成中</span>
        <span className="generation-progress-value">
          {progress}%
        </span>
      </div>
      <div
        className="generation-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        aria-label="生成进度"
      >
        <div className="generation-progress-fill" style={{ width: `${progress}%` }}>
          <span className="generation-progress-shine" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
