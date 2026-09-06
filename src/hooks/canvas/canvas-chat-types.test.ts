// compactMetadataForAgent 回歸測試（2026-09-03 導演台「示意图未同步」事故）。
// 事故鏈：上行壓縮白名單不含 director 欄位 → gateway 快照裡導演台節點是空殼 →
// 刷新/恢復後還原出的節點缺 directorSessionId/SVG → NodeBody 落到兜底文案。
// 本測試釘死往復合同：壓縮輸出經 toNodeMetadata（還原端）後指針欄位原樣存活。
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactMetadataForAgent } from "./canvas-chat-types";
import { toNodeMetadata } from "@/lib/canvas/layout";
import type { CanvasNodeMetadata } from "@/lib/canvas/types";

const BIG_SVG = `<svg>${"x".repeat(60 * 1024)}</svg>`;

test("director 節點壓縮保留指針欄位、剔除 SVG", () => {
  const meta: CanvasNodeMetadata = {
    pipelineCard: "director",
    directorSessionId: "sess_abc123",
    planName: "分鏡方案 A",
    shotCount: 6,
    healthOk: true,
    revision: 12,
    topViewSvg: BIG_SVG,
    cameraViewSvg: BIG_SVG,
  };
  const compacted = compactMetadataForAgent(meta);
  assert.ok(compacted);
  assert.equal(compacted.pipelineCard, "director");
  assert.equal(compacted.directorSessionId, "sess_abc123");
  assert.equal(compacted.planName, "分鏡方案 A");
  assert.equal(compacted.shotCount, 6);
  assert.equal(compacted.healthOk, true);
  assert.equal(compacted.revision, 12);
  assert.equal(compacted.topViewSvg, undefined);
  assert.equal(compacted.cameraViewSvg, undefined);
});

test("壓縮輸出經還原端 toNodeMetadata 後 director 指針不丟（往復合同）", () => {
  const meta: CanvasNodeMetadata = {
    pipelineCard: "director",
    directorSessionId: "sess_abc123",
    planName: null,
    shotCount: 0,
    healthOk: false,
    revision: 3,
  };
  const restored = toNodeMetadata(compactMetadataForAgent(meta));
  assert.equal(restored.pipelineCard, "director");
  assert.equal(restored.directorSessionId, "sess_abc123");
  assert.equal(restored.planName, null);
  assert.equal(restored.shotCount, 0);
  assert.equal(restored.healthOk, false);
  assert.equal(restored.revision, 3);
});

test("非 director 節點不受影響：SVG 欄位從不外傳", () => {
  const compacted = compactMetadataForAgent({ content: "hello", topViewSvg: BIG_SVG });
  assert.deepEqual(compacted, { content: "hello" });
});

// ── 3D 場景卡（2026-09-06 Astra PRD P1-3）：sceneCard 欄位族往復合同 ──

const SCENE_CARD = {
  turntable_url: "https://cdn.example.com/turntable.mp4",
  stills_urls: ["https://cdn.example.com/s1.png", "https://cdn.example.com/s2.png", "https://cdn.example.com/s3.png"],
  blend_path: "/api/scene-assets/scene_01.blend",
  glb_path: "/api/scene-assets/scene_01.glb",
  scene_summary: "废弃灯塔主场景 · 白模已上材质",
  duration_ms: 8000,
};

test("scene_3d 節點壓縮保留 sceneCard 六欄", () => {
  const compacted = compactMetadataForAgent({ sceneCard: SCENE_CARD });
  assert.ok(compacted);
  assert.deepEqual(compacted.sceneCard, SCENE_CARD);
});

test("壓縮輸出經還原端 toNodeMetadata 後 sceneCard 不丟（往復合同）", () => {
  const meta: CanvasNodeMetadata = { sceneCard: SCENE_CARD };
  const restored = toNodeMetadata(compactMetadataForAgent(meta));
  assert.deepEqual(restored.sceneCard, SCENE_CARD);
});

test("sceneCard 非契約形狀在還原端整包丟棄（缺 turntable_url）", () => {
  const restored = toNodeMetadata({ sceneCard: { stills_urls: ["x.png"], scene_summary: "殘形" } });
  assert.equal(restored.sceneCard, undefined);
});

test("非 scene_3d 節點不受影響：無 sceneCard 不外傳空欄位", () => {
  const compacted = compactMetadataForAgent({ content: "hello" });
  assert.deepEqual(compacted, { content: "hello" });
});
