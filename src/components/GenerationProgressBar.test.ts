import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

test("generation progress bar uses nonlinear normal and fallback durations", () => {
  const source = read("src/components/GenerationProgressBar.tsx");
  // 非线性时长与 easeOut 仍在唯一真源（常数 + 纯函数）。
  assert.match(source, /NORMAL_PROGRESS_DURATION_MS = 50000/);
  assert.match(source, /FALLBACK_PROGRESS_DURATION_MS = 80000/);
  assert.match(source, /durationMs/);
  assert.match(source, /easeOut/);
  // 2026-10-04 死代码清除（81cd62a3）：GenerationProgressBar 的元件本体已删，
  // 只保留常数与 calculateGenerationProgress；活的进度条 UI 是 ParticleSeaWaiting。
  // 无障碍语义（progressbar / aria-valuenow）与非线性进度一起钉在活体上。
  const live = read("src/components/ParticleSeaWaiting.tsx");
  assert.match(live, /role="progressbar"/);
  assert.match(live, /aria-valuenow={progress}/);
  assert.match(live, /calculateGenerationProgress\(startedAt, now, durationMs\)/);
  assert.match(live, /sea-waiting-value/);
  assert.match(live, /sea-waiting-hint/);
  // 旧元件不得回魂：固定底栏、秒数读表、旧条纹视觉。
  assert.doesNotMatch(source, /fixed inset-x-0 bottom|约 50 秒|Stopwatch|generation-progress-stripes|repeating-linear-gradient|正在/);
  assert.doesNotMatch(source, /QuietRevealTheater|scroll-snap-type|reveal-smoke/);
  // 活体进度条同样不得显示 elapsed time（进度只来自计算函数）。
  assert.doesNotMatch(live, /Stopwatch|timing\.elapsed/);
});
