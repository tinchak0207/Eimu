// P1-1（對稱差 D5）3D 白模/靜態圖當生成參考：參考綁定 ＋ 回分鏡溯源的行為契約。
//
// 這支補的是「agent 交了碼但沒有任何行為斷言」的洞（orchestrator 驗收補刀）：
// 全部走真函式（buildSceneFrameReferenceCard → 參考卡 → 畫布參考形），不是源碼字串掃描。
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

/** 導演交付的六欄卡：stills 兩張、turntable 是影片（必須被剔除）。 */
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

// ── ① 參考綁定：scene_3d 的 stills 真的變成生成參考 ─────────────────────────

test("非 scene_3d 節點不產參考（零行為，不編造）", () => {
  assert.deepEqual(sceneCardGenerationReferences(imageGen("n1")), []);
  assert.deepEqual(sceneCardGenerationReferences(undefined), []);
});

test("scene_3d 無 sceneCard / stills 缺席 ⇒ 零參考", () => {
  assert.deepEqual(sceneCardGenerationReferences(node("n1", CanvasNodeType.Scene3d, {})), []);
  assert.deepEqual(
    sceneCardGenerationReferences(
      node("n2", CanvasNodeType.Scene3d, { sceneCard: { glb_path: "/api/blender-artifact?name=a.glb" } }),
    ),
    [],
  );
});

test("stills → 參考圖：影片被剔除、首張帶回分鏡指針、其餘靠 url 去重", () => {
  const refs = sceneCardGenerationReferences(stage("stage-1"));
  assert.equal(refs.length, 2, "turntable(mp4) 必須被剔除，只留兩張 stills");
  assert.deepEqual(
    refs.map((r) => r.url),
    DIRECTOR_CARD.stills_urls,
  );
  // 首張帶 nodeId＝舞台節點 id（回分鏡指針的載體）；其餘不得帶（否則去重會弄丟幀）。
  assert.equal(refs[0]!.nodeId, "stage-1");
  assert.equal(refs[1]!.nodeId, undefined);
  assert.ok(refs.every((r) => typeof r.role === "string" && r.role.length > 0));
  assert.ok(refs.every((r) => typeof r.name === "string" && r.name.length > 0));
});

// ── ② 沿入邊配對 ＋ 回分鏡可追溯 ────────────────────────────────────────────

test("入邊來自 scene_3d ⇒ 參考併入且 trace 指向該舞台", () => {
  const result = resolveSceneDirectorReferences(
    [stage("stage-1"), imageGen("gen-1")],
    [edge("stage-1", "gen-1")],
    "gen-1",
  );
  assert.equal(result.references.length, 2);
  assert.deepEqual(result.trace, { directorStageId: "stage-1" });
});

test("無 scene_3d 入邊 / 出邊不算入 ⇒ 空參考與 null trace", () => {
  const nodes = [stage("stage-1"), imageGen("gen-1")];
  // 方向相反（舞台在這條邊的下游）不算參考來源。
  assert.deepEqual(resolveSceneDirectorReferences(nodes, [edge("gen-1", "stage-1")], "gen-1"), {
    references: [],
    trace: null,
  });
  assert.deepEqual(resolveSceneDirectorReferences(nodes, [], "gen-1"), { references: [], trace: null });
});

test("shotId 優先取舞台自身鏡號，其次取生成節點自身", () => {
  const shot = { shotNumber: "S12" };
  const fromStage = resolveSceneDirectorReferences(
    [stage("stage-1", { storyboardShot: shot }), imageGen("gen-1")],
    [edge("stage-1", "gen-1")],
    "gen-1",
  );
  assert.equal(fromStage.trace?.shotId, "S12");

  // 舞台沒有鏡號時，退而取生成節點自己的分鏡歸屬。
  const fromTarget = resolveSceneDirectorReferences(
    [stage("stage-1"), imageGen("gen-1", { storyboardShot: shot })],
    [edge("stage-1", "gen-1")],
    "gen-1",
  );
  assert.equal(fromTarget.trace?.shotId, "S12");

  // 兩邊都沒有＝缺席（不編造空字串）。
  const none = resolveSceneDirectorReferences(
    [stage("stage-1"), imageGen("gen-1")],
    [edge("stage-1", "gen-1")],
    "gen-1",
  );
  assert.equal(none.trace?.shotId, undefined);
});

test("兩個舞台連入 ⇒ 幀全數保留，指針只指第一個真有幀的舞台", () => {
  const result = resolveSceneDirectorReferences(
    [
      stage("stage-empty", { sceneCard: { glb_path: "/api/blender-artifact?name=a.glb" } }),
      stage("stage-2"),
      imageGen("gen-1"),
    ],
    [edge("stage-empty", "gen-1"), edge("stage-2", "gen-1")],
    "gen-1",
  );
  assert.equal(result.references.length, 2, "無幀的舞台不貢獻參考，但有幀的舞台幀要全留");
  assert.equal(result.trace?.directorStageId, "stage-2");
});

// ── ③ 溯源指針的寫入／讀回往復 ─────────────────────────────────────────────

test("trace → metadata → 讀回：往復相等", () => {
  const trace = { directorStageId: "stage-9", shotId: "S03" };
  const metadata = sceneDirectorTraceMetadata(trace);
  assert.deepEqual(metadata, { directorStageId: "stage-9", shotId: "S03" });
  assert.deepEqual(readSceneDirectorTrace(metadata), trace);
});

test("無 trace / 空 directorStageId ⇒ 不寫空殼鍵、讀回 null（不造半形指針）", () => {
  assert.deepEqual(sceneDirectorTraceMetadata(null), {});
  assert.deepEqual(sceneDirectorTraceMetadata(undefined), {});
  assert.deepEqual(sceneDirectorTraceMetadata({ directorStageId: "   " }), {});
  assert.equal(readSceneDirectorTrace({}), null);
  assert.equal(readSceneDirectorTrace({ directorStageId: "   " }), null);
  assert.equal(readSceneDirectorTrace(undefined), null);
});

test("值一律 trim，寫入端與讀回端同一把尺", () => {
  const metadata = sceneDirectorTraceMetadata({ directorStageId: " stage-3 ", shotId: " S07 " });
  assert.deepEqual(metadata, { directorStageId: "stage-3", shotId: "S07" });
  assert.deepEqual(readSceneDirectorTrace({ directorStageId: " stage-3 ", shotId: " S07 " }), {
    directorStageId: "stage-3",
    shotId: "S07",
  });
});

// ── ④ 兩鍵必須活在 metadata 雙白名單內（漏一端＝回舊會話後指針消失） ─────────

test("溯源兩鍵經真實清洗器存活（不進白名單就會被靜默剝掉）", async () => {
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
