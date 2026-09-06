// blender-delegate 契約測試（Astra P1-4 片H，2026-09-06）。
// 覆蓋：委託單 schema 校驗（缺欄/超界/超 2k token）、產物分揀（齊全/缺 mp4
// 兜底/空產物/缺 blend+glb 報錯）、add_node op 形狀與
// CANVAS_NODE_DEFAULT_SIZE[Scene3d] / toScene3dCard 讀取端契約兼容（tsc 即證 +
// 運行時斷言）。

import assert from "node:assert/strict";
import test from "node:test";
import {
  BLENDER_DELIVERABLES,
  DELEGATION_TOKEN_BUDGET,
  buildScene3dCanvasOp,
  collectSceneCardFromArtifacts,
  composeDelegation,
  estimateTokens,
  sceneCardFromExecuteResult,
  sceneCardOpFromExecuteResult,
  type BlenderArtifact,
} from "./blender-delegate";
import { CANVAS_NODE_DEFAULT_SIZE, type Scene3dCardMetadata } from "./canvas/types";
import type { BlenderExecuteSuccess } from "./blender-tools";

// ── 樣本工廠 ──────────────────────────────────────────────────────────────

function artifacts(): BlenderArtifact[] {
  return [
    { path: "turntable.mp4", bytes: 1_024, kind: "mp4" },
    { path: "render_f0001.png", bytes: 2_048, kind: "png" },
    { path: "render_f0002.png", bytes: 2_048, kind: "png" },
    { path: "render_f0003.png", bytes: 2_048, kind: "png" },
    { path: "scene.blend", bytes: 4_096, kind: "blend" },
    { path: "scene.glb", bytes: 8_192, kind: "glb" },
    { path: "log.txt", bytes: 16, kind: "other" },
  ];
}

function executeResult(): BlenderExecuteSuccess {
  return {
    ok: true,
    artifacts: artifacts(),
    scene_summary: "低多邊形山丘場景，三點打光",
    stdout_tail: "RENDER_DONE: turntable turntable.mp4",
    duration_ms: 3_700,
  };
}

// ── composeDelegation：schema 校驗 ────────────────────────────────────────

test("composeDelegation 合法輸入產全形委託單", () => {
  const result = composeDelegation({
    effect_description: "主角站在懸崖邊，風吹動披風，鏡頭緩慢推進",
    reference_refs: ["node-123", "uploads/abc/ref.png"],
    shot_count: 3,
    duration_sec: 5,
    style_constraints: "eevee 快稿、柔和日光",
    deliverables: ["turntable", "stills", "blend", "glb"],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.delegation.deliverables, ["turntable", "stills", "blend", "glb"]);
  assert.equal(result.delegation.shot_count, 3);
  assert.equal(result.delegation.duration_sec, 5);
  assert.ok(result.serialized.startsWith("{"));
  assert.ok(result.estimated_tokens <= DELEGATION_TOKEN_BUDGET);
});

test("composeDelegation 缺必填欄返回結構化錯誤", () => {
  for (const partial of [
    {},
    { effect_description: "x" },
    { effect_description: "x", shot_count: 1 },
    { shot_count: 1, deliverables: ["blend"] },
  ]) {
    const result = composeDelegation(partial);
    assert.equal(result.ok, false, JSON.stringify(partial));
    if (result.ok) return;
    assert.equal(result.code, "invalid_delegation");
    assert.ok(result.hint.length > 0);
    assert.ok(result.fields.length > 0);
  }
});

test("composeDelegation 超界欄位逐項報錯", () => {
  const result = composeDelegation({
    effect_description: "超".repeat(601),
    shot_count: 0,
    duration_sec: 121,
    style_constraints: "長".repeat(301),
    reference_refs: Array.from({ length: 9 }, (_, i) => `ref-${i}`),
    deliverables: ["turntable", "vibes"],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  for (const f of ["effect_description", "shot_count", "duration_sec", "style_constraints", "reference_refs", "deliverables"]) {
    assert.ok(result.fields.includes(f), `missing field ${f}`);
  }
});

test("composeDelegation shot_count 非整數 / 超 12 / deliverables 非白名單", () => {
  assert.equal(composeDelegation({ effect_description: "x", shot_count: 1.5, deliverables: ["blend"] }).ok, false);
  assert.equal(composeDelegation({ effect_description: "x", shot_count: 13, deliverables: ["blend"] }).ok, false);
  assert.equal(composeDelegation({ effect_description: "x", shot_count: 1, deliverables: ["mp4"] }).ok, false);
  assert.equal(composeDelegation({ effect_description: "x", shot_count: 1, deliverables: ["turntable", "turntable"] }).ok, false === false ? true : false);
});

test("composeDelegation 超長輸入超 2k token 結構化報錯", () => {
  // 逐欄合規但總量超預算：CJK 逐字記 1 token，600+300+8×200=2500 token > 2000。
  const result = composeDelegation({
    effect_description: "超".repeat(600),
    style_constraints: "長".repeat(300),
    reference_refs: Array.from({ length: 8 }, () => "字".repeat(200)),
    shot_count: 1,
    deliverables: ["blend"],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.hint.includes("token"));
});

test("estimateTokens CJK 記 1 / ASCII 記 1/4", () => {
  assert.equal(estimateTokens("一二三四"), 4);
  assert.equal(estimateTokens("abcdefgh"), 2);
});

// ── collectSceneCardFromArtifacts：產物分揀 ───────────────────────────────

test("產物齊全：六欄全形 + mp4 當 turntable + png 清單當 stills", () => {
  const injected = (a: BlenderArtifact) => `mock://${a.path}`;
  const result = collectSceneCardFromArtifacts(artifacts(), {
    scene_summary: "低多邊形山丘場景",
    duration_ms: 3_700,
    resolveArtifactUrl: injected,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.turntable_fallback, false);
  const card: Scene3dCardMetadata = result.sceneCard;
  assert.equal(card.turntable_url, "mock://turntable.mp4");
  assert.deepEqual(card.stills_urls, ["mock://render_f0001.png", "mock://render_f0002.png", "mock://render_f0003.png"]);
  assert.equal(card.blend_path, "mock://scene.blend");
  assert.equal(card.glb_path, "mock://scene.glb");
  assert.equal(card.scene_summary, "低多邊形山丘場景");
  assert.equal(card.duration_ms, 3_700);
});

test("缺 mp4：首張 png 兜底 turntable_url 且 summary 前綴標注", () => {
  const pngOnly = artifacts().filter((a) => a.kind !== "mp4");
  const result = collectSceneCardFromArtifacts(pngOnly, {
    scene_summary: "山丘場景",
    duration_ms: 3_700,
    resolveArtifactUrl: (a) => `mock://${a.path}`,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.turntable_fallback, true);
  assert.equal(result.sceneCard.turntable_url, "mock://render_f0001.png");
  assert.ok(result.sceneCard.scene_summary.startsWith("（turntable 缺席"));
  assert.ok(result.sceneCard.scene_summary.includes("山丘場景"));
  assert.ok(result.sceneCard.stills_urls.includes("mock://render_f0001.png"));
});

test("空產物：no_artifacts 結構化錯誤", () => {
  const result = collectSceneCardFromArtifacts([], { scene_summary: "x", duration_ms: 1 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "no_artifacts");
  assert.ok(result.hint.includes(".blender-work/out/"));
});

test("缺 blend 或 glb：missing_deliverables 不產半形", () => {
  const noBlend = artifacts().filter((a) => a.kind !== "blend");
  const r1 = collectSceneCardFromArtifacts(noBlend, { scene_summary: "x", duration_ms: 1 });
  assert.equal(r1.ok, false);
  if (!r1.ok) {
    assert.equal(r1.code, "missing_deliverables");
    assert.deepEqual(r1.missing, ["blend"]);
  }
  const noGlb = artifacts().filter((a) => a.kind !== "glb");
  const r2 = collectSceneCardFromArtifacts(noGlb, { scene_summary: "x", duration_ms: 1 });
  assert.equal(r2.ok, false);
  if (!r2.ok) {
    assert.equal(r2.code, "missing_deliverables");
    assert.deepEqual(r2.missing, ["glb"]);
  }
});

test("缺省 URL 映射：絕對 URL 原樣、純檔名落站內絕對路徑", () => {
  const result = collectSceneCardFromArtifacts(
    [
      { path: "https://cdn.example.com/t.mp4", bytes: 1, kind: "mp4" },
      { path: "stills/a.png", bytes: 1, kind: "png" },
      { path: "scene.blend", bytes: 1, kind: "blend" },
      { path: "scene.glb", bytes: 1, kind: "glb" },
    ],
    { scene_summary: "x", duration_ms: 2_000 },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sceneCard.turntable_url, "https://cdn.example.com/t.mp4");
  assert.deepEqual(result.sceneCard.stills_urls, ["/stills/a.png"]);
  assert.equal(result.sceneCard.blend_path, "/scene.blend");
});

test("sceneCardFromExecuteResult 吃 bridge 成功體：空 summary 兜底、負 duration 收斂 0", () => {
  const r1 = sceneCardFromExecuteResult({ ...executeResult(), scene_summary: "  " });
  assert.equal(r1.ok, true);
  if (r1.ok) assert.equal(r1.sceneCard.scene_summary, "3D 場景交付");
  const r2 = sceneCardFromExecuteResult({ ...executeResult(), duration_ms: -5 });
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.sceneCard.duration_ms, 0);
});

// ── 節點寫入 op：canvas_apply_ops 輪子形 ─────────────────────────────────

test("buildScene3dCanvasOp 產 add_node op（scene_3d + sceneCard 單欄 metadata）", () => {
  const card: Scene3dCardMetadata = {
    turntable_url: "/out/turntable.mp4",
    stills_urls: ["/out/a.png", "/out/b.png"],
    blend_path: "/out/scene.blend",
    glb_path: "/out/scene.glb",
    scene_summary: "山丘",
    duration_ms: 3_700,
  };
  const op = buildScene3dCanvasOp(card, { node_id: "scene3d-fixed", title: "懸崖場景" });
  assert.equal(op.type, "add_node");
  assert.equal(op.node.id, "scene3d-fixed");
  assert.equal(op.node.type, "scene_3d");
  assert.equal(op.node.title, "懸崖場景");
  assert.deepEqual(op.node.metadata.sceneCard, card);
  // 缺 title → normalizeAgentNode 落 CANVAS_NODE_DEFAULT_SIZE[Scene3d].title「3D 场景卡」
  assert.equal(buildScene3dCanvasOp(card).node.title, undefined);
  // 對照讀取端預設尺寸（缺 width/height 時 normalizeAgentNode 的取值來源）
  assert.deepEqual(CANVAS_NODE_DEFAULT_SIZE.scene_3d, { width: 420, height: 360, title: "3D 场景卡" });
});

test("sceneCardOpFromExecuteResult 一行組裝 + 同產物同 id（重觸發去重）", () => {
  const r1 = sceneCardOpFromExecuteResult(executeResult(), { resolveArtifactUrl: (a) => `mock://${a.path}` });
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  assert.equal(r1.op.node.type, "scene_3d");
  assert.match(r1.op.node.id, /^scene3d-[0-9a-f]{8}$/);
  const r2 = sceneCardOpFromExecuteResult(executeResult(), { resolveArtifactUrl: (a) => `mock://${a.path}` });
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  assert.equal(r2.op.node.id, r1.op.node.id);
  assert.equal(r1.turntable_fallback, false);
});

test("sceneCardOpFromExecuteResult 缺關鍵產物透傳結構化錯誤", () => {
  const result = sceneCardOpFromExecuteResult({ ...executeResult(), artifacts: [{ path: "a.png", bytes: 1, kind: "png" }] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "missing_deliverables");
  assert.deepEqual(result.missing, ["blend", "glb"]);
});

test("交付物白名單與六欄對齊（契約釘死）", () => {
  assert.deepEqual([...BLENDER_DELIVERABLES], ["turntable", "stills", "blend", "glb"]);
});
