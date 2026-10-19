// Web durable 任务 prompt 组装的真行为断言（期望值是手写字面量，独立于被测实现）：
//   ① Web 主入口（use-image-generation 用 createGenerationWorkflow 组出的 workflow）带负面词/角色
//      → 交给 submitGenerationCommand 的 prompt 含 `Reference images:` 与 `Avoid:` 段，与 legacy 格式逐字一致；
//   ② canvas 形状（已预组、不送 workflow）→ 原样透传，不被重复套用；
//   ③ 历史/重跑显示还原用户原文；retry 合并带进的旧原文会被清掉。
// 真执行器：`npx tsx --test src/lib/web-task-prompt.test.ts`
import test from "node:test";
import assert from "node:assert/strict";
import { WORKFLOW_SCHEMA_VERSION, createGenerationWorkflow } from "./generation-workflow";
import { extractPromptSection } from "./workflow-recall";
import {
  composeWebTaskPrompt,
  displayGenerationPrompt,
  readRequestWorkflow,
  withOriginalPrompt,
} from "./web-task-prompt";

function webWorkflow() {
  // 与 use-image-generation.ts startGeneration 同一个 builder、同一组参数形状。
  return createGenerationWorkflow({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    negativePrompt: "blurry, watermark",
    estimatedCredits: 1,
    copies: 1,
    concurrency: 1,
  }, [{ id: "r1", name: "hero.png", role: "character", size: 10, file: new File([], "hero.png") } as never]);
}

test("Web durable：负面词与参考图角色进到供给 prompt（legacy 格式逐字）", () => {
  // multipart 路径的 workflow 经 JSON 往返（route.readBody → parseJson），这里同样走一次序列化。
  const requestWorkflow = readRequestWorkflow(JSON.parse(JSON.stringify(webWorkflow())));
  const submitted = composeWebTaskPrompt("a cat on the roof", requestWorkflow);
  assert.equal(
    submitted,
    "Prompt:\na cat on the roof\n\nReference images:\n- hero.png as character\n\nAvoid:\nblurry, watermark",
  );
});

test("JSON body 的 workflow 字串同样被读（legacy readWorkflowMetadata 同语义）", () => {
  const submitted = composeWebTaskPrompt("cat", readRequestWorkflow(JSON.stringify({ negativePrompt: "blur" })));
  assert.equal(submitted, "Prompt:\ncat\n\nAvoid:\nblur");
});

test("canvas 形状：已预组 prompt、不送 workflow → 原样透传，不重复套用", () => {
  const canvasPrecomposed = "Prompt:\na cat\n\nReference images:\n- ref.png as style\n\nAvoid:\nblur";
  const submitted = composeWebTaskPrompt(canvasPrecomposed, readRequestWorkflow(undefined));
  assert.equal(submitted, canvasPrecomposed);
  assert.equal(submitted.match(/Avoid:/g)?.length, 1);
  assert.equal(submitted.match(/Prompt:/g)?.length, 1);
  // 不落原文栏位（没有组过），显示即 job prompt 本身。
  const stored = withOriginalPrompt({ references: [] }, canvasPrecomposed, submitted);
  assert.equal("originalPrompt" in stored, false);
});

test("历史/重跑显示：还原用户原文，不是组好的长 prompt", () => {
  const raw = "a cat on the roof";
  const submitted = composeWebTaskPrompt(raw, readRequestWorkflow({ negativePrompt: "blur" }));
  const stored = withOriginalPrompt({ negativePrompt: "blur" }, raw, submitted);
  assert.equal(stored.originalPrompt, raw);
  const shown = displayGenerationPrompt(submitted, stored);
  assert.equal(shown, raw);
  // 重跑对话框/再来一组以 extractPromptSection 取原文：再送回来也只组一次。
  const rerunPrompt = extractPromptSection(shown ?? "");
  assert.equal(rerunPrompt, raw);
  const resubmitted = composeWebTaskPrompt(rerunPrompt, readRequestWorkflow(stored));
  assert.equal(resubmitted, "Prompt:\na cat on the roof\n\nAvoid:\nblur");
});

test("retry 合并带进的旧原文：本单没组就移除，本单组了就换成本单原文", () => {
  const stale = { originalPrompt: "old prompt", references: [] };
  assert.equal("originalPrompt" in withOriginalPrompt(stale, "new", "new"), false);
  assert.equal(withOriginalPrompt(stale, "new", "Prompt:\nnew").originalPrompt, "new");
});

test("存量任务（无原文栏位）显示不变", () => {
  assert.equal(displayGenerationPrompt("plain", { references: [] }), "plain");
  assert.equal(displayGenerationPrompt("plain", null), "plain");
});
