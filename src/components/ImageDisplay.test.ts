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
  const elapsedSecondsPattern = /timing\.elapsed\s*\/\s*1000|toFixed\(1\).*s/;
  const generationLabelCount = [displaySource, pickerSource, playgroundSource, progressSource]
    .join("\n")
    .match(/生成中/g)?.length ?? 0;
  // 生成中态已换成 ParticleSeaWaiting 粒子海（GenerationProgressBar 仅存留
  // 在 ParticleSeaWaiting 内部引用），断言跟随现场真实引用。
  assert.match(displaySource, /ParticleSeaWaiting/);
  assert.match(displaySource, /isRendering \? \(/);
  assert.doesNotMatch(displaySource, /Stopwatch/);
  assert.doesNotMatch(displaySource, elapsedSecondsPattern);
  assert.doesNotMatch(pickerSource, elapsedSecondsPattern);
  assert.equal(generationLabelCount, 1);
});
