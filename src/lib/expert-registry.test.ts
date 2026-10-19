/**
 * Expert 注册表测试守卫（MOE 改革波 0-A，2026-09-08）。
 * 跑法（package.json 现有 test 跑法定向执行本档）：
 *   npx --yes tsx --test src/lib/expert-registry.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BEAST_MODE_SETTINGS_KEY,
  EXPERT_REGISTRY,
  assertExpertToolAccess,
  readBeastMode,
  routeExpert,
} from "./expert-registry";
import {
  DIRECTOR_PERSONA_DESCRIPTION,
  DIRECTOR_PERSONA_LABEL,
  DIRECTOR_PERSONA_SKILL_PATH,
  DIRECTOR_PERSONA_TOOL_IDS,
  DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
} from "./blender-director-persona";
import { BLENDER_DELIVERABLES } from "./blender-delegate";
import {
  MUSIC_DIRECTOR_PERSONA_DESCRIPTION,
  MUSIC_DIRECTOR_PERSONA_LABEL,
  MUSIC_DIRECTOR_PERSONA_SKILL_FILES_PATH,
  MUSIC_DIRECTOR_PERSONA_SKILL_PATH,
  MUSIC_DIRECTOR_PERSONA_TOOL_IDS,
  MUSIC_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
} from "./music-director-persona";
import { MUSIC_DELIVERABLES } from "./music-delegate";
import {
  VIDEO_DIRECTOR_PERSONA_DESCRIPTION,
  VIDEO_DIRECTOR_PERSONA_LABEL,
  VIDEO_DIRECTOR_PERSONA_SKILL_PATHS,
  VIDEO_DIRECTOR_PERSONA_TOOL_IDS,
  VIDEO_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
} from "./video-director-persona";
import { VIDEO_DELIVERABLES } from "./video-delegate";
import {
  EDITOR_PERSONA_DESCRIPTION,
  EDITOR_PERSONA_LABEL,
  EDITOR_PERSONA_SKILL_PATHS,
  EDITOR_PERSONA_TOOL_IDS,
  EDITOR_REPLY_SUMMARY_TOKEN_CAP,
} from "./editor-persona";
import { EDITOR_DELIVERABLES } from "./editor-delegate";
import {
  SCREENWRITER_PERSONA_DESCRIPTION,
  SCREENWRITER_PERSONA_LABEL,
  SCREENWRITER_PERSONA_SKILL_PATHS,
  SCREENWRITER_PERSONA_TOOL_IDS,
  SCREENWRITER_REPLY_SUMMARY_TOKEN_CAP,
} from "./screenwriter-persona";
import { SCREENWRITER_DELIVERABLES } from "./screenwriter-delegate";
import {
  MOTION_DIRECTOR_PERSONA_DESCRIPTION,
  MOTION_DIRECTOR_PERSONA_LABEL,
  MOTION_DIRECTOR_PERSONA_SKILL_PATHS,
  MOTION_DIRECTOR_PERSONA_TOOL_IDS,
  MOTION_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
} from "./motion-director-persona";
import { MOTION_DELIVERABLES } from "./motion-delegate";
import {
  WEB3D_DIRECTOR_PERSONA_DESCRIPTION,
  WEB3D_DIRECTOR_PERSONA_LABEL,
  WEB3D_DIRECTOR_PERSONA_SKILL_PATHS,
  WEB3D_DIRECTOR_PERSONA_TOOL_IDS,
  WEB3D_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP,
} from "./web3d-director-persona";
import { WEB3D_DELIVERABLES } from "./web3d-delegate";
import { HARNESS_TOOL_IDS } from "./harness-tool-registry";

// ─────────────────────────────────────────── readBeastMode（默认 OFF）

test("beast_mode 设定键名钉死", () => {
  assert.equal(BEAST_MODE_SETTINGS_KEY, "beast_mode");
});

test("readBeastMode：布林 true 开、布林 false 关", () => {
  assert.equal(readBeastMode({ beast_mode: true }), true);
  assert.equal(readBeastMode({ beast_mode: false }), false);
});

test("readBeastMode：缺栏位 = false（默认 OFF，零迁移）", () => {
  assert.equal(readBeastMode({}), false);
  assert.equal(readBeastMode({ other_key: true }), false);
});

test("readBeastMode：非布林值一律 false（字串/数字冒充不生效）", () => {
  assert.equal(readBeastMode({ beast_mode: "true" }), false);
  assert.equal(readBeastMode({ beast_mode: 1 }), false);
  assert.equal(readBeastMode({ beast_mode: null }), false);
});

test("readBeastMode：settings 非物件（null/原始值）= false", () => {
  assert.equal(readBeastMode(null), false);
  assert.equal(readBeastMode(undefined), false);
  assert.equal(readBeastMode("true"), false);
  assert.equal(readBeastMode(123), false);
});

// ─────────────────────────────────────────── director3d 行 = persona 轮子常量

test("director3d 行全部字段取自 blender-director-persona 常量（零复制）", () => {
  const def = EXPERT_REGISTRY.director3d;
  assert.ok(def, "director3d 必须注册");
  assert.equal(def.label, DIRECTOR_PERSONA_LABEL);
  assert.equal(def.description, DIRECTOR_PERSONA_DESCRIPTION);
  assert.deepEqual(def.toolIds, DIRECTOR_PERSONA_TOOL_IDS);
  assert.deepEqual(def.skillPaths, [DIRECTOR_PERSONA_SKILL_PATH]);
  assert.equal(def.replyTokenCap, DIRECTOR_REPLY_SUMMARY_TOKEN_CAP);
  assert.equal("provisioned" in def, false, "director3d 必须是启用行（不设 provisioned）");
});

test("director3d 交付契约：requiredFields = BLENDER_DELIVERABLES（import 不手抄）+ QC 签名必附", () => {
  const def = EXPERT_REGISTRY.director3d;
  assert.deepEqual(def.deliverableContract.requiredFields, BLENDER_DELIVERABLES);
  assert.equal(def.deliverableContract.qcSignatureRequired, true);
});

test("director3d 路由键覆盖 3d/blender/scene_3d", () => {
  assert.deepEqual(EXPERT_REGISTRY.director3d.taskTypes, ["3d", "blender", "scene_3d"]);
});

// ─────────────────────────────────────────── music 行 = 正式启用（Wave1 片B3）

test("music 行全部字段取自 music-director-persona 常量（零复制，防漂移同 director3d 先例）", () => {
  const def = EXPERT_REGISTRY.music;
  assert.ok(def, "music 必须注册");
  assert.equal(def.label, MUSIC_DIRECTOR_PERSONA_LABEL);
  assert.equal(def.description, MUSIC_DIRECTOR_PERSONA_DESCRIPTION);
  assert.deepEqual(def.toolIds, MUSIC_DIRECTOR_PERSONA_TOOL_IDS);
  assert.deepEqual(def.skillPaths, [MUSIC_DIRECTOR_PERSONA_SKILL_PATH, MUSIC_DIRECTOR_PERSONA_SKILL_FILES_PATH]);
  assert.equal(def.replyTokenCap, MUSIC_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP);
  assert.equal("provisioned" in def, false, "music 必须是启用行（Wave1 片B3 正式注册，不设 provisioned）");
});

test("music 交付契约：requiredFields = MUSIC_DELIVERABLES（import 不手抄）+ QC 签名必附", () => {
  const def = EXPERT_REGISTRY.music;
  assert.deepEqual(def.deliverableContract.requiredFields, MUSIC_DELIVERABLES);
  assert.deepEqual(def.deliverableContract.requiredFields, [
    "emotion_contract",
    "lyrics",
    "melody_notation",
    "audio_url",
    "duration_source",
    "qc",
  ]);
  assert.equal(def.deliverableContract.qcSignatureRequired, true);
});

test("music 路由键覆盖 music/song/bgm/mv_theme/theme_song", () => {
  assert.deepEqual(EXPERT_REGISTRY.music.taskTypes, ["music", "song", "bgm", "mv_theme", "theme_song"]);
});

test("注册表整体守卫：键=id、taskTypes 跨行不撞（首个非占位命中必须无歧义）", () => {
  // Wave2 收口后三域配方库待落库（persona 档头考古声明置空）：skillPaths 允许
  // 空阵列，但必须与 persona 常量同构（防漂移见下方激活行对帐测试）。
  // 2026-09-27：剪辑域配方库已落库（skills/editor/ 域根+六子配方）→ editor 自
  // 「待落库」集合移除；其余三域（video-director/screenwriter/critic）仍待补。
  const SKILL_PENDING_IDS = new Set(["video-director", "screenwriter", "critic"]);
  const seenTaskTypes = new Map<string, string>();
  for (const [key, def] of Object.entries(EXPERT_REGISTRY)) {
    assert.equal(key, def.id, `注册表键 ${key} 必须与 id 一致`);
    assert.ok(def.taskTypes.length > 0, `${key} 必须有路由键`);
    assert.ok(def.toolIds.length > 0, `${key} 必须有工具白名单`);
    if (def.provisioned) {
      // 占位行：skill 允许待补（[]，persona 片补）；启用行才强制配方库非空。
      assert.ok(Array.isArray(def.skillPaths), `${key} 占位行 skillPaths 须为阵列`);
    } else if (SKILL_PENDING_IDS.has(key)) {
      assert.deepEqual(def.skillPaths, [], `${key} 配方库待落库域 skillPaths 须为空阵列（skill 待补声明）`);
    } else {
      assert.ok(def.skillPaths.length > 0, `${key} 必须有配方库路径`);
    }
    assert.ok(def.replyTokenCap > 0, `${key} 必须有正数 token 帽`);
    for (const taskType of def.taskTypes) {
      assert.ok(
        !seenTaskTypes.has(taskType),
        `taskType "${taskType}" 在 ${seenTaskTypes.get(taskType)} 与 ${key} 重复`,
      );
      seenTaskTypes.set(taskType, key);
    }
  }
});

// ─────────────────────────────────────────── routeExpert：命中

test("routeExpert：精确命中 director3d（返回注册表同一物件）", () => {
  assert.equal(routeExpert("3d"), EXPERT_REGISTRY.director3d);
  assert.equal(routeExpert("blender"), EXPERT_REGISTRY.director3d);
  assert.equal(routeExpert("scene_3d"), EXPERT_REGISTRY.director3d);
});

test("routeExpert：边界前缀命中（blender_render 这类子型路由到域 Expert）", () => {
  assert.equal(routeExpert("blender_render"), EXPERT_REGISTRY.director3d);
  assert.equal(routeExpert("scene_3d_shot"), EXPERT_REGISTRY.director3d);
});

// ─────────────────────────────────────────── routeExpert：未命中与排除

test("routeExpert：无边界的相似词不误命中（前缀必须断在 -_./:）", () => {
  assert.equal(routeExpert("3dx"), null);
  assert.equal(routeExpert("musical"), null);
});

test("routeExpert：music 家族精确与子型命中激活行", () => {
  assert.equal(routeExpert("music"), EXPERT_REGISTRY.music);
  assert.equal(routeExpert("song"), EXPERT_REGISTRY.music);
  assert.equal(routeExpert("bgm"), EXPERT_REGISTRY.music);
  assert.equal(routeExpert("mv_theme"), EXPERT_REGISTRY.music);
  assert.equal(routeExpert("theme_song"), EXPERT_REGISTRY.music);
  assert.equal(routeExpert("music_track"), EXPERT_REGISTRY.music);
});

test("routeExpert：无占位行时 provisioned 排除逻辑仍覆盖（激活行不受影响 + readBeastMode 门禁语义不变）", () => {
  // Wave1 片B3 后注册表无 provisioned 行：readBeastMode 仍默认 OFF，
  // 激活行 routeExpert 直返（provisioned 排除分支对现有行为零影响）。
  assert.equal(readBeastMode({ beast_mode: true }), true);
  assert.equal(readBeastMode({}), false);
  assert.equal("provisioned" in EXPERT_REGISTRY.director3d, false);
  assert.equal("provisioned" in EXPERT_REGISTRY.music, false);
});

test("routeExpert：未知任务与空串返回 null（= 留在 Orchestrator 零变化）", () => {
  assert.equal(routeExpert("unknown_task"), null);
  assert.equal(routeExpert(""), null);
  assert.equal(routeExpert("   "), null);
});

// ─────────────────────────────────────────── assertExpertToolAccess：能力断路

test("assertExpertToolAccess：域内工具放行（blender 三件 + image_quote）", () => {
  assert.equal(assertExpertToolAccess("director3d", "blender_exec"), true);
  assert.equal(assertExpertToolAccess("director3d", "blender_render"), true);
  assert.equal(assertExpertToolAccess("director3d", "blender_export_gltf"), true);
  assert.equal(assertExpertToolAccess("director3d", "image_quote"), true);
});

test("assertExpertToolAccess：域外工具拒绝（能力断路）", () => {
  assert.equal(assertExpertToolAccess("director3d", "video_quote"), false);
  assert.equal(assertExpertToolAccess("director3d", "workflow_start"), false);
  assert.equal(assertExpertToolAccess("director3d", "music_gen"), false);
  assert.equal(assertExpertToolAccess("director3d", ""), false);
});

test("assertExpertToolAccess：music 域内工具放行（music_gen + image_quote）、域外拒绝", () => {
  assert.equal(assertExpertToolAccess("music", "music_gen"), true);
  assert.equal(assertExpertToolAccess("music", "image_quote"), true);
  assert.equal(assertExpertToolAccess("music", "blender_exec"), false);
  assert.equal(assertExpertToolAccess("music", "workflow_start"), false);
});

test("assertExpertToolAccess：未注册 expert 一律 false", () => {
  assert.equal(assertExpertToolAccess("nonexistent", "blender_exec"), false);
  assert.equal(assertExpertToolAccess("", "blender_exec"), false);
});

// ─────────────────────────────────────── Wave2 收口五域激活行（2026-09-08）

/** Wave2 收口五域激活行 id 清单（单一断言真源，勿在别处散抄）。 */
const WAVE2_ACTIVE_IDS = [
  "video-director",
  "editor",
  "screenwriter",
  "motion-director",
  "web3d-director",
] as const;

test("Wave2 五域激活行全部注册且不设 provisioned（正式启用可路由）", () => {
  for (const id of WAVE2_ACTIVE_IDS) {
    const def = EXPERT_REGISTRY[id];
    assert.ok(def, `${id} 必须注册`);
    assert.equal(def.id, id, `${id} 行 id 必须与键一致`);
    assert.equal("provisioned" in def, false, `${id} 必须是激活行（Wave2 收口翻正式，不设 provisioned）`);
    assert.equal(def.deliverableContract.qcSignatureRequired, true, `${id} QC 签名必附`);
    assert.ok(
      def.deliverableContract.requiredFields.includes("qc"),
      `${id} requiredFields 必含 "qc"`,
    );
    assert.ok(def.replyTokenCap > 0, `${id} 必须有正数 token 帽`);
  }
  assert.equal(EXPERT_REGISTRY["video-director"].label, "视频导演");
  assert.equal(EXPERT_REGISTRY["editor"].label, "剪辑师");
  assert.equal(EXPERT_REGISTRY["screenwriter"].label, "编剧分镜");
  assert.equal(EXPERT_REGISTRY["motion-director"].label, "动态设计");
  assert.equal(EXPERT_REGISTRY["web3d-director"].label, "Web3D 导演");
});

test("Wave2 五域激活行字段取自各 persona/delegate 常量（零复制，防漂移同 director3d/music 先例）", () => {
  const video = EXPERT_REGISTRY["video-director"];
  assert.equal(video.label, VIDEO_DIRECTOR_PERSONA_LABEL);
  assert.equal(video.description, VIDEO_DIRECTOR_PERSONA_DESCRIPTION);
  assert.deepEqual(video.toolIds, VIDEO_DIRECTOR_PERSONA_TOOL_IDS);
  assert.deepEqual(video.skillPaths, VIDEO_DIRECTOR_PERSONA_SKILL_PATHS);
  assert.deepEqual(video.deliverableContract.requiredFields, VIDEO_DELIVERABLES);
  assert.equal(video.replyTokenCap, VIDEO_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP);

  const editor = EXPERT_REGISTRY["editor"];
  assert.equal(editor.label, EDITOR_PERSONA_LABEL);
  assert.equal(editor.description, EDITOR_PERSONA_DESCRIPTION);
  assert.deepEqual(editor.toolIds, EDITOR_PERSONA_TOOL_IDS);
  assert.deepEqual(editor.skillPaths, EDITOR_PERSONA_SKILL_PATHS);
  assert.deepEqual(editor.deliverableContract.requiredFields, EDITOR_DELIVERABLES);
  assert.equal(editor.replyTokenCap, EDITOR_REPLY_SUMMARY_TOKEN_CAP);

  const screenwriter = EXPERT_REGISTRY["screenwriter"];
  assert.equal(screenwriter.label, SCREENWRITER_PERSONA_LABEL);
  assert.equal(screenwriter.description, SCREENWRITER_PERSONA_DESCRIPTION);
  assert.deepEqual(screenwriter.toolIds, SCREENWRITER_PERSONA_TOOL_IDS);
  assert.deepEqual(screenwriter.skillPaths, SCREENWRITER_PERSONA_SKILL_PATHS);
  assert.deepEqual(screenwriter.deliverableContract.requiredFields, SCREENWRITER_DELIVERABLES);
  assert.equal(screenwriter.replyTokenCap, SCREENWRITER_REPLY_SUMMARY_TOKEN_CAP);

  const motion = EXPERT_REGISTRY["motion-director"];
  assert.equal(motion.label, MOTION_DIRECTOR_PERSONA_LABEL);
  assert.equal(motion.description, MOTION_DIRECTOR_PERSONA_DESCRIPTION);
  assert.deepEqual(motion.toolIds, MOTION_DIRECTOR_PERSONA_TOOL_IDS);
  assert.deepEqual(motion.skillPaths, MOTION_DIRECTOR_PERSONA_SKILL_PATHS);
  assert.deepEqual(motion.deliverableContract.requiredFields, MOTION_DELIVERABLES);
  assert.equal(motion.replyTokenCap, MOTION_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP);

  const web3d = EXPERT_REGISTRY["web3d-director"];
  assert.equal(web3d.label, WEB3D_DIRECTOR_PERSONA_LABEL);
  assert.equal(web3d.description, WEB3D_DIRECTOR_PERSONA_DESCRIPTION);
  assert.deepEqual(web3d.toolIds, WEB3D_DIRECTOR_PERSONA_TOOL_IDS);
  assert.deepEqual(web3d.skillPaths, WEB3D_DIRECTOR_PERSONA_SKILL_PATHS);
  assert.deepEqual(web3d.deliverableContract.requiredFields, WEB3D_DELIVERABLES);
  assert.equal(web3d.replyTokenCap, WEB3D_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP);
});

test("routeExpert：五域 taskTypes 全部命中激活行（Wave2 收口翻正式可路由）", () => {
  for (const id of WAVE2_ACTIVE_IDS) {
    for (const taskType of EXPERT_REGISTRY[id].taskTypes) {
      assert.equal(routeExpert(taskType), EXPERT_REGISTRY[id], `激活行 taskType "${taskType}" 必须命中 ${id}`);
    }
  }
  // 激活行前缀子型同样命中（如 film_clip_x / three_js_scene）。
  assert.equal(routeExpert("film_clip_x"), EXPERT_REGISTRY["video-director"]);
  assert.equal(routeExpert("three_js_scene"), EXPERT_REGISTRY["web3d-director"]);
  // 既有两行启用不受影响。
  assert.equal(routeExpert("3d"), EXPERT_REGISTRY.director3d);
  assert.equal(routeExpert("music"), EXPERT_REGISTRY.music);
});

test("Wave2 五域 taskTypes 与既有 director3d/music 两行零重叠", () => {
  const activeTaskTypes = new Set<string>([
    ...EXPERT_REGISTRY.director3d.taskTypes,
    ...EXPERT_REGISTRY.music.taskTypes,
  ]);
  const seen = new Set<string>();
  for (const id of WAVE2_ACTIVE_IDS) {
    for (const taskType of EXPERT_REGISTRY[id].taskTypes) {
      assert.ok(!activeTaskTypes.has(taskType), `"${taskType}"（${id}）与启用行撞键`);
      assert.ok(!seen.has(taskType), `"${taskType}"（${id}）与其他激活行撞键`);
      seen.add(taskType);
    }
  }
});

test("Wave2 五域 toolIds 只收 harness 真源已注册工具（宁缺勿滥）", () => {
  for (const id of WAVE2_ACTIVE_IDS) {
    assert.ok(EXPERT_REGISTRY[id].toolIds.length > 0, `${id} 必须有工具白名单`);
    for (const toolId of EXPERT_REGISTRY[id].toolIds) {
      assert.ok(
        HARNESS_TOOL_IDS.has(toolId),
        `${id} 的工具 "${toolId}" 不在 harness-tool-registry 真源内`,
      );
    }
  }
});

test("Wave2 五域交付契约 requiredFields 逐行钉死", () => {
  assert.deepEqual(EXPERT_REGISTRY["video-director"].deliverableContract.requiredFields, [
    "shots",
    "duration_sec",
    "model_hint",
    "qc",
  ]);
  assert.deepEqual(EXPERT_REGISTRY["editor"].deliverableContract.requiredFields, [
    "timeline_ops",
    "duration_sec",
    "qc",
  ]);
  assert.deepEqual(EXPERT_REGISTRY["screenwriter"].deliverableContract.requiredFields, [
    "beats",
    "shotlist",
    "qc",
  ]);
  assert.deepEqual(EXPERT_REGISTRY["motion-director"].deliverableContract.requiredFields, [
    "motion_spec",
    "qc",
  ]);
  assert.deepEqual(EXPERT_REGISTRY["web3d-director"].deliverableContract.requiredFields, [
    "scene_spec",
    "bundle_ref",
    "qc",
  ]);
});

test("Wave2 五域 skillPaths 形状与 skill 考古结论一致", () => {
  // 无域 skill 目录 → []（行注释标「skill 待补」）。
  assert.deepEqual(EXPERT_REGISTRY["video-director"].skillPaths, []);
  // 2026-09-27 剪辑域配方库落库：skills/editor/ 域根 + 六子配方，逐条指真实档案
  // （存在性由 editor-timeline-activation.test.ts 逐条 fs 断言）。
  assert.ok(EXPERT_REGISTRY["editor"].skillPaths.length > 0, "editor 配方库已落库，不得为空");
  assert.deepEqual(EXPERT_REGISTRY["editor"].skillPaths, [...EDITOR_PERSONA_SKILL_PATHS]);
  assert.deepEqual(EXPERT_REGISTRY["screenwriter"].skillPaths, []);
  // skills/motion-design/ 无域根 SKILL.md → 指域目录（2026-09-07 配方库索引先例）。
  assert.deepEqual(EXPERT_REGISTRY["motion-director"].skillPaths, ["skills/motion-design/"]);
  assert.deepEqual(EXPERT_REGISTRY["web3d-director"].skillPaths, ["skills/web-3d-awwwards/SKILL.md"]);
});
