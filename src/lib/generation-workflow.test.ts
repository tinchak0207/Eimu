import test from "node:test";
import assert from "node:assert/strict";

import {
  WORKFLOW_SCHEMA_VERSION,
  createGenerationWorkflow,
  buildWorkflowPrompt,
  extractWorkflowRunConfig,
  normalizeWorkflowConnections,
  projectWorkflowRunToHistory,
  workflowHistoryEntryId,
} from "./generation-workflow.ts";

test("createGenerationWorkflow enriches enterprise preset metadata", () => {
  const workflow = createGenerationWorkflow(
    {
      contextPrompt: "Brand: clean skincare",
      negativePrompt: "bad label",
      negativeHint: "no watermark",
      workflowPreset: "product-shot",
      workflowPresetLabel: "商品主图",
      promptHint: "premium bottle, clean studio light",
      productionIntent: "ecommerce",
      imageSize: "1536x1024",
      qualityProfile: "print",
      seedHint: "campaign-2026-hero",
      copies: 12,
      concurrency: 9,
    },
    [
      {
        id: "ref-1",
        name: "bottle.png",
        file: new File(["x"], "bottle.png", { type: "image/png" }),
        previewUrl: "blob:ref",
        size: 12,
        role: "product",
      },
    ],
  );

  assert.equal(workflow?.schemaVersion, WORKFLOW_SCHEMA_VERSION);
  assert.equal(workflow?.workflowPreset, "product-shot");
  assert.equal(workflow?.workflowPresetLabel, "商品主图");
  assert.equal(workflow?.promptHint, "premium bottle, clean studio light");
  assert.equal(workflow?.productionIntent, "ecommerce");
  assert.equal(workflow?.imageSize, "1536x1024");
  assert.equal(workflow?.qualityProfile, "print");
  assert.equal(workflow?.seedHint, "campaign-2026-hero");
  assert.equal(workflow?.negativeHint, "no watermark");
  assert.equal(workflow?.estimatedCredits, 8);
  assert.equal(workflow?.copies, 8);
  assert.equal(workflow?.concurrency, 4);
  assert.equal(workflow?.referenceImages?.[0]?.role, "product");
});

test("buildWorkflowPrompt includes preset and hint guidance without leaking unsupported fields separately", () => {
  const prompt = buildWorkflowPrompt("Generate a product hero image", {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    workflowPreset: "product-shot",
    workflowPresetLabel: "商品主图",
    promptHint: "studio lighting, readable packaging",
    productionIntent: "ecommerce",
    imageSize: "1024x1536",
    qualityProfile: "print",
    seedHint: "repeatable hero setup",
    negativeHint: "no logo distortion",
    negativePrompt: "no watermark",
    referenceImages: [{ name: "bottle.png", role: "product", size: 12 }],
  });

  assert.match(prompt, /Workflow preset: 商品主图/);
  assert.match(prompt, /Preset guidance:/);
  assert.match(prompt, /studio lighting/);
  assert.match(prompt, /Production profile:/);
  assert.match(prompt, /ecommerce/);
  assert.match(prompt, /1024x1536/);
  assert.match(prompt, /print/);
  assert.match(prompt, /repeatable hero setup/);
  assert.match(prompt, /Avoid:/);
  assert.match(prompt, /no logo distortion/);
  assert.match(prompt, /bottle\.png as product/);
});

// ─────────────────────── 工作流跑批推送投影（2026-09-20 Phase 2）───────────

test("projectWorkflowRunToHistory 投影 gateway payload（{from,to} 形状）", () => {
  const payload = {
    workflowId: "wf-abc123",
    templateId: "feature_film",
    sessionId: "ses_x",
    status: "success" as const,
    nodes: [
      { id: "feature_film-script-0", role: "script", kind: "text", title: "故事脚本", status: "succeeded" },
      { id: "feature_film-shot1_gen-10", role: "shot1_gen", kind: "config", title: "镜头 1 配置", status: "succeeded", costCoins: 5 },
      { id: "feature_film-shot1_video-11", role: "shot1_video", kind: "video", title: "镜头 1 影片", status: "failed", error: "upstream 502" },
    ],
    // workflow-engine.expandTemplate 展开后的真形状：端点已经是 nodeId。
    connections: [
      { from: "feature_film-script-0", to: "feature_film-shot1_gen-10" },
      { from: "feature_film-shot1_gen-10", to: "feature_film-shot1_video-11" },
    ],
    totalCostCoins: 5,
    completedAt: "2026-09-20T10:00:00.000Z",
  };

  const projected = projectWorkflowRunToHistory(payload);

  assert.equal(projected.dagNodes.length, 3);
  assert.deepEqual(projected.dagConnections, [
    { from: "feature_film-script-0", to: "feature_film-shot1_gen-10" },
    { from: "feature_film-shot1_gen-10", to: "feature_film-shot1_video-11" },
  ]);
  assert.equal(projected.workflow.workflowId, "wf-abc123");
  assert.equal(projected.workflow.templateId, "feature_film");
  assert.equal(projected.workflow.totalCostCoins, 5);
  assert.equal(projected.workflow.dagNodes?.length, 3);
  assert.equal(projected.workflow.dagConnections?.length, 2);
  assert.equal(projected.dagNodes[1].costCoins, 5);
  assert.equal(projected.dagNodes[2].error, "upstream 502");
});

test("normalizeWorkflowConnections 把 fromRole/toRole 转成 nodeId（role→id 映射）", () => {
  const nodes = [
    { id: "single_image-prompt-0", role: "prompt", kind: "text", title: "提示词" },
    { id: "single_image-generation-1", role: "generation", kind: "config", title: "生成配置" },
    { id: "single_image-result-2", role: "result", kind: "image", title: "图片" },
  ];
  // workflow-templates.ts 的模板原始形状（role 而非 id）——gateway 若改推模板层
  // 资料或 agent 手动加连线时会出现。
  const connections = [
    { fromRole: "prompt", toRole: "generation" },
    { fromRole: "generation", toRole: "result" },
  ];

  assert.deepEqual(normalizeWorkflowConnections(nodes, connections), [
    { from: "single_image-prompt-0", to: "single_image-generation-1" },
    { from: "single_image-generation-1", to: "single_image-result-2" },
  ]);
});

test("normalizeWorkflowConnections 缺栏位/孤儿边/自环/重复一律容错", () => {
  const nodes = [
    { id: "n1", role: "a", kind: "text", title: "A" },
    { id: "n2", role: "b", kind: "image", title: "B" },
  ];
  const connections = [
    { fromRole: "a", toRole: "b" },
    { from: "n1", to: "n2" },       // 与上一条同边（不同形状）→ 去重
    { from: "n1", to: "n1" },       // 自环 → 丢
    { from: "ghost", to: "n2" },    // 孤儿边 → 丢
    { fromRole: "ghost", toRole: "b" }, // role 不存在 → 丢
    { to: "n2" },                   // 缺起点 → 丢
    {} as { from?: string; to?: string },
  ];

  assert.deepEqual(normalizeWorkflowConnections(nodes, connections), [{ from: "n1", to: "n2" }]);
  // connections 缺栏位（undefined / 非阵列）→ 空阵列，不抛。
  assert.deepEqual(normalizeWorkflowConnections(nodes, undefined), []);
  assert.deepEqual(normalizeWorkflowConnections(nodes, null as never), []);
});

test("projectWorkflowRunToHistory 缺栏位容错：无 connections / 节点缺 id / 无 totalCostCoins", () => {
  const projected = projectWorkflowRunToHistory({
    workflowId: "wf-min",
    status: "partial",
    nodes: [
      { id: "only", role: "prompt", kind: "text", title: "只有标题" },
      { id: "   ", role: "ghost" },     // id 为空白 → 丢
      { role: "no-id" },                // 缺 id → 丢
    ],
  });

  assert.equal(projected.dagNodes.length, 1);
  assert.equal(projected.dagNodes[0].id, "only");
  assert.deepEqual(projected.dagConnections, []);
  assert.equal(projected.workflow.totalCostCoins, undefined);
  assert.ok(!("totalCostCoins" in projected.workflow));
  // 没有 nodes 也不抛（route 已在前置校验挡掉，这里防御纵深）。
  assert.deepEqual(projectWorkflowRunToHistory({ workflowId: "wf-x", status: "success" }).dagNodes, []);
});

test("workflowHistoryEntryId 由 workflowId 派生（等键）", () => {
  assert.equal(workflowHistoryEntryId("wf-abc123"), "workflow-wf-abc123");
  assert.equal(workflowHistoryEntryId("  wf-abc123  "), "workflow-wf-abc123");
});

// ───────────────────────────────── 记忆回路：config 反推

test("extractWorkflowRunConfig 从 text 节点取 prompt、config 节点取参数（记忆 body 的原料）", () => {
  const config = extractWorkflowRunConfig([
    { id: "n1", role: "prompt", kind: "text", title: "提示词", content: "一只戴帽子的猫" },
    {
      id: "n2",
      role: "generation",
      kind: "config",
      title: "生成配置",
      metadata: { model: "pixai-tsubaki2", size: "1024x1024", count: 1, kind: "image", unit_price_coins: 0.001 },
    },
    { id: "n3", role: "out", kind: "image", title: "成图" },
  ]);

  assert.equal(config.prompt, "一只戴帽子的猫");
  assert.equal(config.model, "pixai-tsubaki2");
  assert.equal(config.size, "1024x1024");
  assert.equal(config.count, 1);
  assert.deepEqual(config.nodeShape, ["prompt:text", "generation:config", "out:image"]);
});

test("extractWorkflowRunConfig 只收纯量与短数组，长字符串/嵌套对象不进 body 预算", () => {
  const config = extractWorkflowRunConfig([
    { id: "n1", role: "p", kind: "text", content: "ok" },
    {
      id: "n2",
      role: "cfg",
      kind: "config",
      metadata: {
        model: "m",
        huge: "x".repeat(700),          // 超 600 → 丢
        nested: { a: { b: 1 } },        // 对象 → 丢
        longList: Array.from({ length: 20 }, (_, i) => `i${i}`), // 超 16 → 丢
        shortList: ["a", "b"],          // 保留
      },
    },
  ]);

  assert.equal(config.model, "m");
  assert.equal(config.huge, undefined);
  assert.equal(config.nested, undefined);
  assert.equal(config.longList, undefined);
  assert.deepEqual(config.shortList, ["a", "b"]);
});

test("extractWorkflowRunConfig 缺栏位容错：无 text/config 节点、无 content、空数组都不抛", () => {
  assert.deepEqual(extractWorkflowRunConfig(undefined), {});
  assert.deepEqual(extractWorkflowRunConfig([]), {});
  // 只有 text 节点但没有 content → 不出 prompt 键
  const onlyShape = extractWorkflowRunConfig([{ id: "n", role: "r", kind: "text" }]);
  assert.ok(!("prompt" in onlyShape));
  assert.deepEqual(onlyShape.nodeShape, ["r:text"]);
});

test("记忆回路端到端：run config → shouldPersist → body 生成，全链可过闸门", async () => {
  const { extractWorkflowMemoryBody, shouldPersistWorkflow, WORKFLOW_MEMORY_BODY_MAX } = await import(
    "./workflow-memory.ts"
  );
  const { projectWorkflowRunToHistory } = await import("./generation-workflow.ts");

  const payload = {
    workflowId: "wf-e2e-1",
    templateId: "novel_film",
    status: "success" as const,
    nodes: [
      { id: "n1", role: "script", kind: "text", title: "剧本", content: "第一章：暴雨夜，侦探推开门。" },
      { id: "n2", role: "gen", kind: "config", title: "影片配置", metadata: { model: "minimax-h3", size: "16:9", kind: "video", duration_seconds: 5 } },
    ],
    connections: [{ from: "n1", to: "n2" }],
  };

  const config = extractWorkflowRunConfig(payload.nodes);
  // 闸门：prompt 非空 且 >=2 个非空槽 → 值得存
  assert.equal(shouldPersistWorkflow(config), true);

  const { dagNodes, dagConnections } = projectWorkflowRunToHistory(payload);
  const body = extractWorkflowMemoryBody({
    name: payload.templateId,
    config,
    dagNodes,
    dagConnections,
  });

  // 结构防线（agent-memory-store.isStructurallyValid）的硬约束
  assert.ok(body.length > 0 && body.length <= WORKFLOW_MEMORY_BODY_MAX);
  assert.match(body, /\[workflow\] name=novel_film/);
  assert.match(body, /侦探推开门/);
  assert.match(body, /minimax-h3/);
  // config 段必须是可 JSON.parse 的完整 JSON（未被切半）
  const jsonLine = body.split("\n").find((l) => l.startsWith("config="));
  assert.ok(jsonLine);
  assert.doesNotThrow(() => JSON.parse(jsonLine!.slice("config=".length)));
});

test("记忆回路闸门负例：只有 config 没有 prompt 时不沉淀", async () => {
  const { shouldPersistWorkflow } = await import("./workflow-memory.ts");
  const config = extractWorkflowRunConfig([
    { id: "n2", role: "gen", kind: "config", metadata: { model: "m", size: "1x1" } },
  ]);
  assert.equal(shouldPersistWorkflow(config), false);
});

test("ownerKey 两端收敛：gateway 的 hash(state.apiKey) 必须等于站点的 deriveMemoryOwnerKey", async () => {
  const { createHash } = await import("node:crypto");
  const { deriveMemoryOwnerKey, hashMemoryOwnerKey } = await import("./agent-memory-injection.ts");

  // gateway 侧算法（deploy-staging/gateway/workflow-gw.ts 的 memoryOwnerKeyHash）
  const gatewayOwnerKey = (apiKey: string) =>
    createHash("sha256").update(apiKey, "utf8").digest().subarray(0, 12).toString("hex");

  // state.apiKey 是站点 getOrCreateAgentKeyForUser 签发的 sk-biz- 派生 key，
  // 正典化对它是恒等（defaultCanonicalKeyResolver 认得它、还原回同一把），
  // 因此 deriveMemoryOwnerKey 收敛到 hash(同一把 key)。
  const derivedKey = "sk-biz-0123456789abcdef0123456789abcdef";
  const siteOwnerKey = await deriveMemoryOwnerKey(derivedKey, async (raw) => raw);

  assert.equal(siteOwnerKey, hashMemoryOwnerKey(derivedKey));
  assert.equal(gatewayOwnerKey(derivedKey), siteOwnerKey, "gateway 与站点的 ownerKey 必须逐字相同，否则记忆写了召不回");
  // 形状：24 字元小写 hex（契约 §1）
  assert.match(siteOwnerKey!, /^[0-9a-f]{24}$/);
});
