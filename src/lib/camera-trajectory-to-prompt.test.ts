import test from "node:test";
import assert from "node:assert/strict";
import {
  CAMERA_MOVE_TO_PROMPT,
  describeCameraTrajectory,
  resolveSceneCameraRule,
  type CameraTrajectory,
} from "./camera-trajectory-to-prompt";
import { directVideoPrompt } from "./invisible-prompt-director";

// ───────────────────────────── 軌跡翻譯（seed-mapping §1.2 反向映射）

test("CAMERA_MOVE_TO_PROMPT 覆蓋 director-engine CAMERA_MOVES 全部 20 個 id", () => {
  // 與 src/lib/director-engine/cameraPresets.ts CAMERA_MOVES 對齊（現場真源 20 id）。
  assert.equal(Object.keys(CAMERA_MOVE_TO_PROMPT).length, 20);
  for (const id of ["dolly-in", "dolly-out", "pan", "tilt", "truck", "pedestal", "orbit", "follow", "handheld", "steadicam", "dollyzoom", "whippan", "crashzoom", "aerial", "lowangle", "overshoulder", "pov", "arc", "slowpush", "static"]) {
    assert.ok(CAMERA_MOVE_TO_PROMPT[id], `missing move id: ${id}`);
  }
});

test("L1 move id 翻譯成六槽 Camera 槽精確描述詞（含 Camera: 前綴）", () => {
  const out = describeCameraTrajectory({ moves: ["dolly-in"] });
  assert.match(out, /^Camera: /);
  assert.match(out, /slow dolly-in pushing toward the subject/);
  assert.match(out, /ending framed on the subject\.$/);
});

test("多 move 串接 + 焦距標注", () => {
  const out = describeCameraTrajectory({ moves: ["orbit", "slowpush"], focalLengthMm: 85 });
  assert.match(out, /orbit.*then.*push-in/);
  assert.match(out, /\(85mm lens\)/);
});

test("未知 move id 忽略；全未知回空串（不產生幻影指令）", () => {
  assert.equal(describeCameraTrajectory({ moves: ["not-a-move"] }), "");
  assert.equal(describeCameraTrajectory({ moves: ["not-a-move"], summary: "" }), "");
});

test("bpy keyframe 路徑：徑向收短 → 推近；拉遠 → 拉遠", () => {
  const pushIn = describeCameraTrajectory({
    keyframes: [
      { frame: 1, position: [6, 0, 2] },
      { frame: 90, position: [3, 0, 1.6] },
    ],
  });
  assert.match(pushIn, /pushing in toward the subject/);
  const pullBack = describeCameraTrajectory({
    keyframes: [
      { frame: 1, position: [2, 0, 1] },
      { frame: 90, position: [5, 0, 1.4] },
    ],
  });
  assert.match(pullBack, /pulling back from the subject/);
});

test("bpy keyframe 路徑：Z 主導 → 升降；大旋轉 → orbit；小旋轉 → pan", () => {
  const rise = describeCameraTrajectory({
    keyframes: [
      { frame: 1, position: [4, 0, 0.5] },
      { frame: 90, position: [4.1, 0, 3] },
    ],
  });
  assert.match(rise, /rising vertically upward/);
  const orbit = describeCameraTrajectory({
    keyframes: [
      { frame: 1, position: [4, 0, 1.5], rotationEulerDeg: [80, 0, 0] },
      { frame: 90, position: [4.2, 0.2, 1.5], rotationEulerDeg: [80, 0, 350] },
    ],
  });
  assert.match(orbit, /orbiting around the subject/);
  const pan = describeCameraTrajectory({
    keyframes: [
      { frame: 1, position: [4, 0, 1.5], rotationEulerDeg: [80, 0, 0] },
      { frame: 90, position: [4.1, 0.1, 1.5], rotationEulerDeg: [80, 0, 60] },
    ],
  });
  assert.match(pan, /panning right across the scene/);
});

test("summary 自由文本逐字保留", () => {
  const out = describeCameraTrajectory({ summary: "camera cranes over the alley wall" });
  assert.match(out, /camera cranes over the alley wall/);
});

// ───────────────────────────── sceneCard 感知規則（最小干預）

const TRAJECTORY: CameraTrajectory = { moves: ["dolly-in"], focalLengthMm: 50 };

test("無 camera 槽：軌跡翻譯詞注入 Camera 槽（取代通用中性指令）", () => {
  const rule = resolveSceneCameraRule(TRAJECTORY, "a runner crosses a bridge at dusk", false);
  assert.ok(rule);
  assert.match(rule.directive, /slow dolly-in/);
});

test("模糊鏡頭短語（dynamic shot）：軌跡翻譯詞覆蓋 camera 槽", () => {
  const rule = resolveSceneCameraRule(TRAJECTORY, "a dynamic shot of a runner", true);
  assert.ok(rule);
  assert.match(rule.directive, /slow dolly-in/);
});

test("用戶明示具體運鏡（dolly-in）：回 null 零干預（用戶明示為準）", () => {
  assert.equal(resolveSceneCameraRule(TRAJECTORY, "a dolly-in on a runner", true), null);
  assert.equal(resolveSceneCameraRule(TRAJECTORY, "static shot of a cat", true), null);
});

test("軌跡不可翻譯（空 moves）：回 null 不注入", () => {
  assert.equal(resolveSceneCameraRule({ moves: ["nope"] }, "a runner", false), null);
});

// ───────────────────────────── directVideoPrompt 接線（零行為變化回歸保護）

test("無 sceneCard：directVideoPrompt 輸出與既有行為逐字一致（camera 缺槽補通用指令）", () => {
  const plain = directVideoPrompt("a runner crosses a bridge at dusk");
  assert.match(plain, /Camera: motivated, steady, one deliberate move per shot\./);
  assert.doesNotMatch(plain, /slow dolly-in/);
});

test("無 sceneCard 選項與傳 undefined 完全等價", () => {
  const a = directVideoPrompt("a runner crosses a bridge at dusk", { modelId: "seedance-2.0", durationSeconds: 8 });
  const b = directVideoPrompt("a runner crosses a bridge at dusk", {
    modelId: "seedance-2.0",
    durationSeconds: 8,
    sceneCard: undefined,
    cameraTrajectory: undefined,
  });
  assert.equal(a, b);
});

test("sceneCard+trajectory 在場、無 camera 槽：Camera 槽被軌跡翻譯詞接管，其他槽不動", () => {
  const out = directVideoPrompt("a runner crosses a bridge at dusk", {
    sceneCard: {
      turntable_url: "https://x/t.mp4",
      stills_urls: ["https://x/s.png"],
      blend_path: "https://x/a.blend",
      glb_path: "https://x/a.glb",
      scene_summary: "s",
      duration_ms: 1000,
    },
    cameraTrajectory: TRAJECTORY,
  });
  assert.match(out, /Camera: slow dolly-in pushing toward the subject/);
  assert.doesNotMatch(out, /Camera: a single deliberate move/);
  // 其他槽不受影響：style/lighting 仍按原規則補齊
  assert.match(out, /Style: cinematic color grade/);
  assert.match(out, /Lighting: one motivated light source/);
});

test("sceneCard+trajectory 在場、模糊描述：軌跡翻譯詞覆蓋 camera 槽", () => {
  const out = directVideoPrompt("a dynamic shot of a runner on a rooftop", {
    sceneCard: {
      turntable_url: "https://x/t.mp4",
      stills_urls: ["https://x/s.png"],
      blend_path: "https://x/a.blend",
      glb_path: "https://x/a.glb",
      scene_summary: "s",
      duration_ms: 1000,
    },
    cameraTrajectory: TRAJECTORY,
  });
  assert.match(out, /Camera: slow dolly-in/);
});

test("sceneCard+trajectory 在場、用戶明示運鏡：輸出與無 sceneCard 逐字一致（零干預）", () => {
  const prompt = "a dolly-in on a runner crossing a bridge at dusk";
  const base = directVideoPrompt(prompt);
  const withScene = directVideoPrompt(prompt, {
    sceneCard: {
      turntable_url: "https://x/t.mp4",
      stills_urls: ["https://x/s.png"],
      blend_path: "https://x/a.blend",
      glb_path: "https://x/a.glb",
      scene_summary: "s",
      duration_ms: 1000,
    },
    cameraTrajectory: TRAJECTORY,
  });
  assert.equal(base, withScene);
});

test("只有 cameraTrajectory 沒有 sceneCard（或反之）：零行為變化", () => {
  const prompt = "a runner crosses a bridge at dusk";
  const base = directVideoPrompt(prompt);
  assert.equal(
    base,
    directVideoPrompt(prompt, { cameraTrajectory: TRAJECTORY }),
  );
  assert.equal(
    base,
    directVideoPrompt(prompt, {
      sceneCard: {
        turntable_url: "https://x/t.mp4",
        stills_urls: ["https://x/s.png"],
        blend_path: "https://x/a.blend",
        glb_path: "https://x/a.glb",
        scene_summary: "s",
        duration_ms: 1000,
      },
    }),
  );
});
