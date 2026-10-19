// blender-director-persona 契约测试（Astra P1-4 片J，2026-09-06）。
// 覆盖 persona 契约四要素：①名称文案简体 ②工具白名单（=BLENDER_HARNESS_TOOL_IDS
// +image_quote，禁全工具面）③SKILL 挂载引用存在 ④委托单+回传契约全 import
// （assembleDirectorReply 走真 blender-delegate 轮子，op 形状/错误透传钉死）。

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DIRECTOR_PERSONA_DESCRIPTION,
  DIRECTOR_PERSONA_ID,
  DIRECTOR_PERSONA_LABEL,
  DIRECTOR_PERSONA_SKILL_PATH,
  DIRECTOR_PERSONA_TOOL_IDS,
  DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
  assembleDirectorReply,
  composeDirectorDelegation,
  type DirectorDelegationReply,
} from "./blender-director-persona";
import { BLENDER_HARNESS_TOOL_IDS, type BlenderExecuteSuccess } from "./blender-tools";
import { estimateTokens, type BlenderDelegation } from "./blender-delegate";

// ── ① 名称/文案 ────────────────────────────────────────────────────────────

test("persona 名称：id=director、展示名简体「3D 导演」、描述非空", () => {
  assert.equal(DIRECTOR_PERSONA_ID, "director");
  assert.equal(DIRECTOR_PERSONA_LABEL, "3D 导演");
  assert.ok(DIRECTOR_PERSONA_DESCRIPTION.length > 0);
  // 简体铁律：展示名与描述不得含繁体专用字（一刀切扫繁简映射：導/產/應/後/於）。
  for (const ch of ["導", "產", "應", "後", "於"]) {
    assert.ok(!DIRECTOR_PERSONA_LABEL.includes(ch), `label 含繁体字 ${ch}`);
    assert.ok(!DIRECTOR_PERSONA_DESCRIPTION.includes(ch), `description 含繁体字 ${ch}`);
  }
});

// ── ② 工具白名单 ───────────────────────────────────────────────────────────

test("工具白名单 = BLENDER_HARNESS_TOOL_IDS + image_quote，恰好四件", () => {
  // 顺序照 blender-tools.ts 真源（blender_exec/blender_export_gltf/blender_render）。
  assert.deepEqual([...DIRECTOR_PERSONA_TOOL_IDS], ["blender_exec", "blender_export_gltf", "blender_render", "image_quote"]);
  // 引用而非手抄：与 blender-tools.ts 真源逐字一致。
  for (const id of BLENDER_HARNESS_TOOL_IDS) {
    assert.ok((DIRECTOR_PERSONA_TOOL_IDS as readonly string[]).includes(id));
  }
});

// ── ③ SKILL 挂载 ───────────────────────────────────────────────────────────

test("SKILL 挂载路径存在且是 3D 导演配方库真源", () => {
  // 本测试档在 src/lib/，SKILL 真源在 repo 根 skills/。
  const abs = path.resolve(fileURLToPath(import.meta.url), "../../..", DIRECTOR_PERSONA_SKILL_PATH);
  const content = readFileSync(abs, "utf8");
  assert.ok(content.includes("3D 导演"));
  assert.ok(content.includes("bridge")); // 执行通道契约仍在
});

// ── ④ 委托单 + 回传契约（import 轮子，零重定义） ────────────────────────────

function executeResult(): BlenderExecuteSuccess {
  return {
    ok: true,
    artifacts: [
      { path: "turntable.mp4", bytes: 1_024, kind: "mp4" },
      { path: "render_f0001.png", bytes: 2_048, kind: "png" },
      { path: "scene.blend", bytes: 4_096, kind: "blend" },
      { path: "scene.glb", bytes: 8_192, kind: "glb" },
    ],
    scene_summary: "低多边形山丘场景，三点打光",
    stdout_tail: "RENDER_DONE: turntable",
    duration_ms: 3_700,
  };
}

test("composeDirectorDelegation = composeDelegation 轮子（合法单全形透传）", () => {
  const r = composeDirectorDelegation({
    effect_description: "主角站在悬崖边，风吹披风",
    shot_count: 2,
    deliverables: ["turntable", "blend", "glb"],
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const d: BlenderDelegation = r.delegation;
  assert.equal(d.effect_description, "主角站在悬崖边，风吹披风");
  assert.deepEqual(d.deliverables, ["turntable", "blend", "glb"]);
});

test("assembleDirectorReply 产 scene_op + summary（回传只含资产引用+摘要）", () => {
  const reply = assembleDirectorReply(executeResult(), { title: "悬崖场景" });
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  const typed: DirectorDelegationReply = reply;
  assert.equal(typed.scene_op.type, "add_node");
  assert.equal(typed.scene_op.node.type, "scene_3d");
  assert.equal(typed.scene_op.node.title, "悬崖场景");
  assert.ok(typed.scene_op.node.metadata.sceneCard.turntable_url.endsWith("turntable.mp4"));
  assert.equal(typed.scene_summary, "低多边形山丘场景，三点打光");
  // 隔离铁律：回传键集合不带 stdout/脚本/过程痕迹。
  assert.deepEqual(Object.keys(typed).sort(), ["ok", "scene_op", "scene_summary"]);
});

test("assembleDirectorReply 缺关键产物 → 结构化错误透传（不产半形）", () => {
  const reply = assembleDirectorReply({
    ...executeResult(),
    artifacts: [{ path: "a.png", bytes: 1, kind: "png" }],
  });
  assert.equal(reply.ok, false);
  if (reply.ok) return;
  assert.equal(reply.code, "missing_deliverables");
  assert.ok(reply.hint.length > 0);
});

test("隔离铁律：摘要 ≤500 token 帽常量钉死且样本远低于帽", () => {
  assert.equal(DIRECTOR_REPLY_SUMMARY_TOKEN_CAP, 500);
  const reply = assembleDirectorReply(executeResult());
  if (reply.ok) {
    assert.ok(estimateTokens(reply.scene_summary) <= DIRECTOR_REPLY_SUMMARY_TOKEN_CAP);
  }
});
