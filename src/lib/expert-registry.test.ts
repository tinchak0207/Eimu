/**
 * Expert 註冊表測試守衛（MOE 改革波 0-A，2026-09-08）。
 * 跑法（package.json 現有 test 跑法定向執行本檔）：
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

// ─────────────────────────────────────────── readBeastMode（默認 OFF）

test("beast_mode 設定鍵名釘死", () => {
  assert.equal(BEAST_MODE_SETTINGS_KEY, "beast_mode");
});

test("readBeastMode：布林 true 開、布林 false 關", () => {
  assert.equal(readBeastMode({ beast_mode: true }), true);
  assert.equal(readBeastMode({ beast_mode: false }), false);
});

test("readBeastMode：缺欄位 = false（默認 OFF，零遷移）", () => {
  assert.equal(readBeastMode({}), false);
  assert.equal(readBeastMode({ other_key: true }), false);
});

test("readBeastMode：非布林值一律 false（字串/數字冒充不生效）", () => {
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

// ─────────────────────────────────────────── director3d 行 = persona 輪子常量

test("director3d 行全部字段取自 blender-director-persona 常量（零複製）", () => {
  const def = EXPERT_REGISTRY.director3d;
  assert.ok(def, "director3d 必須註冊");
  assert.equal(def.label, DIRECTOR_PERSONA_LABEL);
  assert.equal(def.description, DIRECTOR_PERSONA_DESCRIPTION);
  assert.deepEqual(def.toolIds, DIRECTOR_PERSONA_TOOL_IDS);
  assert.deepEqual(def.skillPaths, [DIRECTOR_PERSONA_SKILL_PATH]);
  assert.equal(def.replyTokenCap, DIRECTOR_REPLY_SUMMARY_TOKEN_CAP);
  assert.equal("provisioned" in def, false, "director3d 必須是啟用行（不設 provisioned）");
});

test("director3d 交付契約：requiredFields = BLENDER_DELIVERABLES（import 不手抄）+ QC 簽名必附", () => {
  const def = EXPERT_REGISTRY.director3d;
  assert.deepEqual(def.deliverableContract.requiredFields, BLENDER_DELIVERABLES);
  assert.equal(def.deliverableContract.qcSignatureRequired, true);
});

test("director3d 路由鍵覆蓋 3d/blender/scene_3d", () => {
  assert.deepEqual(EXPERT_REGISTRY.director3d.taskTypes, ["3d", "blender", "scene_3d"]);
});

// ─────────────────────────────────────────── music 行 = 正式啟用（Wave1 片B3）

test("music 行全部字段取自 music-director-persona 常量（零複製，防漂移同 director3d 先例）", () => {
  const def = EXPERT_REGISTRY.music;
  assert.ok(def, "music 必須註冊");
  assert.equal(def.label, MUSIC_DIRECTOR_PERSONA_LABEL);
  assert.equal(def.description, MUSIC_DIRECTOR_PERSONA_DESCRIPTION);
  assert.deepEqual(def.toolIds, MUSIC_DIRECTOR_PERSONA_TOOL_IDS);
  assert.deepEqual(def.skillPaths, [MUSIC_DIRECTOR_PERSONA_SKILL_PATH, MUSIC_DIRECTOR_PERSONA_SKILL_FILES_PATH]);
  assert.equal(def.replyTokenCap, MUSIC_DIRECTOR_REPLY_SUMMARY_TOKEN_CAP);
  assert.equal("provisioned" in def, false, "music 必須是啟用行（Wave1 片B3 正式註冊，不設 provisioned）");
});

test("music 交付契約：requiredFields = MUSIC_DELIVERABLES（import 不手抄）+ QC 簽名必附", () => {
  const def = EXPERT_REGISTRY.music;
  assert.deepEqual(def.deliverableContract.requiredFields, MUSIC_DELIVERABLES);
  assert.deepEqual(def.deliverableContract.requiredFields, [
    "emotion_contract",
    "lyrics",
    "audio_url",
    "duration_source",
    "qc",
  ]);
  assert.equal(def.deliverableContract.qcSignatureRequired, true);
});

test("music 路由鍵覆蓋 music/song/bgm/mv_theme/theme_song", () => {
  assert.deepEqual(EXPERT_REGISTRY.music.taskTypes, ["music", "song", "bgm", "mv_theme", "theme_song"]);
});

test("註冊表整體守衛：鍵=id、taskTypes 跨行不撞（首個非佔位命中必須無歧義）", () => {
  // Wave2 收口後三域配方庫待落庫（persona 檔頭考古聲明置空）：skillPaths 允許
  // 空陣列，但必須與 persona 常量同構（防漂移見下方激活行對帳測試）。
  const SKILL_PENDING_IDS = new Set(["video-director", "editor", "screenwriter"]);
  const seenTaskTypes = new Map<string, string>();
  for (const [key, def] of Object.entries(EXPERT_REGISTRY)) {
    assert.equal(key, def.id, `註冊表鍵 ${key} 必須與 id 一致`);
    assert.ok(def.taskTypes.length > 0, `${key} 必須有路由鍵`);
    assert.ok(def.toolIds.length > 0, `${key} 必須有工具白名單`);
    if (def.provisioned) {
      // 佔位行：skill 允許待補（[]，persona 片補）；啟用行才強制配方庫非空。
      assert.ok(Array.isArray(def.skillPaths), `${key} 佔位行 skillPaths 須為陣列`);
    } else if (SKILL_PENDING_IDS.has(key)) {
      assert.deepEqual(def.skillPaths, [], `${key} 配方庫待落庫域 skillPaths 須為空陣列（skill 待補聲明）`);
    } else {
      assert.ok(def.skillPaths.length > 0, `${key} 必須有配方庫路徑`);
    }
    assert.ok(def.replyTokenCap > 0, `${key} 必須有正數 token 帽`);
    for (const taskType of def.taskTypes) {
      assert.ok(
        !seenTaskTypes.has(taskType),
        `taskType "${taskType}" 在 ${seenTaskTypes.get(taskType)} 與 ${key} 重複`,
      );
      seenTaskTypes.set(taskType, key);
    }
  }
});

// ─────────────────────────────────────────── routeExpert：命中

test("routeExpert：精確命中 director3d（返回註冊表同一物件）", () => {
  assert.equal(routeExpert("3d"), EXPERT_REGISTRY.director3d);
  assert.equal(routeExpert("blender"), EXPERT_REGISTRY.director3d);
  assert.equal(routeExpert("scene_3d"), EXPERT_REGISTRY.director3d);
});

test("routeExpert：邊界前綴命中（blender_render 這類子型路由到域 Expert）", () => {
  assert.equal(routeExpert("blender_render"), EXPERT_REGISTRY.director3d);
  assert.equal(routeExpert("scene_3d_shot"), EXPERT_REGISTRY.director3d);
});

// ─────────────────────────────────────────── routeExpert：未命中與排除

test("routeExpert：無邊界的相似詞不誤命中（前綴必須斷在 -_./:）", () => {
  assert.equal(routeExpert("3dx"), null);
  assert.equal(routeExpert("musical"), null);
});

test("routeExpert：music 家族精確與子型命中激活行", () => {
  assert.equal(routeExpert("music"), EXPERT_REGISTRY.music);
  assert.equal(routeExpert("song"), EXPERT_REGISTRY.music);
  assert.equal(routeExpert("bgm"), EXPERT_REGISTRY.music);
  assert.equal(routeExpert("mv_theme"), EXPERT_REGISTRY.music);
  assert.equal(routeExpert("theme_song"), EXPERT_REGISTRY.music);
  assert.equal(routeExpert("music_track"), EXPERT_REGISTRY.music);
});

test("routeExpert：無佔位行時 provisioned 排除邏輯仍覆蓋（激活行不受影響 + readBeastMode 門禁語義不變）", () => {
  // Wave1 片B3 後註冊表無 provisioned 行：readBeastMode 仍默認 OFF，
  // 激活行 routeExpert 直返（provisioned 排除分支對現有行為零影響）。
  assert.equal(readBeastMode({ beast_mode: true }), true);
  assert.equal(readBeastMode({}), false);
  assert.equal("provisioned" in EXPERT_REGISTRY.director3d, false);
  assert.equal("provisioned" in EXPERT_REGISTRY.music, false);
});

test("routeExpert：未知任務與空串返回 null（= 留在 Orchestrator 零變化）", () => {
  assert.equal(routeExpert("unknown_task"), null);
  assert.equal(routeExpert(""), null);
  assert.equal(routeExpert("   "), null);
});

// ─────────────────────────────────────────── assertExpertToolAccess：能力斷路

test("assertExpertToolAccess：域內工具放行（blender 三件 + image_quote）", () => {
  assert.equal(assertExpertToolAccess("director3d", "blender_exec"), true);
  assert.equal(assertExpertToolAccess("director3d", "blender_render"), true);
  assert.equal(assertExpertToolAccess("director3d", "blender_export_gltf"), true);
  assert.equal(assertExpertToolAccess("director3d", "image_quote"), true);
});

test("assertExpertToolAccess：域外工具拒絕（能力斷路）", () => {
  assert.equal(assertExpertToolAccess("director3d", "video_quote"), false);
  assert.equal(assertExpertToolAccess("director3d", "workflow_start"), false);
  assert.equal(assertExpertToolAccess("director3d", "music_gen"), false);
  assert.equal(assertExpertToolAccess("director3d", ""), false);
});

test("assertExpertToolAccess：music 域內工具放行（music_gen + image_quote）、域外拒絕", () => {
  assert.equal(assertExpertToolAccess("music", "music_gen"), true);
  assert.equal(assertExpertToolAccess("music", "image_quote"), true);
  assert.equal(assertExpertToolAccess("music", "blender_exec"), false);
  assert.equal(assertExpertToolAccess("music", "workflow_start"), false);
});

test("assertExpertToolAccess：未註冊 expert 一律 false", () => {
  assert.equal(assertExpertToolAccess("nonexistent", "blender_exec"), false);
  assert.equal(assertExpertToolAccess("", "blender_exec"), false);
});

// ─────────────────────────────────────── Wave2 收口五域激活行（2026-09-08）

/** Wave2 收口五域激活行 id 清單（單一斷言真源，勿在別處散抄）。 */
const WAVE2_ACTIVE_IDS = [
  "video-director",
  "editor",
  "screenwriter",
  "motion-director",
  "web3d-director",
] as const;

test("Wave2 五域激活行全部註冊且不設 provisioned（正式啟用可路由）", () => {
  for (const id of WAVE2_ACTIVE_IDS) {
    const def = EXPERT_REGISTRY[id];
    assert.ok(def, `${id} 必須註冊`);
    assert.equal(def.id, id, `${id} 行 id 必須與鍵一致`);
    assert.equal("provisioned" in def, false, `${id} 必須是激活行（Wave2 收口翻正式，不設 provisioned）`);
    assert.equal(def.deliverableContract.qcSignatureRequired, true, `${id} QC 簽名必附`);
    assert.ok(
      def.deliverableContract.requiredFields.includes("qc"),
      `${id} requiredFields 必含 "qc"`,
    );
    assert.ok(def.replyTokenCap > 0, `${id} 必須有正數 token 帽`);
  }
  assert.equal(EXPERT_REGISTRY["video-director"].label, "视频导演");
  assert.equal(EXPERT_REGISTRY["editor"].label, "剪辑师");
  assert.equal(EXPERT_REGISTRY["screenwriter"].label, "编剧分镜");
  assert.equal(EXPERT_REGISTRY["motion-director"].label, "动态设计");
  assert.equal(EXPERT_REGISTRY["web3d-director"].label, "Web3D 导演");
});

test("Wave2 五域激活行字段取自各 persona/delegate 常量（零複製，防漂移同 director3d/music 先例）", () => {
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
      assert.equal(routeExpert(taskType), EXPERT_REGISTRY[id], `激活行 taskType "${taskType}" 必須命中 ${id}`);
    }
  }
  // 激活行前綴子型同樣命中（如 film_clip_x / three_js_scene）。
  assert.equal(routeExpert("film_clip_x"), EXPERT_REGISTRY["video-director"]);
  assert.equal(routeExpert("three_js_scene"), EXPERT_REGISTRY["web3d-director"]);
  // 既有兩行啟用不受影響。
  assert.equal(routeExpert("3d"), EXPERT_REGISTRY.director3d);
  assert.equal(routeExpert("music"), EXPERT_REGISTRY.music);
});

test("Wave2 五域 taskTypes 與既有 director3d/music 兩行零重疊", () => {
  const activeTaskTypes = new Set<string>([
    ...EXPERT_REGISTRY.director3d.taskTypes,
    ...EXPERT_REGISTRY.music.taskTypes,
  ]);
  const seen = new Set<string>();
  for (const id of WAVE2_ACTIVE_IDS) {
    for (const taskType of EXPERT_REGISTRY[id].taskTypes) {
      assert.ok(!activeTaskTypes.has(taskType), `"${taskType}"（${id}）與啟用行撞鍵`);
      assert.ok(!seen.has(taskType), `"${taskType}"（${id}）與其他激活行撞鍵`);
      seen.add(taskType);
    }
  }
});

test("Wave2 五域 toolIds 只收 harness 真源已註冊工具（寧缺勿濫）", () => {
  for (const id of WAVE2_ACTIVE_IDS) {
    assert.ok(EXPERT_REGISTRY[id].toolIds.length > 0, `${id} 必須有工具白名單`);
    for (const toolId of EXPERT_REGISTRY[id].toolIds) {
      assert.ok(
        HARNESS_TOOL_IDS.has(toolId),
        `${id} 的工具 "${toolId}" 不在 harness-tool-registry 真源內`,
      );
    }
  }
});

test("Wave2 五域交付契約 requiredFields 逐行釘死", () => {
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

test("Wave2 五域 skillPaths 形狀與 skill 考古結論一致", () => {
  // 無域 skill 目錄 → []（行註釋標「skill 待補」）。
  assert.deepEqual(EXPERT_REGISTRY["video-director"].skillPaths, []);
  assert.deepEqual(EXPERT_REGISTRY["editor"].skillPaths, []);
  assert.deepEqual(EXPERT_REGISTRY["screenwriter"].skillPaths, []);
  // skills/motion-design/ 無域根 SKILL.md → 指域目錄（2026-09-07 配方庫索引先例）。
  assert.deepEqual(EXPERT_REGISTRY["motion-director"].skillPaths, ["skills/motion-design/"]);
  assert.deepEqual(EXPERT_REGISTRY["web3d-director"].skillPaths, ["skills/web-3d-awwwards/SKILL.md"]);
});
