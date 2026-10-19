import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

test("generation progress bar uses nonlinear normal and fallback durations", () => {
  const source = read("src/components/GenerationProgressBar.tsx");
  assert.match(source, /NORMAL_PROGRESS_DURATION_MS = 50000/);
  assert.match(source, /FALLBACK_PROGRESS_DURATION_MS = 80000/);
  assert.match(source, /durationMs/);
  assert.match(source, /easeOut/);
  assert.match(source, /role="progressbar"/);
  assert.match(source, /aria-valuenow={progress}/);
  assert.match(source, /generation-progress-glass/);
  assert.match(source, /generation-progress-shine/);
  assert.doesNotMatch(source, /fixed inset-x-0 bottom|约 50 秒|Stopwatch|generation-progress-stripes|repeating-linear-gradient|正在/);
  assert.doesNotMatch(source, /QuietRevealTheater|scroll-snap-type|reveal-smoke/);
});
