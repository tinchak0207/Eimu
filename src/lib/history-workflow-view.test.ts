// workflow 前端支援的单元测试：型别推断、缩图优先序、DAG 读取层、
// payload 级重跑对工作流记录的放宽与栏位剥除。
//
// 这里只测纯函数（history-types / history-rerun / history-workflow-view）。
// 元件的 JSX 渲染不在这里跑——本片没有起 dev server，视觉归使用者验收；
// 卡片/灯箱的缩图选择逻辑因此抽成纯函数在同一支测试里钉死。
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHistoryRerunPlan,
  canHistoryEntryRerun,
  historyRerunEstimate,
} from "./history-rerun.ts";
import { inferEntryKind, matchesHistoryQuery } from "./history-types.ts";
import {
  historyDagNodes,
  historyDagNodesTotalCoins,
  workflowDagThumbnailUrl,
} from "./history-workflow-view.ts";
import { IMAGE_MODEL_IDS, VIDEO_MODEL_IDS } from "./generation-model-catalog.ts";
import type { HistoryEntry } from "./history-types.ts";

const IMAGE_MODEL = IMAGE_MODEL_IDS[0];
const VIDEO_MODEL = VIDEO_MODEL_IDS[0];

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "entry-1",
    prompt: "Prompt:\n一只猫",
    generatedAt: 1_700_000_000_000,
    results: [
      { provider: "image_tinchak", modelId: IMAGE_MODEL, image: null, imageUrl: "https://example.com/a.png" },
    ],
    source: "server",
    ...overrides,
  };
}

/** 一条带 DAG 的工作流记录：source=workflow、workflow 上挂 dagNodes/dagThumbnailUrl。 */
function makeWorkflowEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return makeEntry({
    id: "wf-1",
    source: "workflow",
    entryKind: "workflow",
    modelId: IMAGE_MODEL,
    prompt: "Prompt:\n做一套商品主图",
    workflow: {
      imageSize: "1024x1024",
      qualityProfile: "balanced",
      dagThumbnailUrl: "https://blob.example.com/wf-1/dag.png",
      dagNodes: [
        { title: "生成主图", kind: "image", status: "succeeded", costCoins: 2 },
        { title: "生成场景图", kind: "image", status: "succeeded", costCoins: 3 },
      ],
      dagConnections: [{ from: "n1", to: "n2" }],
    },
    ...overrides,
  });
}

// ─────────────────────────────────── entryKind 筛选

test("entryKind filter keeps only the requested record kind", () => {
  const image = makeEntry({ id: "img-1" });
  const video = makeEntry({
    id: "vid-1",
    modelId: VIDEO_MODEL,
    results: [{ provider: "x", modelId: VIDEO_MODEL, image: null, imageUrl: null, videoUrl: "https://example.com/a.mp4" }],
  });
  const workflow = makeWorkflowEntry();

  // 三档互斥：各自只命中自己那一条。
  assert.equal(matchesHistoryQuery(image, { entryKind: "image" }), true);
  assert.equal(matchesHistoryQuery(video, { entryKind: "image" }), false);
  assert.equal(matchesHistoryQuery(workflow, { entryKind: "image" }), false);

  assert.equal(matchesHistoryQuery(video, { entryKind: "video" }), true);
  assert.equal(matchesHistoryQuery(image, { entryKind: "video" }), false);

  assert.equal(matchesHistoryQuery(workflow, { entryKind: "workflow" }), true);
  assert.equal(matchesHistoryQuery(image, { entryKind: "workflow" }), false);

  // 不带 entryKind ＝「全部」，三条都留下。
  for (const entry of [image, video, workflow]) {
    assert.equal(matchesHistoryQuery(entry, {}), true);
  }
});

test("video records are detected by videoUrl or mediaType, not by absence of an image", () => {
  const byUrl = makeEntry({
    results: [{ provider: "x", modelId: VIDEO_MODEL, image: null, imageUrl: null, videoUrl: "https://example.com/a.mp4" }],
  });
  const byMediaType = makeEntry({
    results: [{ provider: "x", modelId: VIDEO_MODEL, image: null, imageUrl: null, mediaType: "video" as const }],
  });
  const noResults = makeEntry({ results: [] });

  assert.equal(inferEntryKind(byUrl), "video");
  assert.equal(inferEntryKind(byMediaType), "video");
  // 空记录兜底成 image（判成 video 会让预设列表被空记录淹掉）。
  assert.equal(inferEntryKind(noResults), "image");
});

test("workflow records are detected from source or from dagNodes even after merging", () => {
  assert.equal(inferEntryKind(makeWorkflowEntry()), "workflow");

  // 归并后主记录可能是 server 面（source 不再是 workflow），但 DAG 结构还在。
  const merged = makeWorkflowEntry({ source: "server", entryKind: undefined });
  assert.equal(inferEntryKind(merged), "workflow");
});

// ─────────────────────────────────── 缩图优先序

test("workflow thumbnail wins over generated results", () => {
  const entry = makeWorkflowEntry();
  assert.equal(workflowDagThumbnailUrl(entry), "https://blob.example.com/wf-1/dag.png");
});

test("non-workflow records have no DAG thumbnail, and malformed values are ignored", () => {
  assert.equal(workflowDagThumbnailUrl(makeEntry()), null);
  // 后端漏写或写成空字串／非字串：一律当作没有，不回传假 URL。
  assert.equal(workflowDagThumbnailUrl(makeWorkflowEntry({ workflow: { dagThumbnailUrl: "" } })), null);
  assert.equal(workflowDagThumbnailUrl(makeWorkflowEntry({ workflow: { dagThumbnailUrl: undefined } })), null);
});

// ─────────────────────────────────── DAG 读取层

test("dag node list parses title/kind/status/costCoins and totals the paid coins", () => {
  const nodes = historyDagNodes(makeWorkflowEntry());
  assert.ok(nodes);
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes[0], { title: "生成主图", role: null, kind: "image", status: "succeeded", costCoins: 2 });
  assert.equal(historyDagNodesTotalCoins(nodes), 5);
});

test("dag node list is null when there is nothing to show, and tolerates junk entries", () => {
  assert.equal(historyDagNodes(makeEntry()), null);
  assert.equal(historyDagNodes(makeWorkflowEntry({ workflow: { dagNodes: [] } })), null);
  // 后端形状不受前端约束：混进非物件项目要跳过，不能让整页炸掉。
  const mixed = historyDagNodes(
    makeWorkflowEntry({ workflow: { dagNodes: [null, "x", 42, { title: "有效" }] } }),
  );
  assert.ok(mixed);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].title, "有效");
  assert.equal(mixed[0].costCoins, null, "缺 costCoins 时不得填 0 冒充实付");
});

test("dag node total is null when no node carries a paid amount", () => {
  const nodes = historyDagNodes(makeWorkflowEntry({ workflow: { dagNodes: [{ title: "a" }] } }));
  assert.equal(historyDagNodesTotalCoins(nodes), null);
  // 0 币是真实的实付值，必须与「没有资料」区分开。
  const zero = historyDagNodes(makeWorkflowEntry({ workflow: { dagNodes: [{ title: "a", costCoins: 0 }] } }));
  assert.equal(historyDagNodesTotalCoins(zero), 0);
});

// ─────────────────────────────────── 重跑放宽与栏位剥除

test("canHistoryEntryRerun lets workflow records through even without an image model", () => {
  // 影片模型仍然不可重跑（时长计费，预估口径不同）。
  assert.equal(
    canHistoryEntryRerun(
      makeEntry({
        prompt: "有提示词",
        results: [{ provider: "x", modelId: VIDEO_MODEL, image: null, imageUrl: null }],
      }),
    ),
    false,
  );
  // 工作流记录照样可重跑。
  assert.equal(canHistoryEntryRerun(makeWorkflowEntry()), true);
});

test("canHistoryEntryRerun still requires a prompt and a model for workflow records", () => {
  assert.equal(canHistoryEntryRerun(makeWorkflowEntry({ prompt: "   " })), false);
  assert.equal(canHistoryEntryRerun(makeWorkflowEntry({ modelId: undefined, results: [] })), false);
});

test("buildHistoryRerunPlan strips the front-end-only DAG fields before submit", () => {
  const plan = buildHistoryRerunPlan(makeWorkflowEntry());
  assert.ok(plan.workflow);
  // 这三个是前端展示／后端落盘用的，不是 /api/generation-jobs 的提交参数。
  assert.ok(!("dagNodes" in plan.workflow), "dagNodes 不该带进提交体");
  assert.ok(!("dagConnections" in plan.workflow), "dagConnections 不该带进提交体");
  assert.ok(!("dagThumbnailUrl" in plan.workflow), "dagThumbnailUrl 不该带进提交体");
  // 真正的配方栏位原样保留。
  assert.equal(plan.workflow.imageSize, "1024x1024");
  assert.equal(plan.workflow.qualityProfile, "balanced");
  // 实付/预估仍是各自算的，不因剥栏位而改变。
  assert.equal(typeof historyRerunEstimate(plan, 3), "number");
});
