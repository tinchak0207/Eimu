// 语义节点（prompt / reference）纯逻辑测试：
//   - 连线接线语义：prompt 前缀注入、reference 图+角色自动带入
//   - 去重合并（手动 @引用优先，连线自动带入其次）
//   - 节点创建预设（CANVAS_NODE_DEFAULT_SIZE 新型别条目）
//   - 向后兼容：旧数据（无新栏位/未知角色）载入不炸、未知 type 退 text
import { test } from "node:test";
import assert from "node:assert/strict";
import { CanvasNodeType, CANVAS_NODE_DEFAULT_SIZE } from "./types";
import type { CanvasConnection, CanvasNode } from "./types";
import { normalizeCanvasEvent, toNodeType } from "./layout";
import {
  composeGenerationPrompt,
  mergeGenerationReferences,
  referenceImageUrlOf,
  resolveGenerationInputs,
  type CanvasGenerationReference,
} from "./semantic-nodes";

function node(id: string, type: CanvasNodeType, metadata: CanvasNode["metadata"] = {}): CanvasNode {
  return { id, type, title: id, position: { x: 0, y: 0 }, width: 340, height: 240, metadata };
}

function conn(id: string, from: string, to: string): CanvasConnection {
  return { id, fromNodeId: from, toNodeId: to };
}

test("resolveGenerationInputs：连入的 prompt 节点文本成为前缀来源", () => {
  const nodes = [
    node("p1", CanvasNodeType.Prompt, { content: "电影感光效，35mm 胶片" }),
    node("p2", CanvasNodeType.Prompt, { content: "  " }), // 空文本 → 跳过
    node("p3", CanvasNodeType.Prompt, { content: "低饱和青橙调" }),
    node("t1", CanvasNodeType.Text, { content: "普通文本不注入" }),
    node("gen", CanvasNodeType.Image, {}),
  ];
  const conns = [conn("c1", "p1", "gen"), conn("c2", "p2", "gen"), conn("c3", "p3", "gen"), conn("c4", "t1", "gen")];
  const { promptParts, references } = resolveGenerationInputs(nodes, conns, "gen");
  assert.deepEqual(promptParts, ["电影感光效，35mm 胶片", "低饱和青橙调"]);
  assert.equal(references.length, 0);
});

test("resolveGenerationInputs：连入的 reference 节点带图+角色；image/text 节点不自动带入", () => {
  const nodes = [
    node("r1", CanvasNodeType.Reference, { content: "https://img.example/char.png", referenceRole: "character" }),
    node("r2", CanvasNodeType.Reference, { content: "https://img.example/style.png" }), // 未设角色 → general
    node("r3", CanvasNodeType.Reference, { content: "https://img.example/x.png", referenceRole: "bogus" }), // 非法角色 → general
    node("r4", CanvasNodeType.Reference, { content: "" }), // 无图 → 跳过
    node("i1", CanvasNodeType.Image, { content: "https://img.example/plain.png" }),
    node("gen", CanvasNodeType.Image, {}),
  ];
  const conns = [
    conn("c1", "r1", "gen"),
    conn("c2", "r2", "gen"),
    conn("c3", "r3", "gen"),
    conn("c4", "r4", "gen"),
    conn("c5", "i1", "gen"),
  ];
  const { references } = resolveGenerationInputs(nodes, conns, "gen");
  assert.equal(references.length, 3);
  assert.deepEqual(references[0], { nodeId: "r1", url: "https://img.example/char.png", role: "character", name: "r1" });
  assert.equal(references[1].role, "general");
  assert.equal(references[2].role, "general");
  assert.ok(!references.some((r) => r.url.includes("plain")), "普通 image 节点不应自动带入");
});

test("resolveGenerationInputs：data:image URL 亦可用；无入边时空结果", () => {
  const nodes = [
    node("r1", CanvasNodeType.Reference, { content: "data:image/png;base64,AAAA", referenceRole: "style" }),
    node("gen", CanvasNodeType.Image, {}),
  ];
  const conns = [conn("c1", "r1", "gen")];
  const { references } = resolveGenerationInputs(nodes, conns, "gen");
  assert.equal(references[0].url, "data:image/png;base64,AAAA");
  assert.equal(references[0].role, "style");
  const empty = resolveGenerationInputs(nodes, [], "gen");
  assert.deepEqual(empty, { promptParts: [], references: [] });
});

test("composeGenerationPrompt：前缀在前正文在后；无前缀时原文返回", () => {
  assert.equal(composeGenerationPrompt([], "一只柴犬"), "一只柴犬");
  assert.equal(composeGenerationPrompt(["胶片质感"], "一只柴犬"), "胶片质感\n一只柴犬");
  assert.equal(composeGenerationPrompt(["A", "B"], "  一只柴犬  "), "A\nB\n一只柴犬");
  assert.equal(composeGenerationPrompt(["只有前缀"], ""), "只有前缀");
  assert.equal(composeGenerationPrompt(["  "], "正文"), "正文"); // 空白前缀视为无
});

test("mergeGenerationReferences：手动引用优先，nodeId / url 去重", () => {
  const manual: CanvasGenerationReference[] = [
    { nodeId: "r1", url: "https://a.png", role: "character", name: "手动" },
    { nodeId: "i1", url: "https://b.png", role: "general", name: "普通图" },
  ];
  const wired: CanvasGenerationReference[] = [
    { nodeId: "r1", url: "https://a.png", role: "character", name: "连线" }, // nodeId 撞 → 丢
    { nodeId: "r2", url: "https://c.png", role: "style", name: "风格" }, // 保留
    { url: "https://b.png", role: "general", name: "同 URL" }, // 无 nodeId 但 url 撞 → 丢
  ];
  const merged = mergeGenerationReferences(manual, wired);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].name, "手动"); // 手动在前（显式意图优先）
  assert.equal(merged[2].role, "style");
});

test("referenceImageUrlOf：image / reference 节点取图；其他型别与非法 URL 为 null", () => {
  assert.equal(referenceImageUrlOf(node("i", CanvasNodeType.Image, { content: "https://x.png" })), "https://x.png");
  assert.equal(referenceImageUrlOf(node("r", CanvasNodeType.Reference, { content: "data:image/png;base64,AA" })), "data:image/png;base64,AA");
  assert.equal(referenceImageUrlOf(node("t", CanvasNodeType.Text, { content: "https://x.png" })), null);
  assert.equal(referenceImageUrlOf(node("r2", CanvasNodeType.Reference, { content: "javascript:alert(1)" })), null);
  assert.equal(referenceImageUrlOf(undefined), null);
});

test("节点创建预设：prompt / reference 有尺寸与标题预设（agent add_node 依赖）", () => {
  assert.ok(CANVAS_NODE_DEFAULT_SIZE[CanvasNodeType.Prompt]);
  assert.ok(CANVAS_NODE_DEFAULT_SIZE[CanvasNodeType.Reference]);
  assert.equal(CANVAS_NODE_DEFAULT_SIZE[CanvasNodeType.Prompt].title, "提示词");
  assert.equal(CANVAS_NODE_DEFAULT_SIZE[CanvasNodeType.Reference].title, "参考图");
  assert.equal(toNodeType("prompt"), CanvasNodeType.Prompt);
  assert.equal(toNodeType("reference"), CanvasNodeType.Reference);
});

test("向后兼容：旧型别行为不变；未知 type 仍退 text", () => {
  assert.equal(toNodeType("image"), CanvasNodeType.Image);
  assert.equal(toNodeType("text"), CanvasNodeType.Text);
  assert.equal(toNodeType("不存在的型别"), CanvasNodeType.Text);
});

test("事件正规化：canvas.node.created 保留 referenceRole，非法角色丢弃", () => {
  const event = normalizeCanvasEvent({
    name: "canvas.node.created",
    data: {
      unit_id: "u1",
      node: {
        id: "r1",
        type: "reference",
        title: "角色参考",
        metadata: { content: "https://x.png", status: "success", referenceRole: "character" },
      },
    },
  });
  assert.ok(event);
  if (event && event.name === "canvas.node.created") {
    assert.equal(event.data.node.type, CanvasNodeType.Reference);
    assert.equal(event.data.node.metadata?.referenceRole, "character");
  }
  const bad = normalizeCanvasEvent({
    name: "canvas.node.created",
    data: {
      unit_id: "u2",
      node: { id: "r2", type: "reference", title: "x", metadata: { referenceRole: "nonsense" } },
    },
  });
  assert.ok(bad);
  if (bad && bad.name === "canvas.node.created") {
    assert.equal(bad.data.node.metadata?.referenceRole, undefined);
  }
});
