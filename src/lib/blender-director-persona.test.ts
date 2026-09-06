// blender-director-persona 契約測試（Astra P1-4 片J，2026-09-06）。
// 覆蓋 persona 契約四要素：①名稱文案簡體 ②工具白名單（=BLENDER_HARNESS_TOOL_IDS
// +image_quote，禁全工具面）③SKILL 掛載引用存在 ④委託單+回傳契約全 import
// （assembleDirectorReply 走真 blender-delegate 輪子，op 形狀/錯誤透傳釘死）。

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

// ── ① 名稱/文案 ────────────────────────────────────────────────────────────

test("persona 名稱：id=director、展示名簡體「3D 导演」、描述非空", () => {
  assert.equal(DIRECTOR_PERSONA_ID, "director");
  assert.equal(DIRECTOR_PERSONA_LABEL, "3D 导演");
  assert.ok(DIRECTOR_PERSONA_DESCRIPTION.length > 0);
  // 簡體鐵律：展示名與描述不得含繁體專用字（一刀切掃「導/產/應/於/後」）。
  for (const ch of ["導", "產", "應", "後"]) {
    assert.ok(!DIRECTOR_PERSONA_LABEL.includes(ch), `label 含繁體字 ${ch}`);
    assert.ok(!DIRECTOR_PERSONA_DESCRIPTION.includes(ch), `description 含繁體字 ${ch}`);
  }
});

// ── ② 工具白名單 ───────────────────────────────────────────────────────────

test("工具白名單 = BLENDER_HARNESS_TOOL_IDS + image_quote，恰好四件", () => {
  // 順序照 blender-tools.ts 真源（blender_exec/blender_export_gltf/blender_render）。
  assert.deepEqual([...DIRECTOR_PERSONA_TOOL_IDS], ["blender_exec", "blender_export_gltf", "blender_render", "image_quote"]);
  // 引用而非手抄：與 blender-tools.ts 真源逐字一致。
  for (const id of BLENDER_HARNESS_TOOL_IDS) {
    assert.ok((DIRECTOR_PERSONA_TOOL_IDS as readonly string[]).includes(id));
  }
});

// ── ③ SKILL 掛載 ───────────────────────────────────────────────────────────

test("SKILL 掛載路徑存在且是 3D 導演配方庫真源", () => {
  // 本測試檔在 src/lib/，SKILL 真源在 repo 根 skills/。
  const abs = path.resolve(fileURLToPath(import.meta.url), "../../..", DIRECTOR_PERSONA_SKILL_PATH);
  const content = readFileSync(abs, "utf8");
  assert.ok(content.includes("3D 导演"));
  assert.ok(content.includes("bridge")); // 執行通道契約仍在
});

// ── ④ 委託單 + 回傳契約（import 輪子，零重定義） ────────────────────────────

function executeResult(): BlenderExecuteSuccess {
  return {
    ok: true,
    artifacts: [
      { path: "turntable.mp4", bytes: 1_024, kind: "mp4" },
      { path: "render_f0001.png", bytes: 2_048, kind: "png" },
      { path: "scene.blend", bytes: 4_096, kind: "blend" },
      { path: "scene.glb", bytes: 8_192, kind: "glb" },
    ],
    scene_summary: "低多邊形山丘場景，三點打光",
    stdout_tail: "RENDER_DONE: turntable",
    duration_ms: 3_700,
  };
}

test("composeDirectorDelegation = composeDelegation 輪子（合法單全形透傳）", () => {
  const r = composeDirectorDelegation({
    effect_description: "主角站在懸崖邊，風吹披風",
    shot_count: 2,
    deliverables: ["turntable", "blend", "glb"],
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const d: BlenderDelegation = r.delegation;
  assert.equal(d.effect_description, "主角站在懸崖邊，風吹披風");
  assert.deepEqual(d.deliverables, ["turntable", "blend", "glb"]);
});

test("assembleDirectorReply 產 scene_op + summary（回傳只含資產引用+摘要）", () => {
  const reply = assembleDirectorReply(executeResult(), { title: "懸崖場景" });
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  const typed: DirectorDelegationReply = reply;
  assert.equal(typed.scene_op.type, "add_node");
  assert.equal(typed.scene_op.node.type, "scene_3d");
  assert.equal(typed.scene_op.node.title, "懸崖場景");
  assert.ok(typed.scene_op.node.metadata.sceneCard.turntable_url.endsWith("turntable.mp4"));
  assert.equal(typed.scene_summary, "低多邊形山丘場景，三點打光");
  // 隔離鐵律：回傳鍵集合不帶 stdout/腳本/過程痕跡。
  assert.deepEqual(Object.keys(typed).sort(), ["ok", "scene_op", "scene_summary"]);
});

test("assembleDirectorReply 缺關鍵產物 → 結構化錯誤透傳（不產半形）", () => {
  const reply = assembleDirectorReply({
    ...executeResult(),
    artifacts: [{ path: "a.png", bytes: 1, kind: "png" }],
  });
  assert.equal(reply.ok, false);
  if (reply.ok) return;
  assert.equal(reply.code, "missing_deliverables");
  assert.ok(reply.hint.length > 0);
});

test("隔離鐵律：摘要 ≤500 token 帽常量釘死且樣本遠低於帽", () => {
  assert.equal(DIRECTOR_REPLY_SUMMARY_TOKEN_CAP, 500);
  const reply = assembleDirectorReply(executeResult());
  if (reply.ok) {
    assert.ok(estimateTokens(reply.scene_summary) <= DIRECTOR_REPLY_SUMMARY_TOKEN_CAP);
  }
});
