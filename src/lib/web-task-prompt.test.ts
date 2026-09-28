// Web durable 任務 prompt 組裝的真行為斷言（期望值是手寫字面量，獨立於被測實現）：
//   ① Web 主入口（use-image-generation 用 createGenerationWorkflow 組出的 workflow）帶負面詞/角色
//      → 交給 submitGenerationCommand 的 prompt 含 `Reference images:` 與 `Avoid:` 段，與 legacy 格式逐字一致；
//   ② canvas 形狀（已預組、不送 workflow）→ 原樣透傳，不被重複套用；
//   ③ 歷史/重跑顯示還原用戶原文；retry 合併帶進的舊原文會被清掉。
// 真執行器：`npx tsx --test src/lib/web-task-prompt.test.ts`
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
  // 與 use-image-generation.ts startGeneration 同一個 builder、同一組參數形狀。
  return createGenerationWorkflow({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    negativePrompt: "blurry, watermark",
    estimatedCredits: 1,
    copies: 1,
    concurrency: 1,
  }, [{ id: "r1", name: "hero.png", role: "character", size: 10, file: new File([], "hero.png") } as never]);
}

test("Web durable：負面詞與參考圖角色進到供給 prompt（legacy 格式逐字）", () => {
  // multipart 路徑的 workflow 經 JSON 往返（route.readBody → parseJson），這裡同樣走一次序列化。
  const requestWorkflow = readRequestWorkflow(JSON.parse(JSON.stringify(webWorkflow())));
  const submitted = composeWebTaskPrompt("a cat on the roof", requestWorkflow);
  assert.equal(
    submitted,
    "Prompt:\na cat on the roof\n\nReference images:\n- hero.png as character\n\nAvoid:\nblurry, watermark",
  );
});

test("JSON body 的 workflow 字串同樣被讀（legacy readWorkflowMetadata 同語義）", () => {
  const submitted = composeWebTaskPrompt("cat", readRequestWorkflow(JSON.stringify({ negativePrompt: "blur" })));
  assert.equal(submitted, "Prompt:\ncat\n\nAvoid:\nblur");
});

test("canvas 形狀：已預組 prompt、不送 workflow → 原樣透傳，不重複套用", () => {
  const canvasPrecomposed = "Prompt:\na cat\n\nReference images:\n- ref.png as style\n\nAvoid:\nblur";
  const submitted = composeWebTaskPrompt(canvasPrecomposed, readRequestWorkflow(undefined));
  assert.equal(submitted, canvasPrecomposed);
  assert.equal(submitted.match(/Avoid:/g)?.length, 1);
  assert.equal(submitted.match(/Prompt:/g)?.length, 1);
  // 不落原文欄位（沒有組過），顯示即 job prompt 本身。
  const stored = withOriginalPrompt({ references: [] }, canvasPrecomposed, submitted);
  assert.equal("originalPrompt" in stored, false);
});

test("歷史/重跑顯示：還原用戶原文，不是組好的長 prompt", () => {
  const raw = "a cat on the roof";
  const submitted = composeWebTaskPrompt(raw, readRequestWorkflow({ negativePrompt: "blur" }));
  const stored = withOriginalPrompt({ negativePrompt: "blur" }, raw, submitted);
  assert.equal(stored.originalPrompt, raw);
  const shown = displayGenerationPrompt(submitted, stored);
  assert.equal(shown, raw);
  // 重跑對話框/再來一組以 extractPromptSection 取原文：再送回來也只組一次。
  const rerunPrompt = extractPromptSection(shown ?? "");
  assert.equal(rerunPrompt, raw);
  const resubmitted = composeWebTaskPrompt(rerunPrompt, readRequestWorkflow(stored));
  assert.equal(resubmitted, "Prompt:\na cat on the roof\n\nAvoid:\nblur");
});

test("retry 合併帶進的舊原文：本單沒組就移除，本單組了就換成本單原文", () => {
  const stale = { originalPrompt: "old prompt", references: [] };
  assert.equal("originalPrompt" in withOriginalPrompt(stale, "new", "new"), false);
  assert.equal(withOriginalPrompt(stale, "new", "Prompt:\nnew").originalPrompt, "new");
});

test("存量任務（無原文欄位）顯示不變", () => {
  assert.equal(displayGenerationPrompt("plain", { references: [] }), "plain");
  assert.equal(displayGenerationPrompt("plain", null), "plain");
});
