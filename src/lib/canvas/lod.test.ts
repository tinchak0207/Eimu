// 语义缩放纯函式：迟滞、阶段归类、阶段摘要、飞到阶段的视口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CanvasNodeType, type CanvasNode, type CanvasNodeMetadata } from "./types";
import {
  classifyStage,
  engineeringFocusViewport,
  fitStageViewport,
  gatherOffsets,
  gatherVisuals,
  hasEngineeringData,
  GATHER_RANGE,
  HUD_CARD,
  hudLayout,
  warpFlightProgress,
  hudSlots,
  initialLod,
  interpolateViewport,
  lodBlend,
  nextLod,
  overallProgress,
  STAGE_FIT_MAX_SCALE,
  STAGE_FIT_MIN_SCALE,
  summarizeStages,
  zoomAroundCenter,
} from "./lod";

function node(id: string, type: CanvasNodeType, metadata?: CanvasNodeMetadata, pos = { x: 0, y: 0 }, w = 100, h = 80): CanvasNode {
  return { id, type, title: id, position: pos, width: w, height: h, metadata };
}

test("nextLod：协作层出发的门槛", () => {
  assert.equal(nextLod(2, 0.6), 2);
  assert.equal(nextLod(2, 0.36), 1);
  assert.equal(nextLod(2, 0.4), 2);
  assert.equal(nextLod(2, 1.16), 3);
  assert.equal(nextLod(2, 1), 2, "100%（模板/适应视图常见落点）仍是协作层");
});

test("nextLod：迟滞带内维持原层", () => {
  assert.equal(nextLod(1, 0.4), 1);
  assert.equal(nextLod(1, 0.43), 1);
  assert.equal(nextLod(1, 0.44), 2);
  assert.equal(nextLod(3, 1.1), 3);
  assert.equal(nextLod(3, 1.05), 3);
  assert.equal(nextLod(3, 1.04), 2);
});

test("nextLod：跨层跳跃", () => {
  assert.equal(nextLod(1, 1.2), 3);
  assert.equal(nextLod(3, 0.2), 1);
});

test("nextLod：allowEngineering=false 上限 2", () => {
  assert.equal(nextLod(2, 1.5, { allowEngineering: false }), 2);
  assert.equal(nextLod(1, 1.5, { allowEngineering: false }), 2);
  assert.equal(nextLod(3, 1.5, { allowEngineering: false }), 2);
  assert.equal(nextLod(2, 0.2, { allowEngineering: false }), 1);
});

test("initialLod：以协作层为起点", () => {
  assert.equal(initialLod(0.39), 2);
  assert.equal(initialLod(0.3), 1);
  assert.equal(initialLod(1), 2);
  assert.equal(initialLod(1.2), 3);
  assert.equal(initialLod(1.2, { allowEngineering: false }), 2);
});

test("classifyStage：按类型归类", () => {
  assert.equal(classifyStage(node("g", CanvasNodeType.Group)), null);
  assert.equal(classifyStage(node("t", CanvasNodeType.Text)), 1);
  assert.equal(classifyStage(node("p", CanvasNodeType.Prompt)), 1);
  assert.equal(classifyStage(node("c", CanvasNodeType.Config)), 1);
  assert.equal(classifyStage(node("d", CanvasNodeType.Director)), 1);
  assert.equal(classifyStage(node("cc", CanvasNodeType.CharacterCard)), 2);
  assert.equal(classifyStage(node("sc", CanvasNodeType.SceneCard)), 2);
  assert.equal(classifyStage(node("r", CanvasNodeType.Reference)), 2);
  assert.equal(classifyStage(node("s3", CanvasNodeType.Scene3d)), 2);
  assert.equal(classifyStage(node("i", CanvasNodeType.Image)), 3);
  assert.equal(classifyStage(node("v", CanvasNodeType.Video)), 4);
  assert.equal(classifyStage(node("a", CanvasNodeType.Audio)), 4);
});

test("classifyStage：metadata 信号优先于类型", () => {
  assert.equal(classifyStage(node("tool", CanvasNodeType.Text, { pipelineCard: "tool" })), 3);
  assert.equal(classifyStage(node("gate", CanvasNodeType.Text, { pipelineCard: "gate" })), 3);
  assert.equal(classifyStage(node("head", CanvasNodeType.Text, { pipelineCard: "step_head" })), 3);
  assert.equal(classifyStage(node("note", CanvasNodeType.Text, { pipelineCard: "note" })), 1);
  assert.equal(classifyStage(node("dir", CanvasNodeType.Text, { pipelineCard: "director" })), 1);
  assert.equal(classifyStage(node("deliv", CanvasNodeType.Config, { deliverable: "成片" })), 4);
  assert.equal(classifyStage(node("deliv-img", CanvasNodeType.Image, { deliverable: "海报" })), 4);
});

test("classifyStage：Image 的资产 vs 镜头判定", () => {
  assert.equal(classifyStage(node("ent", CanvasNodeType.Image, { entityCardId: "c1" })), 2);
  assert.equal(classifyStage(node("ref", CanvasNodeType.Image, { referenceRole: "character" as CanvasNodeMetadata["referenceRole"] })), 2);
  assert.equal(classifyStage(node("shot", CanvasNodeType.Image, { entityCardId: "c1", shotId: "S01" })), 3);
  assert.equal(classifyStage(node("stage", CanvasNodeType.Image, { directorStageId: "n1" })), 3);
});

test("summarizeStages：计数与 bbox", () => {
  const nodes = [
    node("t", CanvasNodeType.Text, { status: "success" }, { x: 0, y: 0 }),
    node("i1", CanvasNodeType.Image, { status: "success" }, { x: 100, y: 50 }, 200, 100),
    node("i2", CanvasNodeType.Image, { status: "loading" }, { x: 400, y: 0 }),
    node("i3", CanvasNodeType.Image, { status: "error" }, { x: 0, y: 300 }),
    node("gate", CanvasNodeType.Text, { pipelineCard: "gate", gateConfirm: { request_id: "r", session_id: "s", status: "pending" } }, { x: 50, y: 50 }),
    node("cc", CanvasNodeType.CharacterCard, { approval: { status: "pending" } }),
    node("g", CanvasNodeType.Group),
  ];
  const [s1, s2, s3, s4] = summarizeStages(nodes);
  assert.equal(s1.total, 1);
  assert.equal(s1.done, 1);
  assert.equal(s2.total, 1);
  assert.equal(s2.pendingReview, 1);
  assert.equal(s3.total, 4);
  assert.equal(s3.done, 1);
  assert.equal(s3.running, 1);
  assert.equal(s3.failed, 1);
  assert.equal(s3.pendingReview, 1);
  assert.deepEqual(s3.bbox, { x: 0, y: 0, width: 500, height: 380 });
  assert.equal(s4.total, 0);
  assert.equal(s4.bbox, null);
  assert.equal(s1.code, "01");
});

test("fitStageViewport：k 夹在协作层区间并置中", () => {
  const size = { width: 1000, height: 800 };
  const huge = fitStageViewport({ x: 0, y: 0, width: 10000, height: 10000 }, size);
  assert.equal(huge.k, STAGE_FIT_MIN_SCALE);
  const tiny = fitStageViewport({ x: 100, y: 100, width: 100, height: 100 }, size);
  assert.equal(tiny.k, STAGE_FIT_MAX_SCALE);
  // bbox 中心 (150,150) 落在萤幕中心
  assert.equal(tiny.x + 150 * tiny.k, 500);
  assert.equal(tiny.y + 150 * tiny.k, 400);
  assert.equal(nextLod(1, huge.k), 2);
  assert.equal(nextLod(1, tiny.k), 2);
});

test("hasEngineeringData", () => {
  assert.equal(hasEngineeringData(node("a", CanvasNodeType.Image)), false);
  assert.equal(hasEngineeringData(node("b", CanvasNodeType.Image, { imageTaskId: "t1" })), true);
  assert.equal(hasEngineeringData(node("c", CanvasNodeType.Text, { toolOutput: "x" })), true);
  assert.equal(hasEngineeringData(node("d", CanvasNodeType.Image, { model: "m" })), true);
});

// ─────────────────────────────────────────── 连续转场（2026-09-30 打磨）

test("lodBlend：两端饱和、带内单调、两带不重叠", () => {
  assert.deepEqual(lodBlend(0.6), { gather: 0, xray: 0 });
  assert.equal(lodBlend(0.5).gather, 0);
  assert.equal(lodBlend(0.36).gather, 1);
  assert.equal(lodBlend(0.2).gather, 1);
  assert.equal(lodBlend(0.85).xray, 0, "85%（模板预设）不得有任何透析残影");
  assert.equal(lodBlend(1.1).xray, 0);
  assert.equal(lodBlend(1.35).xray, 1);
  assert.equal(lodBlend(2).xray, 1);
  let prev = -1;
  for (let k = 0.5; k >= 0.36; k -= 0.01) {
    const g = lodBlend(k).gather;
    assert.ok(g >= prev, `gather 应随 k 下降而上升（k=${k.toFixed(2)}）`);
    prev = g;
  }
  // 离散门槛落在连续带内：进 LOD1 时已接近收束、进 LOD3 时工程条已开始滑出。
  assert.ok(lodBlend(0.37).gather > 0.9);
  assert.ok(lodBlend(1.15).xray > 0 && lodBlend(1.15).xray < 0.3);
});

test("gatherVisuals：戏在 phase A 演完；节点先飞后淡（A 段前半不透明）", () => {
  assert.deepEqual(gatherVisuals(0), { move: 0, scale: 1, opacity: 1, blur: 0 });
  const endA = gatherVisuals(0.6);
  assert.equal(endA.move, 1);
  assert.ok(Math.abs(endA.scale - 0.28) < 1e-9);
  assert.equal(endA.opacity, 0);
  assert.ok(Math.abs(endA.blur - 3) < 1e-9);
  assert.deepEqual(gatherVisuals(1), endA);
  const mid = gatherVisuals(0.3);
  assert.equal(mid.opacity, 1, "A 段中点仍完全不透明：节点在飞，不在消失");
  assert.ok(mid.move > 0.4 && mid.move < 0.6);
  assert.equal(mid.blur, 0);
});

test("interpolateViewport：起讫精确、k 走几何平均、锚点在萤幕上直线匀速（不先偏后折）", () => {
  const size = { width: 1000, height: 800 };
  const from = { x: 100, y: 50, k: 0.25 };
  const to = { x: -400, y: -300, k: 1 };
  assert.deepEqual(interpolateViewport(from, to, 0, size), from);
  assert.deepEqual(interpolateViewport(from, to, 1, size), to);
  const mid = interpolateViewport(from, to, 0.5, size);
  assert.ok(Math.abs(mid.k - 0.5) < 1e-9);
  // 放大：目的中心（世界点）的萤幕位置 = 起点萤幕位置 → 视口中心 的线性插值。
  const c1 = { x: (500 - to.x) / to.k, y: (400 - to.y) / to.k };
  const screenOf = (vp: { x: number; y: number; k: number }) => ({ x: c1.x * vp.k + vp.x, y: c1.y * vp.k + vp.y });
  const s0 = screenOf(from);
  for (const e of [0.25, 0.5, 0.75]) {
    const sp = screenOf(interpolateViewport(from, to, e, size));
    assert.ok(Math.abs(sp.x - (s0.x + (500 - s0.x) * e)) < 1e-6);
    assert.ok(Math.abs(sp.y - (s0.y + (400 - s0.y) * e)) < 1e-6);
  }
  // 缩小：反向同理（起点中心直线离开视口中心）。
  const back = interpolateViewport(to, from, 0.5, size);
  assert.ok(Math.abs(back.k - 0.5) < 1e-9);
});

test("zoomAroundCenter：中心世界点不动", () => {
  const size = { width: 800, height: 600 };
  const vp = { x: 120, y: -40, k: 0.6 };
  const next = zoomAroundCenter(vp, 0.3, size);
  assert.equal(next.k, 0.3);
  assert.ok(Math.abs((400 - vp.x) / vp.k - (400 - next.x) / next.k) < 1e-9);
  assert.ok(Math.abs((300 - vp.y) / vp.k - (300 - next.y) / next.k) < 1e-9);
});

test("summarizeStages：质心、缩图（只收成功真实产出、按位置、上限 4）、摘录", () => {
  const img = (id: string, x: number, y: number, status: "success" | "loading" = "success") =>
    node(id, CanvasNodeType.Image, { status, shotId: id, content: `https://cdn/${id}.png` }, { x, y });
  const nodes = [
    node("t", CanvasNodeType.Text, { content: "  雨夜，\n旧车站。".padEnd(80, "字") }, { x: 0, y: 0 }),
    img("s5", 500, 500),
    img("s1", 0, 0),
    img("s2", 200, 0),
    img("s3", 0, 200),
    img("s4", 200, 200),
    img("s6", 400, 0, "loading"),
    node("v", CanvasNodeType.Video, { status: "success", content: "https://cdn/v.mp4" }, { x: 0, y: 0 }),
  ];
  const [s1, , s3, s4] = summarizeStages(nodes);
  assert.deepEqual(
    s3.previews.map((p) => p.url),
    ["https://cdn/s1.png", "https://cdn/s2.png", "https://cdn/s3.png", "https://cdn/s4.png"],
  );
  assert.deepEqual(s4.previews, [{ url: "https://cdn/v.mp4", kind: "video" }]);
  assert.ok(s1.excerpt?.startsWith("雨夜， 旧车站。"));
  assert.ok(s1.excerpt!.endsWith("…"));
  assert.equal(s1.excerpt!.length, 61);
  // 质心＝节点中心平均（s3 六个节点）
  const xs = [500, 0, 200, 0, 200, 400].map((x) => x + 50);
  assert.ok(Math.abs(s3.centroid!.x - xs.reduce((a, b) => a + b, 0) / 6) < 1e-9);
});

test("summarizeStages：current＝第一个非空未完成、complete、首个待审", () => {
  const stages = summarizeStages([
    node("t", CanvasNodeType.Text, { status: "success", content: "x" }),
    node("r", CanvasNodeType.Reference, { status: "success" }),
    node("s", CanvasNodeType.Image, { status: "loading", shotId: "1" }, { x: 0, y: 100 }),
    node("g", CanvasNodeType.Text, { pipelineCard: "gate", gateConfirm: { request_id: "r", session_id: "s", status: "pending" } }, { x: 0, y: 50 }),
  ]);
  assert.deepEqual(
    stages.map((s) => [s.current, s.complete]),
    [
      [false, true],
      [false, true],
      [true, false],
      [false, false],
    ],
  );
  assert.equal(stages[2].firstPendingNodeId, "g");
  assert.equal(stages[0].firstPendingNodeId, undefined);
  assert.deepEqual(overallProgress(stages), { percent: 50, pendingReview: 1 });
});

test("gatherOffsets：g=1 时节点中心收束到阶段质心；Group 不参与", () => {
  const nodes = [
    node("a", CanvasNodeType.Image, { shotId: "1" }, { x: 0, y: 0 }),
    node("b", CanvasNodeType.Image, { shotId: "2" }, { x: 300, y: 100 }),
    node("grp", CanvasNodeType.Group, undefined, { x: 0, y: 0 }),
  ];
  const offsets = gatherOffsets(nodes, summarizeStages(nodes));
  assert.equal(offsets.has("grp"), false);
  const a = offsets.get("a")!;
  const b = offsets.get("b")!;
  assert.equal(a.stage, 3);
  assert.deepEqual([50 + a.x, 40 + a.y], [350 + b.x, 140 + b.y]);
});

test("hudSlots：宽萤幕在安全区内置中（让出右侧缩放轨）；窄了等比缩", () => {
  const wide = hudSlots({ width: 1440, height: 900 });
  assert.equal(wide.length, 4);
  assert.equal(wide[0].width, HUD_CARD.width);
  assert.equal(wide[0].height, HUD_CARD.height);
  const rowRight = wide[3].x + wide[3].width;
  assert.ok(rowRight <= 1440 - HUD_CARD.rightInset, "最右卡不得压到缩放控件轨");
  const areaCenter = HUD_CARD.leftInset + (1440 - HUD_CARD.leftInset - HUD_CARD.rightInset) / 2;
  assert.ok(Math.abs((wide[0].x + rowRight) / 2 - areaCenter) < 1e-9);
  assert.ok(wide[0].y >= HUD_CARD.topInset + HUD_CARD.headerSpace);
  // 画布与对话并排（~780px）：一行放不下 → 2×2，卡片不被压扁、不压缩放轨。
  const narrow = hudLayout({ width: 780, height: 840 });
  assert.equal(narrow.mode, "grid");
  assert.equal(narrow.slots[0].y, narrow.slots[1].y);
  assert.equal(narrow.slots[0].x, narrow.slots[2].x);
  assert.ok(narrow.slots[1].x + narrow.slots[1].width <= 780 - HUD_CARD.rightInset);
  assert.equal(narrow.slots[0].height, HUD_CARD.gridHeight);
});

test("summarizeStages：无 status 的提示词/文本节点算完成，剧本阶段不会永远进行中", () => {
  const nodes = [
    node("t", CanvasNodeType.Text, { content: "剧本", status: "success" }),
    node("p", CanvasNodeType.Prompt, { content: "风格" }, { x: 0, y: 200 }),
    node("s", CanvasNodeType.Image, { shotId: "01" }, { x: 400, y: 0 }),
  ];
  const [s1, , s3] = summarizeStages(nodes);
  assert.equal(s1.done, 2);
  assert.equal(s1.complete, true);
  assert.equal(s3.current, true);
});

test("summarizeStages：beads 逐节点给状态（待审优先于成功）", () => {
  const nodes = [
    node("a", CanvasNodeType.Image, { shotId: "01", status: "success" }),
    node("b", CanvasNodeType.Image, { shotId: "02", status: "loading" }, { x: 200, y: 0 }),
    node("c", CanvasNodeType.Image, { shotId: "03", status: "error" }, { x: 400, y: 0 }),
    node("d", CanvasNodeType.Image, { shotId: "04" }, { x: 600, y: 0 }),
  ];
  const s3 = summarizeStages(nodes)[2];
  assert.deepEqual([...s3.beads].sort(), ["done", "failed", "idle", "running"]);
});

test("engineeringFocusViewport：卡片置中于面板左侧可见区，放得下时 k≥1、放不下时缩到 80% 宽但不低于 0.86", () => {
  const size = { width: 1200, height: 800 };
  const n = { position: { x: 100, y: 200 }, width: 280, height: 200 };
  const vp = engineeringFocusViewport(n, size, 0.9);
  assert.equal(vp.k, 1);
  assert.equal(vp.x + (100 + 140) * vp.k, 400);
  assert.equal(vp.y + (200 + 100) * vp.k, 400);
  assert.equal(engineeringFocusViewport(n, size, 1.6).k, 1.6);
  // 窄画布：面板吃掉右侧，只剩 [16, 330]。
  const narrow = engineeringFocusViewport(n, { width: 780, height: 800 }, 1, { left: 16, right: 330 });
  assert.ok(Math.abs(narrow.k - 0.897142857142857) < 1e-9);
  assert.ok(Math.abs(narrow.x + 240 * narrow.k - 173) < 1e-9);
  assert.equal(engineeringFocusViewport(n, size, 1, { left: 0, right: 200 }).k, 0.86);
});

test("warpFlightProgress：穿过聚合带时带内占大半飞行时间；单调、端点不变", () => {
  assert.equal(warpFlightProgress(0.6, 0.3, 0), 0);
  assert.equal(warpFlightProgress(0.6, 0.3, 1), 1);
  assert.equal(warpFlightProgress(2, 2, 0.4), 0.4);
  const kAt = (e: number) => Math.exp(Math.log(0.6) + (Math.log(0.3) - Math.log(0.6)) * warpFlightProgress(0.6, 0.3, e));
  let inBand = 0;
  let prev = -1;
  for (let i = 0; i <= 200; i++) {
    const u = warpFlightProgress(0.6, 0.3, i / 200);
    assert.ok(u >= prev);
    prev = u;
    const k = kAt(i / 200);
    if (k <= GATHER_RANGE.start && k >= GATHER_RANGE.end) inBand++;
  }
  assert.ok(inBand / 201 > 0.7, `带内时间占比 ${inBand / 201}`);
});
