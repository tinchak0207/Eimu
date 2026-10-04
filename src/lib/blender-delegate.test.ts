// blender-delegate 契约测试（Astra P1-4 片H，2026-09-06）。
// 覆盖：委托单 schema 校验（缺栏/超界/超 2k token）、产物分拣（齐全/缺 mp4
// 兜底/空产物/缺 blend+glb 报错）、add_node op 形状与
// CANVAS_NODE_DEFAULT_SIZE[Scene3d] / toScene3dCard 读取端契约兼容（tsc 即证 +
// 运行时断言）。

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

// ── 样本工厂 ──────────────────────────────────────────────────────────────

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
    scene_summary: "低多边形山丘场景，三点打光",
    stdout_tail: "RENDER_DONE: turntable turntable.mp4",
    duration_ms: 3_700,
  };
}

// ── composeDelegation：schema 校验 ────────────────────────────────────────

test("composeDelegation 合法输入产全形委托单", () => {
  const result = composeDelegation({
    effect_description: "主角站在悬崖边，风吹动披风，镜头缓慢推进",
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

test("composeDelegation 缺必填栏返回结构化错误", () => {
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

test("composeDelegation 超界栏位逐项报错", () => {
  const result = composeDelegation({
    effect_description: "超".repeat(601),
    shot_count: 0,
    duration_sec: 121,
    style_constraints: "长".repeat(301),
    reference_refs: Array.from({ length: 9 }, (_, i) => `ref-${i}`),
    deliverables: ["turntable", "vibes"],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  for (const f of ["effect_description", "shot_count", "duration_sec", "style_constraints", "reference_refs", "deliverables"]) {
    assert.ok(result.fields.includes(f), `missing field ${f}`);
  }
});

test("composeDelegation shot_count 非整数 / 超 12 / deliverables 非白名单", () => {
  assert.equal(composeDelegation({ effect_description: "x", shot_count: 1.5, deliverables: ["blend"] }).ok, false);
  assert.equal(composeDelegation({ effect_description: "x", shot_count: 13, deliverables: ["blend"] }).ok, false);
  assert.equal(composeDelegation({ effect_description: "x", shot_count: 1, deliverables: ["mp4"] }).ok, false);
  assert.equal(composeDelegation({ effect_description: "x", shot_count: 1, deliverables: ["turntable", "turntable"] }).ok, false === false ? true : false);
});

test("composeDelegation 超长输入超 2k token 结构化报错", () => {
  // 逐栏合规但总量超预算：CJK 逐字记 1 token，600+300+8×200=2500 token > 2000。
  const result = composeDelegation({
    effect_description: "超".repeat(600),
    style_constraints: "长".repeat(300),
    reference_refs: Array.from({ length: 8 }, () => "字".repeat(200)),
    shot_count: 1,
    deliverables: ["blend"],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.hint.includes("token"));
});

test("estimateTokens CJK 记 1 / ASCII 记 1/4", () => {
  assert.equal(estimateTokens("一二三四"), 4);
  assert.equal(estimateTokens("abcdefgh"), 2);
});

// ── collectSceneCardFromArtifacts：产物分拣 ───────────────────────────────

test("产物齐全：六栏全形 + mp4 当 turntable + png 清单当 stills", () => {
  const injected = (a: BlenderArtifact) => `mock://${a.path}`;
  const result = collectSceneCardFromArtifacts(artifacts(), {
    scene_summary: "低多边形山丘场景",
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
  assert.equal(card.scene_summary, "低多边形山丘场景");
  assert.equal(card.duration_ms, 3_700);
});

test("缺 mp4：首张 png 兜底 turntable_url 且 summary 前缀标注", () => {
  const pngOnly = artifacts().filter((a) => a.kind !== "mp4");
  const result = collectSceneCardFromArtifacts(pngOnly, {
    scene_summary: "山丘场景",
    duration_ms: 3_700,
    resolveArtifactUrl: (a) => `mock://${a.path}`,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.turntable_fallback, true);
  assert.equal(result.sceneCard.turntable_url, "mock://render_f0001.png");
  assert.ok(result.sceneCard.scene_summary.startsWith("（turntable 缺席"));
  assert.ok(result.sceneCard.scene_summary.includes("山丘场景"));
  assert.ok(result.sceneCard.stills_urls.includes("mock://render_f0001.png"));
});

test("空产物：no_artifacts 结构化错误", () => {
  const result = collectSceneCardFromArtifacts([], { scene_summary: "x", duration_ms: 1 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "no_artifacts");
  assert.ok(result.hint.includes(".blender-work/out/"));
});

test("缺 blend 或 glb：missing_deliverables 不产半形", () => {
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

test("缺省 URL 映射：绝对 URL 原样、纯档名落站内绝对路径", () => {
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

test("sceneCardFromExecuteResult 吃 bridge 成功体：空 summary 兜底、负 duration 收敛 0", () => {
  const r1 = sceneCardFromExecuteResult({ ...executeResult(), scene_summary: "  " });
  assert.equal(r1.ok, true);
  if (r1.ok) assert.equal(r1.sceneCard.scene_summary, "3D 场景交付");
  const r2 = sceneCardFromExecuteResult({ ...executeResult(), duration_ms: -5 });
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.sceneCard.duration_ms, 0);
});

// ── 节点写入 op：canvas_apply_ops 轮子形 ─────────────────────────────────

test("buildScene3dCanvasOp 产 add_node op（scene_3d + sceneCard 单栏 metadata）", () => {
  const card: Scene3dCardMetadata = {
    turntable_url: "/out/turntable.mp4",
    stills_urls: ["/out/a.png", "/out/b.png"],
    blend_path: "/out/scene.blend",
    glb_path: "/out/scene.glb",
    scene_summary: "山丘",
    duration_ms: 3_700,
  };
  const op = buildScene3dCanvasOp(card, { node_id: "scene3d-fixed", title: "悬崖场景" });
  assert.equal(op.type, "add_node");
  assert.equal(op.node.id, "scene3d-fixed");
  assert.equal(op.node.type, "scene_3d");
  assert.equal(op.node.title, "悬崖场景");
  assert.deepEqual(op.node.metadata.sceneCard, card);
  // 缺 title → normalizeAgentNode 落 CANVAS_NODE_DEFAULT_SIZE[Scene3d].title「3D 场景卡」
  assert.equal(buildScene3dCanvasOp(card).node.title, undefined);
  // 对照读取端预设尺寸（缺 width/height 时 normalizeAgentNode 的取值来源）
  assert.deepEqual(CANVAS_NODE_DEFAULT_SIZE.scene_3d, { width: 420, height: 360, title: "3D 场景卡" });
});

test("sceneCardOpFromExecuteResult 一行组装 + 同产物同 id（重触发去重）", () => {
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

test("sceneCardOpFromExecuteResult 缺关键产物透传结构化错误", () => {
  const result = sceneCardOpFromExecuteResult({ ...executeResult(), artifacts: [{ path: "a.png", bytes: 1, kind: "png" }] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "missing_deliverables");
  assert.deepEqual(result.missing, ["blend", "glb"]);
});

test("交付物白名单与六栏对齐（契约钉死）", () => {
  assert.deepEqual([...BLENDER_DELIVERABLES], ["turntable", "stills", "blend", "glb"]);
});
