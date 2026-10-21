import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

test("image display download button never invokes native share", () => {
  const displaySource = read("src/components/ImageDisplay.tsx");
  const helperSource = read("src/lib/image-helpers.ts");
  assert.match(displaySource, /imageHelpers\.download/);
  assert.doesNotMatch(displaySource, /Share/);
  assert.doesNotMatch(helperSource, /navigator\.share/);
});

test("image display renders progress inside the result card without elapsed time", () => {
  const displaySource = read("src/components/ImageDisplay.tsx");
  const pickerSource = read("src/components/ModelPicker.tsx");
  const playgroundSource = read("src/components/ImagePlayground.tsx");
  const progressSource = read("src/components/GenerationProgressBar.tsx");
  const waitingSource = read("src/components/ParticleSeaWaiting.tsx");
  const elapsedSecondsPattern = /timing\.elapsed\s*\/\s*1000|toFixed\(1\).*s/;
  const generationLabelCount = [displaySource, pickerSource, playgroundSource, progressSource]
    .join("\n")
    .match(/生成中/g)?.length ?? 0;
  // 生成中态已换成 ParticleSeaWaiting 粒子海（GenerationProgressBar 的元件本体
  // 已在 81cd62a3 删除，只剩常数与计算函数）：旧「生成中」字样不得再散落在
  // 结果卡四档里，等待文案唯一落在活体粒子海（每次只出现一次）。
  assert.match(displaySource, /ParticleSeaWaiting/);
  assert.match(displaySource, /isRendering \? \(/);
  assert.doesNotMatch(displaySource, /Stopwatch/);
  assert.doesNotMatch(displaySource, elapsedSecondsPattern);
  assert.doesNotMatch(pickerSource, elapsedSecondsPattern);
  assert.equal(generationLabelCount, 0, "旧「生成中」字样不得残留在结果卡四档");
  assert.equal(
    waitingSource.match(/把灵感变成画面/g)?.length ?? 0,
    1,
    "等待文案必须由 ParticleSeaWaiting 唯一提供（恰好一处）",
  );
  assert.doesNotMatch(waitingSource, elapsedSecondsPattern, "粒子海不得显示 elapsed time");
});
