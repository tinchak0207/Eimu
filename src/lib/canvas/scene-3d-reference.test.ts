// P1-1（对称差 D5）3D 白模/静态图当生成参考：参考绑定 ＋ 回分镜溯源的行为契约。
//
// 这支补的是「agent 交了码但没有任何行为断言」的洞（orchestrator 验收补刀）：
// 全部走真函式（buildSceneFrameReferenceCard → 参考卡 → 画布参考形），不是源码字串扫描。
import test from "node:test";
import assert from "node:assert/strict";

import { CanvasNodeType } from "./types";
import type { CanvasConnection, CanvasNode, Scene3dCardMetadata } from "./types";
import {
  readSceneDirectorTrace,
  resolveSceneDirectorReferences,
  sceneCardGenerationReferences,
  sceneDirectorTraceMetadata,
} from "./scene-3d-reference";

/** 导演交付的六栏卡：stills 两张、turntable 是影片（必须被剔除）。 */
const DIRECTOR_CARD: Scene3dCardMetadata = {
  turntable_url: "https://cdn.example.com/turntable.mp4",
  stills_urls: ["https://cdn.example.com/s1.png", "https://cdn.example.com/s2.png"],
  blend_path: "/api/blender-artifact?name=scene_01.blend",
  glb_path: "/api/blender-artifact?name=scene_01.glb",
  scene_summary: "废弃灯塔主场景",
  duration_ms: 8000,
};

function node(id: string, type: CanvasNodeType, metadata: CanvasNode["metadata"] = {}): CanvasNode {
  return { id, type, title: id, position: { x: 0, y: 0 }, width: 320, height: 220, metadata };
}

function edge(from: string, to: string): CanvasConnection {
  return { id: `${from}->${to}`, fromNodeId: from, toNodeId: to };
}

const stage = (id: string, meta: CanvasNode["metadata"] = {}) =>
  node(id, CanvasNodeType.Scene3d, { sceneCard: DIRECTOR_CARD, ...meta });
const imageGen = (id: string, meta: CanvasNode["metadata"] = {}) =>
  node(id, CanvasNodeType.Image, { prompt: "生成", ...meta });

// ── ① 参考绑定：scene_3d 的 stills 真的变成生成参考 ─────────────────────────

test("非 scene_3d 节点不产参考（零行为，不编造）", () => {
  assert.deepEqual(sceneCardGenerationReferences(imageGen("n1")), []);
  assert.deepEqual(sceneCardGenerationReferences(undefined), []);
});

test("scene_3d 无 sceneCard / stills 缺席 ⇒ 零参考", () => {
  assert.deepEqual(sceneCardGenerationReferences(node("n1", CanvasNodeType.Scene3d, {})), []);
  assert.deepEqual(
    sceneCardGenerationReferences(
      node("n2", CanvasNodeType.Scene3d, { sceneCard: { glb_path: "/api/blender-artifact?name=a.glb" } }),
    ),
    [],
  );
});

test("stills → 参考图：影片被剔除、首张带回分镜指针、其余靠 url 去重", () => {
  const refs = sceneCardGenerationReferences(stage("stage-1"));
  assert.equal(refs.length, 2, "turntable(mp4) 必须被剔除，只留两张 stills");
  assert.deepEqual(
    refs.map((r) => r.url),
    DIRECTOR_CARD.stills_urls,
  );
  // 首张带 nodeId＝舞台节点 id（回分镜指针的载体）；其余不得带（否则去重会弄丢帧）。
  assert.equal(refs[0]!.nodeId, "stage-1");
  assert.equal(refs[1]!.nodeId, undefined);
  assert.ok(refs.every((r) => typeof r.role === "string" && r.role.length > 0));
  assert.ok(refs.every((r) => typeof r.name === "string" && r.name.length > 0));
});

// ── ② 沿入边配对 ＋ 回分镜可追溯 ────────────────────────────────────────────

test("入边来自 scene_3d ⇒ 参考并入且 trace 指向该舞台", () => {
  const result = resolveSceneDirectorReferences(
    [stage("stage-1"), imageGen("gen-1")],
    [edge("stage-1", "gen-1")],
    "gen-1",
  );
  assert.equal(result.references.length, 2);
  assert.deepEqual(result.trace, { directorStageId: "stage-1" });
});

test("无 scene_3d 入边 / 出边不算入 ⇒ 空参考与 null trace", () => {
  const nodes = [stage("stage-1"), imageGen("gen-1")];
  // 方向相反（舞台在这条边的下游）不算参考来源。
  assert.deepEqual(resolveSceneDirectorReferences(nodes, [edge("gen-1", "stage-1")], "gen-1"), {
    references: [],
    trace: null,
  });
  assert.deepEqual(resolveSceneDirectorReferences(nodes, [], "gen-1"), { references: [], trace: null });
});

test("shotId 优先取舞台自身镜号，其次取生成节点自身", () => {
  const shot = { shotNumber: "S12" };
  const fromStage = resolveSceneDirectorReferences(
    [stage("stage-1", { storyboardShot: shot }), imageGen("gen-1")],
    [edge("stage-1", "gen-1")],
    "gen-1",
  );
  assert.equal(fromStage.trace?.shotId, "S12");

  // 舞台没有镜号时，退而取生成节点自己的分镜归属。
  const fromTarget = resolveSceneDirectorReferences(
    [stage("stage-1"), imageGen("gen-1", { storyboardShot: shot })],
    [edge("stage-1", "gen-1")],
    "gen-1",
  );
  assert.equal(fromTarget.trace?.shotId, "S12");

  // 两边都没有＝缺席（不编造空字串）。
  const none = resolveSceneDirectorReferences(
    [stage("stage-1"), imageGen("gen-1")],
    [edge("stage-1", "gen-1")],
    "gen-1",
  );
  assert.equal(none.trace?.shotId, undefined);
});

test("两个舞台连入 ⇒ 帧全数保留，指针只指第一个真有帧的舞台", () => {
  const result = resolveSceneDirectorReferences(
    [
      stage("stage-empty", { sceneCard: { glb_path: "/api/blender-artifact?name=a.glb" } }),
      stage("stage-2"),
      imageGen("gen-1"),
    ],
    [edge("stage-empty", "gen-1"), edge("stage-2", "gen-1")],
    "gen-1",
  );
  assert.equal(result.references.length, 2, "无帧的舞台不贡献参考，但有帧的舞台帧要全留");
  assert.equal(result.trace?.directorStageId, "stage-2");
});

// ── ③ 溯源指针的写入／读回往复 ─────────────────────────────────────────────

test("trace → metadata → 读回：往复相等", () => {
  const trace = { directorStageId: "stage-9", shotId: "S03" };
  const metadata = sceneDirectorTraceMetadata(trace);
  assert.deepEqual(metadata, { directorStageId: "stage-9", shotId: "S03" });
  assert.deepEqual(readSceneDirectorTrace(metadata), trace);
});

test("无 trace / 空 directorStageId ⇒ 不写空壳键、读回 null（不造半形指针）", () => {
  assert.deepEqual(sceneDirectorTraceMetadata(null), {});
  assert.deepEqual(sceneDirectorTraceMetadata(undefined), {});
  assert.deepEqual(sceneDirectorTraceMetadata({ directorStageId: "   " }), {});
  assert.equal(readSceneDirectorTrace({}), null);
  assert.equal(readSceneDirectorTrace({ directorStageId: "   " }), null);
  assert.equal(readSceneDirectorTrace(undefined), null);
});

test("值一律 trim，写入端与读回端同一把尺", () => {
  const metadata = sceneDirectorTraceMetadata({ directorStageId: " stage-3 ", shotId: " S07 " });
  assert.deepEqual(metadata, { directorStageId: "stage-3", shotId: "S07" });
  assert.deepEqual(readSceneDirectorTrace({ directorStageId: " stage-3 ", shotId: " S07 " }), {
    directorStageId: "stage-3",
    shotId: "S07",
  });
});

// ── ④ 两键必须活在 metadata 双白名单内（漏一端＝回旧会话后指针消失） ─────────

test("溯源两键经真实清洗器存活（不进白名单就会被静默剥掉）", async () => {
  const { toNodeMetadata } = await import("./layout");
  const { compactMetadataForAgent } = await import("@/hooks/canvas/canvas-chat-types");
  const patched = {
    ...sceneDirectorTraceMetadata({ directorStageId: "stage-5", shotId: "S01" }),
    sceneCard: DIRECTOR_CARD,
  };
  const restored = toNodeMetadata(compactMetadataForAgent(patched));
  assert.equal(restored.directorStageId, "stage-5");
  assert.equal(restored.shotId, "S01");
});
