// 語義節點（prompt / reference）純邏輯測試：
//   - 連線接線語義：prompt 前綴注入、reference 圖+角色自動帶入
//   - 去重合併（手動 @引用優先，連線自動帶入其次）
//   - 節點創建預設（CANVAS_NODE_DEFAULT_SIZE 新型別條目）
//   - 向後兼容：舊數據（無新欄位/未知角色）載入不炸、未知 type 退 text
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

test("resolveGenerationInputs：連入的 prompt 節點文本成為前綴來源", () => {
  const nodes = [
    node("p1", CanvasNodeType.Prompt, { content: "电影感光效，35mm 胶片" }),
    node("p2", CanvasNodeType.Prompt, { content: "  " }), // 空文本 → 跳過
    node("p3", CanvasNodeType.Prompt, { content: "低饱和青橙调" }),
    node("t1", CanvasNodeType.Text, { content: "普通文本不注入" }),
    node("gen", CanvasNodeType.Image, {}),
  ];
  const conns = [conn("c1", "p1", "gen"), conn("c2", "p2", "gen"), conn("c3", "p3", "gen"), conn("c4", "t1", "gen")];
  const { promptParts, references } = resolveGenerationInputs(nodes, conns, "gen");
  assert.deepEqual(promptParts, ["电影感光效，35mm 胶片", "低饱和青橙调"]);
  assert.equal(references.length, 0);
});

test("resolveGenerationInputs：連入的 reference 節點帶圖+角色；image/text 節點不自動帶入", () => {
  const nodes = [
    node("r1", CanvasNodeType.Reference, { content: "https://img.example/char.png", referenceRole: "character" }),
    node("r2", CanvasNodeType.Reference, { content: "https://img.example/style.png" }), // 未設角色 → general
    node("r3", CanvasNodeType.Reference, { content: "https://img.example/x.png", referenceRole: "bogus" }), // 非法角色 → general
    node("r4", CanvasNodeType.Reference, { content: "" }), // 無圖 → 跳過
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
  assert.ok(!references.some((r) => r.url.includes("plain")), "普通 image 節點不應自動帶入");
});

test("resolveGenerationInputs：data:image URL 亦可用；無入邊時空結果", () => {
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

test("composeGenerationPrompt：前綴在前正文在後；無前綴時原文返回", () => {
  assert.equal(composeGenerationPrompt([], "一只柴犬"), "一只柴犬");
  assert.equal(composeGenerationPrompt(["胶片质感"], "一只柴犬"), "胶片质感\n一只柴犬");
  assert.equal(composeGenerationPrompt(["A", "B"], "  一只柴犬  "), "A\nB\n一只柴犬");
  assert.equal(composeGenerationPrompt(["只有前綴"], ""), "只有前綴");
  assert.equal(composeGenerationPrompt(["  "], "正文"), "正文"); // 空白前綴視為無
});

test("mergeGenerationReferences：手動引用優先，nodeId / url 去重", () => {
  const manual: CanvasGenerationReference[] = [
    { nodeId: "r1", url: "https://a.png", role: "character", name: "手动" },
    { nodeId: "i1", url: "https://b.png", role: "general", name: "普通图" },
  ];
  const wired: CanvasGenerationReference[] = [
    { nodeId: "r1", url: "https://a.png", role: "character", name: "连线" }, // nodeId 撞 → 丟
    { nodeId: "r2", url: "https://c.png", role: "style", name: "风格" }, // 保留
    { url: "https://b.png", role: "general", name: "同 URL" }, // 無 nodeId 但 url 撞 → 丟
  ];
  const merged = mergeGenerationReferences(manual, wired);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].name, "手动"); // 手動在前（顯式意圖優先）
  assert.equal(merged[2].role, "style");
});

test("referenceImageUrlOf：image / reference 節點取圖；其他型別與非法 URL 為 null", () => {
  assert.equal(referenceImageUrlOf(node("i", CanvasNodeType.Image, { content: "https://x.png" })), "https://x.png");
  assert.equal(referenceImageUrlOf(node("r", CanvasNodeType.Reference, { content: "data:image/png;base64,AA" })), "data:image/png;base64,AA");
  assert.equal(referenceImageUrlOf(node("t", CanvasNodeType.Text, { content: "https://x.png" })), null);
  assert.equal(referenceImageUrlOf(node("r2", CanvasNodeType.Reference, { content: "javascript:alert(1)" })), null);
  assert.equal(referenceImageUrlOf(undefined), null);
});

test("節點創建預設：prompt / reference 有尺寸與標題預設（agent add_node 依賴）", () => {
  assert.ok(CANVAS_NODE_DEFAULT_SIZE[CanvasNodeType.Prompt]);
  assert.ok(CANVAS_NODE_DEFAULT_SIZE[CanvasNodeType.Reference]);
  assert.equal(CANVAS_NODE_DEFAULT_SIZE[CanvasNodeType.Prompt].title, "提示词");
  assert.equal(CANVAS_NODE_DEFAULT_SIZE[CanvasNodeType.Reference].title, "参考图");
  assert.equal(toNodeType("prompt"), CanvasNodeType.Prompt);
  assert.equal(toNodeType("reference"), CanvasNodeType.Reference);
});

test("向後兼容：舊型別行為不變；未知 type 仍退 text", () => {
  assert.equal(toNodeType("image"), CanvasNodeType.Image);
  assert.equal(toNodeType("text"), CanvasNodeType.Text);
  assert.equal(toNodeType("不存在的型別"), CanvasNodeType.Text);
});

test("事件正規化：canvas.node.created 保留 referenceRole，非法角色丟棄", () => {
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
