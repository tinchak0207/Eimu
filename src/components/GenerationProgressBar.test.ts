import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWaitingProgress } from "@/lib/waiting-contract";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

test("generation progress durations remain for playground ETA auto-hide only", () => {
  const source = read("src/components/GenerationProgressBar.tsx");
  assert.match(source, /NORMAL_PROGRESS_DURATION_MS = 50000/);
  assert.match(source, /FALLBACK_PROGRESS_DURATION_MS = 80000/);
  // 时间假 % 已删除：不得再导出 calculateGenerationProgress / easeOut。
  assert.doesNotMatch(source, /export function calculateGenerationProgress|function easeOut/);
  // 旧元件不得回魂。
  assert.doesNotMatch(source, /fixed inset-x-0 bottom|约 50 秒|Stopwatch|generation-progress-stripes|repeating-linear-gradient|正在/);
  assert.doesNotMatch(source, /QuietRevealTheater|scroll-snap-type|reveal-smoke/);
});

test("particle sea waiting follows WaitingContract: no fake %% without real total", () => {
  const live = read("src/components/ParticleSeaWaiting.tsx");
  const contract = read("src/lib/waiting-contract.ts");
  assert.match(contract, /resolveWaitingProgress/);
  assert.match(live, /resolveWaitingProgress/);
  assert.match(live, /sea-waiting-indeterminate/);
  assert.match(live, /sea-waiting-hint/);
  assert.match(live, /把灵感变成画面/);
  // 与 AgentBatchProgress 同口径：无真分母不用 progressbar / aria-valuenow。
  assert.doesNotMatch(live, /role="progressbar"/);
  assert.doesNotMatch(live, /aria-valuenow/);
  assert.doesNotMatch(live, /calculateGenerationProgress/);
  assert.doesNotMatch(live, /Stopwatch|timing\.elapsed/);
  // 契约行为：无分母 → indeterminate；有分母 → pct。
  assert.equal(resolveWaitingProgress(undefined, undefined).kind, "indeterminate");
  assert.equal(resolveWaitingProgress(2, 0).kind, "indeterminate");
  const d = resolveWaitingProgress(1, 4);
  assert.equal(d.kind, "determinate");
  if (d.kind === "determinate") assert.equal(d.pct, 25);
});
