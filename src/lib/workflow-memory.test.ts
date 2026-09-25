import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKFLOW_MEMORY_BODY_MAX,
  WORKFLOW_MIN_NON_EMPTY_SLOTS,
  countWorkflowFilledSlots,
  extractWorkflowMemoryBody,
  shouldPersistWorkflow,
} from "./workflow-memory.ts";

const RECALL_CONFIG = {
  prompt: "一只橘猫坐在窗台上，晨光，胶片质感",
  negativePrompt: "模糊, 多余手指",
  workflowPreset: "商品摄影",
  imageSize: "1536x1024",
  qualityProfile: "print",
  copies: 4,
};

test("extractWorkflowMemoryBody serializes the six-slot config as machine text", () => {
  const body = extractWorkflowMemoryBody({
    name: "商品摄影跑批",
    config: RECALL_CONFIG,
    dagNodes: [{ role: "planner", kind: "text" }, { role: "render", kind: "image" }],
    dagConnections: [{ from: "planner", to: "render" }],
  });
  assert.ok(body.startsWith("[workflow] name=商品摄影跑批"));
  assert.ok(body.includes(`config=${JSON.stringify(RECALL_CONFIG)}`));
  assert.ok(body.includes("nodes=planner:text | render:image"));
  assert.ok(body.includes("connections=1"));
  assert.ok(body.length <= WORKFLOW_MEMORY_BODY_MAX);
  // 非自然语言：body 里没有散文标记，config 段可被 JSON.parse 还原。
  const configLine = body.split("\n").find((line) => line.startsWith("config="));
  assert.deepEqual(JSON.parse(configLine!.slice("config=".length)), RECALL_CONFIG);
});

test("extractWorkflowMemoryBody tolerates empty config and missing name", () => {
  const body = extractWorkflowMemoryBody({ name: "", config: {} });
  assert.equal(body, "[workflow] name=(unnamed)\nconfig={}");
  assert.ok(body.length <= WORKFLOW_MEMORY_BODY_MAX);

  const noNodes = extractWorkflowMemoryBody({ name: "x", config: { prompt: "p" }, dagNodes: [] });
  assert.ok(!noNodes.includes("nodes="));
});

test("extractWorkflowMemoryBody truncates overlong config instead of throwing", () => {
  const huge = {
    prompt: "长".repeat(3000),
    contextPrompt: "篇幅".repeat(1500),
    regionalPrompts: Array.from({ length: 8 }, (_, i) => ({ text: `区域提示${i}`.repeat(40), weight: i + 1 })),
  };
  const body = extractWorkflowMemoryBody({ name: "超长", config: huge });
  assert.ok(body.length <= WORKFLOW_MEMORY_BODY_MAX, `body length ${body.length}`);
  assert.ok(body.includes("config_truncated=true"));
  // config 内部被截到 CONFIG_BUDGET，整体仍 ≤2000，尾端是 config_truncated 而非 `...`。
  const configLine = body.split("\n").find((line) => line.startsWith("config="));
  assert.ok(configLine!.length < 1400 + 20);
});

test("extractWorkflowMemoryBody hard-cuts with `...` when even the header+config overflows", () => {
  // name 本身超长（不被预算保护的字段）→ 走硬截断兜底路径。
  const body = extractWorkflowMemoryBody({ name: "N".repeat(3000), config: RECALL_CONFIG, dagNodes: [] });
  assert.ok(body.length <= WORKFLOW_MEMORY_BODY_MAX, `body length ${body.length}`);
  assert.ok(body.endsWith("..."));
  assert.ok(!body.includes("nodes="));
});

test("extractWorkflowMemoryBody keeps dag nodes within budget and drops them before config", () => {
  const nodes = Array.from({ length: 400 }, (_, i) => ({ role: `node-${i}`, kind: "image" }));
  const body = extractWorkflowMemoryBody({ name: "多节点", config: RECALL_CONFIG, dagNodes: nodes });
  assert.ok(body.length <= WORKFLOW_MEMORY_BODY_MAX, `body length ${body.length}`);
  assert.ok(body.includes("[workflow] name=多节点"));
  assert.ok(body.includes("config="));
  assert.ok(body.includes("nodes truncated"));
  // config 优先保留：超预算时先砍节点，config JSON 逐字在场。
  assert.ok(body.includes(JSON.stringify(RECALL_CONFIG)));
});

test("extractWorkflowMemoryBody survives non-serializable and non-record config", () => {
  const cyclic: Record<string, unknown> = { prompt: "p" };
  cyclic.self = cyclic;
  const body = extractWorkflowMemoryBody({ name: "环", config: cyclic });
  assert.ok(body.includes("config={}"));
  assert.ok(body.length <= WORKFLOW_MEMORY_BODY_MAX);

  const wrongType = extractWorkflowMemoryBody({ name: "坏", config: null as unknown as Record<string, unknown> });
  assert.equal(wrongType, "[workflow] name=坏\nconfig={}");
});

test("shouldPersistWorkflow requires a prompt plus two filled slots", () => {
  assert.equal(shouldPersistWorkflow(RECALL_CONFIG), true);
  assert.equal(shouldPersistWorkflow({ prompt: "p", imageSize: "1024x1024" }), true);
  assert.equal(shouldPersistWorkflow({ prompt: "p" }), false);
  assert.equal(shouldPersistWorkflow({ prompt: "   ", imageSize: "1024x1024" }), false);
  assert.equal(shouldPersistWorkflow({ imageSize: "1024x1024", copies: 4 }), false);
  assert.equal(shouldPersistWorkflow({}), false);
  assert.equal(shouldPersistWorkflow(null), false);
  assert.equal(shouldPersistWorkflow(undefined), false);
});

test("countWorkflowFilledSlots counts only substantive values", () => {
  assert.equal(countWorkflowFilledSlots(RECALL_CONFIG), 6);
  assert.equal(countWorkflowFilledSlots({ prompt: "p", copies: 0, imageSizes: [], styleTemplate: "  " }), 2);
  assert.equal(countWorkflowFilledSlots(undefined), 0);
  assert.equal(WORKFLOW_MIN_NON_EMPTY_SLOTS, 2);
});
