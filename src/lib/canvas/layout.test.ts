// 畫布純函式層測試：事件正規化、摘要安全、視口幾何、歷史快照、專案序列化。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANVAS_MIN_SCALE,
  CANVAS_MAX_SCALE,
  CANVAS_GRID_BASE,
  CANVAS_SUMMARY_MAX_NODES,
  CANVAS_HISTORY_LIMIT,
  CANVAS_EMPTY_HISTORY,
  CANVAS_EXPORT_KIND,
  CANVAS_EXPORT_VERSION,
  normalizeCanvasEvent,
  toNodeMetadata,
  toNodeStatus,
  summarizeCanvasState,
  clampScale,
  zoomAtPoint,
  screenToWorld,
  worldToScreen,
  computeWorldBounds,
  bezierPath,
  gridBackground,
  pushSnapshot,
  undoSnapshot,
  redoSnapshot,
  toCanvasProject,
  fromCanvasProject,
  buildExportFile,
  parseImportFile,
  type CanvasSnapshot,
  type CanvasHistory,
} from "./layout";
import { CANVAS_INITIAL_STATE, reduceCanvasEvent, type CanvasReducerState } from "./reducer";
import {
  CANVAS_NODE_DEFAULT_SIZE,
  CanvasNodeType,
  errorDetailsText,
  type CanvasConnection,
  type CanvasNode,
  type CanvasViewport,
} from "./types";
import type { AgentSseEvent } from "../agent-chat-types";

// ─────────────────────────── helpers

/** gateway 寬鬆解析出的 created 事件：node 只有 id/type/title，沒有座標/尺寸。 */
function gatewayCreated(unitId: string, id: string, type: string, title: string): AgentSseEvent {
  return {
    name: "canvas.node.created",
    event_id: 1,
    data: { unit_id: unitId, node: { id, type, title } },
  };
}

function imageNode(id: string, x: number, y: number, metadata?: CanvasNode["metadata"]): CanvasNode {
  return { id, type: CanvasNodeType.Image, title: `圖 ${id}`, position: { x, y }, width: 340, height: 240, metadata };
}

// ─────────────────────────── 事件正規化

test("normalizeCanvasEvent 補齊尺寸、position 留 0,0，未知 type 退 text", () => {
  const norm = normalizeCanvasEvent(gatewayCreated("cu_1", "n1", "image", "生成中"));
  assert.ok(norm);
  if (norm.name !== "canvas.node.created") throw new Error("expected created event");
  assert.deepEqual(norm.data.node.position, { x: 0, y: 0 }, "gateway 不給座標，排版權交給 reducer");
  assert.equal(norm.data.node.width, CANVAS_NODE_DEFAULT_SIZE[CanvasNodeType.Image].width);
  assert.equal(norm.data.node.height, CANVAS_NODE_DEFAULT_SIZE[CanvasNodeType.Image].height);
  assert.equal(norm.data.node.type, "image");
  assert.equal(norm.data.node.title, "生成中");

  const unknownType = normalizeCanvasEvent(gatewayCreated("cu_1", "n2", "not-a-real-type", "X"));
  assert.ok(unknownType);
  if (unknownType.name !== "canvas.node.created") throw new Error("expected created event");
  assert.equal(unknownType.data.node.type, CanvasNodeType.Text, "未知 type 一律退成 text");
  assert.equal(unknownType.data.node.width, CANVAS_NODE_DEFAULT_SIZE[CanvasNodeType.Text].width);
});

test("normalizeCanvasEvent 對 derive/budget/非 canvas 事件回 null", () => {
  const derive: AgentSseEvent = {
    name: "canvas.derive.started",
    event_id: 2,
    data: { unit_id: "cu_1", source_node_id: "a", instruction: "改暖色" },
  };
  const budget: AgentSseEvent = {
    name: "canvas.budget.updated",
    event_id: 3,
    data: { used_coins: 10, remaining_coins: 90 },
  };
  const message: AgentSseEvent = { name: "message.delta", event_id: 4, data: { text: "hi" } };
  assert.equal(normalizeCanvasEvent(derive), null);
  assert.equal(normalizeCanvasEvent(budget), null);
  assert.equal(normalizeCanvasEvent(message), null);
});

test("normalize + reduce 端到端：4 個節點自動排 3 欄瀑布流", () => {
  // reducer 的 nextPosition（LAYOUT_START={40,40}、340 寬 + GAP_X=60、240 高 + GAP_Y=40）
  let state = CANVAS_INITIAL_STATE;
  for (let i = 0; i < 4; i++) {
    const norm = normalizeCanvasEvent(gatewayCreated("cu_1", `n${i}`, "image", `T${i}`));
    assert.ok(norm);
    state = reduceCanvasEvent(state, norm);
  }
  assert.equal(state.nodes.length, 4);
  const expected = [
    { x: 40, y: 40 }, // 第 1 列第 1 格
    { x: 440, y: 40 }, // 第 1 列第 2 格：40 + (340+60)
    { x: 840, y: 40 }, // 第 1 列第 3 格
    { x: 40, y: 320 }, // 第 2 列第 1 格：40 + (240+40)
  ];
  state.nodes.forEach((n, i) => {
    assert.deepEqual(n.position, expected[i], `節點 ${n.id} 排錯位`);
  });
});

test("toNodeStatus 映射 gateway 寬詞彙到四態", () => {
  for (const raw of ["running", "pending", "queued", "generating"]) {
    assert.equal(toNodeStatus(raw), "loading");
  }
  for (const raw of ["failed", "error"]) {
    assert.equal(toNodeStatus(raw), "error");
  }
  for (const raw of ["done", "succeeded", "completed"]) {
    assert.equal(toNodeStatus(raw), "success");
  }
  // 既有的四態原樣通過
  assert.equal(toNodeStatus("idle"), "idle");
  assert.equal(toNodeStatus("success"), "success");
  assert.equal(toNodeStatus("loading"), "loading");
  assert.equal(toNodeStatus("error"), "error");
  // 垃圾與非字串
  assert.equal(toNodeStatus("garbage"), undefined);
  assert.equal(toNodeStatus(123), undefined);
  assert.equal(toNodeStatus(undefined), undefined);
  assert.equal(toNodeStatus(""), undefined);
});

test("toNodeMetadata：errorDetails 物件形收斂（human_message 優先）、cost_hint 保留（G-FE/C-FE 合同）", () => {
  const meta = toNodeMetadata({
    errorDetails: { message: "No enabled supplier capability", human_message: "当前没有可用通道，稍后再试或换个模型" },
    cost_hint: 6,
  });
  assert.deepEqual(meta.errorDetails, {
    message: "No enabled supplier capability",
    human_message: "当前没有可用通道，稍后再试或换个模型",
  });
  assert.equal(errorDetailsText(meta.errorDetails), "当前没有可用通道，稍后再试或换个模型");
  assert.equal(meta.cost_hint, 6);
  // 舊載荷純字串原樣；物件只留兩個字串欄位，雜形丟棄；缺 human_message 回落 message。
  assert.equal(toNodeMetadata({ errorDetails: "纯文本旧载荷" }).errorDetails, "纯文本旧载荷");
  assert.equal(errorDetailsText("纯文本旧载荷"), "纯文本旧载荷");
  assert.equal(toNodeMetadata({ errorDetails: { code: 1 } }).errorDetails, undefined);
  assert.equal(errorDetailsText({ message: "只有原文" }), "只有原文");
  assert.equal(errorDetailsText(undefined), undefined);
  assert.equal(toNodeMetadata({ cost_hint: "6" }).cost_hint, undefined);
});

// ─────────────────────────── canvas_state 摘要（安全）

test("summarizeCanvasState 摘要不含 base64／長 content／長 prompt，保留結構欄位", () => {
  const longContent = "data:image/png;base64," + "A".repeat(5000);
  const longPrompt = "一只戴礼帽的柴犬喝奶茶。".repeat(800);
  const state: CanvasReducerState = {
    units: [],
    nodes: [
      imageNode("img1", 40, 40, { content: longContent, model: "pixai-tsubaki2", size: "1024x1024", status: "success" }),
      imageNode("txt1", 440, 40, { prompt: longPrompt, status: "loading" }),
    ],
    connections: [{ id: "c1", fromNodeId: "img1", toNodeId: "txt1" }],
  };
  const summary = summarizeCanvasState(state);
  const json = JSON.stringify(summary);
  assert.ok(!json.includes("base64"), "摘要不得洩漏 base64 dataURL");
  assert.ok(!json.includes(longContent), "摘要不得帶圖片 content");
  assert.ok(!json.includes(longPrompt), "摘要不得帶文本 prompt");
  const img = summary.nodes.find((n) => n.id === "img1");
  assert.ok(img);
  assert.equal(img.type, "image");
  assert.equal(img.title, "圖 img1");
  assert.equal(img.status, "success");
  assert.equal(img.model, "pixai-tsubaki2");
  assert.equal(img.size, "1024x1024");
  assert.equal(summary.connections.length, 1, "連線數要保留");
});

test("summarizeCanvasState 節點上限：只留最後 60 個，懸空連線被丟", () => {
  const total = CANVAS_SUMMARY_MAX_NODES + 5; // 65
  const nodes: CanvasNode[] = [];
  for (let i = 0; i < total; i++) nodes.push(imageNode(`n${i}`, 0, 0));
  const connections: CanvasConnection[] = [];
  for (let i = 0; i < total - 1; i++) connections.push({ id: `c${i}`, fromNodeId: `n${i}`, toNodeId: `n${i + 1}` });
  const summary = summarizeCanvasState({ units: [], nodes, connections });
  assert.equal(summary.nodes.length, CANVAS_SUMMARY_MAX_NODES);
  assert.equal(summary.nodes[0].id, "n5", "最舊的 n0..n4 被裁掉");
  assert.equal(summary.nodes[summary.nodes.length - 1].id, "n64");
  const trimmed = new Set(["n0", "n1", "n2", "n3", "n4"]);
  assert.ok(
    summary.connections.every((c) => !trimmed.has(c.fromNodeId) && !trimmed.has(c.toNodeId)),
    "連到被裁節點的連線要一併丟掉",
  );
  assert.equal(summary.connections.length, total - 1 - 5, "連線 n5..n63 存活共 59 條");
});

// ─────────────────────────── 視口幾何

test("clampScale 夾在最小/最大之間，中間值原樣通過，非有限數回 1", () => {
  assert.equal(clampScale(0.01), CANVAS_MIN_SCALE);
  assert.equal(clampScale(10), CANVAS_MAX_SCALE);
  assert.equal(clampScale(1), 1);
  assert.equal(clampScale(CANVAS_MIN_SCALE), CANVAS_MIN_SCALE);
  assert.equal(clampScale(CANVAS_MAX_SCALE), CANVAS_MAX_SCALE);
  assert.equal(clampScale(NaN), 1);
  assert.equal(clampScale(Infinity), 1);
});

test("zoomAtPoint 游標下的世界點縮放前後不變，縮出地板被夾住", () => {
  const vp: CanvasViewport = { x: 100, y: 50, k: 1 };
  const px = 200;
  const py = 150;
  const before = screenToWorld(vp, px, py);
  const zoomed = zoomAtPoint(vp, -100, px, py); // 放大一格：factor = 1.1
  assert.ok(zoomed.k > vp.k, "負 deltaY 要放大");
  const after = screenToWorld(zoomed, px, py);
  assert.ok(Math.abs(after.x - before.x) < 1e-9, `世界 x 漂移: ${after.x} vs ${before.x}`);
  assert.ok(Math.abs(after.y - before.y) < 1e-9, `世界 y 漂移: ${after.y} vs ${before.y}`);

  const floor = zoomAtPoint(vp, 1000000, px, py); // 瘋狂縮出 → 夾在地板
  assert.equal(floor.k, CANVAS_MIN_SCALE);
});

test("screenToWorld / worldToScreen 非單位視口來回往返", () => {
  const vp: CanvasViewport = { x: -30, y: 42.5, k: 2.5 };
  const wx = 123.4;
  const wy = -56.7;
  const screen = worldToScreen(vp, wx, wy);
  const back = screenToWorld(vp, screen.x, screen.y);
  assert.ok(Math.abs(back.x - wx) < 1e-9);
  assert.ok(Math.abs(back.y - wy) < 1e-9);
});

test("computeWorldBounds 空陣列回零軸盒子，有節點時四邊都墊 pad", () => {
  assert.deepEqual(computeWorldBounds([]), { minX: -500, minY: -500, maxX: 500, maxY: 500, width: 1000, height: 1000 });
  const nodes: CanvasNode[] = [
    { id: "a", type: CanvasNodeType.Image, title: "A", position: { x: 10, y: 20 }, width: 100, height: 50 },
    { id: "b", type: CanvasNodeType.Image, title: "B", position: { x: 200, y: 100 }, width: 80, height: 60 },
  ];
  const b = computeWorldBounds(nodes, 50);
  assert.deepEqual(b, { minX: -40, minY: -30, maxX: 330, maxY: 210, width: 370, height: 240 });
});

test("bezierPath 出右側中點、進左側中點，curvature 有 50 地板", () => {
  // dx = 0 的垂直堆疊：from 右邊緣 x=200 對齊 to 左邊緣 x=200 → c = max(0, 50) = 50
  const from = imageNode("f", 100, 100);
  const to = imageNode("t", 200, 300);
  from.width = 100;
  from.height = 100;
  to.width = 100;
  to.height = 100;
  assert.equal(bezierPath(from, to), "M 200 150 C 250 150, 150 350, 200 350");

  // 一般水平間距：dx = 200 → c = max(100, 50) = 100
  const a = imageNode("a", 0, 0);
  const b = imageNode("b", 300, 0);
  a.width = 100;
  a.height = 100;
  b.width = 100;
  b.height = 100;
  assert.equal(bezierPath(a, b), "M 100 50 C 200 50, 200 50, 300 50");
});

test("gridBackground blank 空物件、太密回空、dots/lines 各自漸層、負視口取正模", () => {
  assert.deepEqual(gridBackground({ x: 0, y: 0, k: 1 }, "blank"), {});
  const size = CANVAS_GRID_BASE * 0.1; // 4.8 < 6 → 直接不畫
  assert.deepEqual(gridBackground({ x: 0, y: 0, k: 0.1 }, "dots"), {});
  assert.deepEqual(gridBackground({ x: 0, y: 0, k: 0.1 }, "lines"), {});

  const dots = gridBackground({ x: 0, y: 0, k: 1 }, "dots");
  assert.ok(dots.backgroundImage?.includes("radial-gradient"), "dots 要 radial-gradient");
  const lines = gridBackground({ x: 0, y: 0, k: 1 }, "lines");
  assert.equal(lines.backgroundImage?.match(/linear-gradient/g)?.length, 2, "lines 要有兩條 linear-gradient");

  const grid = CANVAS_GRID_BASE * 1;
  const neg = gridBackground({ x: -100, y: -100, k: 1 }, "dots");
  assert.ok(neg.backgroundPosition, "負視口也該有 position");
  const [ox, oy] = neg.backgroundPosition!.split(" ").map((s) => parseFloat(s));
  assert.ok(ox >= 0 && ox < grid, `offsetX=${ox} 要在 [0, ${grid})`);
  assert.ok(oy >= 0 && oy < grid, `offsetY=${oy} 要在 [0, ${grid})`);
});

// ─────────────────────────── 歷史快照

test("push/undo/redo 快照：分岔清 future、空棧回 null、上限裁最舊", () => {
  const snap1: CanvasSnapshot = { nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 } };
  const snap2: CanvasSnapshot = { nodes: [], connections: [], viewport: { x: 10, y: 20, k: 2 } };
  const snap3: CanvasSnapshot = { nodes: [], connections: [], viewport: { x: 5, y: 5, k: 1 } };

  // pushSnapshot 清空 future
  const branched: CanvasHistory = { past: [], future: [snap1] };
  const cleared = pushSnapshot(branched, snap2);
  assert.deepEqual(cleared.future, [], "push 必須清 future");

  let h: CanvasHistory = pushSnapshot(CANVAS_EMPTY_HISTORY, snap1);
  h = pushSnapshot(h, snap2);
  assert.deepEqual(h.past, [snap1, snap2]);

  const u1 = undoSnapshot(h, snap3);
  assert.ok(u1);
  assert.equal(u1.snapshot, snap2, "撤銷回上一格");
  assert.deepEqual(u1.history.past, [snap1]);
  assert.deepEqual(u1.history.future, [snap3]);

  const u2 = undoSnapshot(u1.history, snap2);
  assert.ok(u2);
  assert.equal(u2.snapshot, snap1, "再撤一格格");
  assert.deepEqual(u2.history.past, []);
  assert.deepEqual(u2.history.future, [snap2, snap3]);

  const r1 = redoSnapshot(u2.history, snap1);
  assert.ok(r1);
  assert.equal(r1.snapshot, snap2, "重做取 future 第一格");
  assert.deepEqual(r1.history.past, [snap1]);
  assert.deepEqual(r1.history.future, [snap3]);

  assert.equal(undoSnapshot(CANVAS_EMPTY_HISTORY, snap1), null, "空 past 撤銷回 null");
  assert.equal(redoSnapshot(CANVAS_EMPTY_HISTORY, snap1), null, "空 future 重做回 null");

  // CANVAS_HISTORY_LIMIT 上限：塞 55 個，只留最後 50
  let cap: CanvasHistory = CANVAS_EMPTY_HISTORY;
  const snaps: CanvasSnapshot[] = [];
  for (let i = 0; i < 55; i++) {
    const s: CanvasSnapshot = { nodes: [], connections: [], viewport: { x: i, y: 0, k: 1 } };
    snaps.push(s);
    cap = pushSnapshot(cap, s);
  }
  assert.equal(cap.past.length, CANVAS_HISTORY_LIMIT);
  assert.equal(cap.past[0], snaps[5], "最舊的 snaps[0..4] 被裁掉");
  assert.equal(cap.past[49], snaps[54]);
});

// ─────────────────────────── 專案序列化

test("toCanvasProject / fromCanvasProject 往返：座標原樣、units 清空、懸空連線丟掉", () => {
  const n1 = imageNode("n1", 123, 456, { status: "success" });
  const n2: CanvasNode = { ...imageNode("n2", 1000, 2000), type: CanvasNodeType.Text, title: "文本" };
  const state: CanvasReducerState = {
    units: [{ unitId: "cu_1", tool: "image_generate", nodes: [n1, n2], connections: [] }],
    nodes: [n1, n2],
    connections: [
      { id: "c1", fromNodeId: "n1", toNodeId: "n2" },
      { id: "c2", fromNodeId: "n1", toNodeId: "ghost" }, // 懸空：ghost 節點不存在
    ],
  };
  const vp: CanvasViewport = { x: -40, y: 12, k: 1.5 };
  const project = toCanvasProject({ id: "proj-1", title: "我的畫布" }, state, vp, "dots", { totalCoins: 100, usedCoins: 30 });

  assert.equal(project.id, "proj-1");
  assert.equal(project.title, "我的畫布");
  assert.deepEqual(project.viewport, vp);
  assert.equal(project.backgroundMode, "dots");
  assert.deepEqual(project.budget, { totalCoins: 100, usedCoins: 30 });

  const back = fromCanvasProject(project);
  assert.equal(back.units.length, 0, "單元跨刷新沒有意義，一律清空");
  assert.equal(back.nodes.length, 2);
  assert.deepEqual(back.nodes.find((n) => n.id === "n1")?.position, { x: 123, y: 456 }, "座標要原樣還原，不得重新排版");
  assert.deepEqual(back.nodes.find((n) => n.id === "n2")?.position, { x: 1000, y: 2000 });
  assert.equal(back.connections.length, 1, "懸空連線要被丟掉");
  assert.equal(back.connections[0].id, "c1");
});

test("buildExportFile / parseImportFile：信封往返、裸 project 可入、無關 JSON 回 null", () => {
  const n1 = imageNode("n1", 123, 456, { status: "success" });
  const state: CanvasReducerState = {
    units: [],
    nodes: [n1],
    connections: [{ id: "c1", fromNodeId: "n1", toNodeId: "ghost" }],
  };
  const vp: CanvasViewport = { x: -40, y: 12, k: 1.5 };
  const project = toCanvasProject({ id: "proj-1", title: "匯出" }, state, vp, "lines");

  const file = buildExportFile(project);
  assert.equal(file.kind, CANVAS_EXPORT_KIND);
  assert.equal(file.version, CANVAS_EXPORT_VERSION);
  assert.equal(file.project.id, "proj-1");

  const parsed = parseImportFile(file);
  assert.ok(parsed);
  assert.equal(parsed.nodes.length, 1);
  assert.equal(parsed.connections.length, 0, "懸空連線不還原");
  assert.deepEqual(parsed.viewport, vp);
  assert.equal(parsed.backgroundMode, "lines");
  assert.equal(parsed.title, "匯出");

  // 裸 project（無信封）也能匯入
  const bare = parseImportFile(project);
  assert.ok(bare);
  assert.equal(bare.nodes.length, 1);

  // 無關 JSON / 非物件 → null
  assert.equal(parseImportFile({ hello: "world" }), null);
  assert.equal(parseImportFile(null), null);
  assert.equal(parseImportFile(42), null);
});
