// generatedImageMetadata：生成结果 → 节点 metadata 补丁（imageTaskId＝LOD3 工程透析的 job 指针）。
// 真执行器：`npx tsx --test src/lib/canvas/generated-image-metadata.test.ts`

import test from "node:test";
import assert from "node:assert/strict";
import { generatedImageMetadata } from "./generated-image-metadata";

const base = { url: "https://cdn.test/a.png", cost_coins: 3, natural_width: 1024, natural_height: 768 };

test("durable 结果：job id 落为 imageTaskId，其余栏位照旧", () => {
  assert.deepEqual(generatedImageMetadata({ ...base, task_id: "job-1" }), {
    cost_coins: 3,
    naturalWidth: 1024,
    naturalHeight: 768,
    imageTaskId: "job-1",
  });
});

test("legacy 结果（task_id: null）：imageTaskId 明确为 undefined，清掉重生成前的旧指针", () => {
  const patch = generatedImageMetadata({ ...base, task_id: null });
  assert.ok("imageTaskId" in patch);
  assert.equal(patch.imageTaskId, undefined);
});

test("旧回应缺 task_id／空白字串：不编造指针", () => {
  assert.equal(generatedImageMetadata(base).imageTaskId, undefined);
  assert.equal(generatedImageMetadata({ ...base, task_id: "  " }).imageTaskId, undefined);
});

test("cost/尺寸缺席不写键", () => {
  const patch = generatedImageMetadata({ url: "u", cost_coins: null, natural_width: null, natural_height: null, task_id: "j" });
  assert.deepEqual(Object.keys(patch).sort(), ["imageTaskId"]);
});
