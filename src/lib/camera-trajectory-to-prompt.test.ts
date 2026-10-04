import test from "node:test";
import assert from "node:assert/strict";
import {
  CAMERA_MOVE_TO_PROMPT,
  describeCameraTrajectory,
  resolveSceneCameraRule,
  type CameraTrajectory,
} from "./camera-trajectory-to-prompt";
import { directVideoPrompt } from "./invisible-prompt-director";

// ───────────────────────────── 轨迹翻译（seed-mapping §1.2 反向映射）

test("CAMERA_MOVE_TO_PROMPT 覆盖 director-engine CAMERA_MOVES 全部 20 个 id", () => {
  // 与 src/lib/director-engine/cameraPresets.ts CAMERA_MOVES 对齐（现场真源 20 id）。
  assert.equal(Object.keys(CAMERA_MOVE_TO_PROMPT).length, 20);
  for (const id of ["dolly-in", "dolly-out", "pan", "tilt", "truck", "pedestal", "orbit", "follow", "handheld", "steadicam", "dollyzoom", "whippan", "crashzoom", "aerial", "lowangle", "overshoulder", "pov", "arc", "slowpush", "static"]) {
    assert.ok(CAMERA_MOVE_TO_PROMPT[id], `missing move id: ${id}`);
  }
});

test("L1 move id 翻译成六槽 Camera 槽精确描述词（含 Camera: 前缀）", () => {
  const out = describeCameraTrajectory({ moves: ["dolly-in"] });
  assert.match(out, /^Camera: /);
  assert.match(out, /slow dolly-in pushing toward the subject/);
  assert.match(out, /ending framed on the subject\.$/);
});

test("多 move 串接 + 焦距标注", () => {
  const out = describeCameraTrajectory({ moves: ["orbit", "slowpush"], focalLengthMm: 85 });
  assert.match(out, /orbit.*then.*push-in/);
  assert.match(out, /\(85mm lens\)/);
});

test("未知 move id 忽略；全未知回空串（不产生幻影指令）", () => {
  assert.equal(describeCameraTrajectory({ moves: ["not-a-move"] }), "");
  assert.equal(describeCameraTrajectory({ moves: ["not-a-move"], summary: "" }), "");
});

test("bpy keyframe 路径：径向收短 → 推近；拉远 → 拉远", () => {
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

test("bpy keyframe 路径：Z 主导 → 升降；大旋转 → orbit；小旋转 → pan", () => {
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

// ───────────────────────────── sceneCard 感知规则（最小干预）

const TRAJECTORY: CameraTrajectory = { moves: ["dolly-in"], focalLengthMm: 50 };

test("无 camera 槽：轨迹翻译词注入 Camera 槽（取代通用中性指令）", () => {
  const rule = resolveSceneCameraRule(TRAJECTORY, "a runner crosses a bridge at dusk", false);
  assert.ok(rule);
  assert.match(rule.directive, /slow dolly-in/);
});

test("模糊镜头短语（dynamic shot）：轨迹翻译词覆盖 camera 槽", () => {
  const rule = resolveSceneCameraRule(TRAJECTORY, "a dynamic shot of a runner", true);
  assert.ok(rule);
  assert.match(rule.directive, /slow dolly-in/);
});

test("用户明示具体运镜（dolly-in）：回 null 零干预（用户明示为准）", () => {
  assert.equal(resolveSceneCameraRule(TRAJECTORY, "a dolly-in on a runner", true), null);
  assert.equal(resolveSceneCameraRule(TRAJECTORY, "static shot of a cat", true), null);
});

test("轨迹不可翻译（空 moves）：回 null 不注入", () => {
  assert.equal(resolveSceneCameraRule({ moves: ["nope"] }, "a runner", false), null);
});

// ───────────────────────────── directVideoPrompt 接线（零行为变化回归保护）

test("无 sceneCard：directVideoPrompt 输出与既有行为逐字一致（camera 缺槽补通用指令）", () => {
  const plain = directVideoPrompt("a runner crosses a bridge at dusk");
  assert.match(plain, /Camera: motivated, steady, one deliberate move per shot\./);
  assert.doesNotMatch(plain, /slow dolly-in/);
});

test("无 sceneCard 选项与传 undefined 完全等价", () => {
  const a = directVideoPrompt("a runner crosses a bridge at dusk", { modelId: "seedance-2.0", durationSeconds: 8 });
  const b = directVideoPrompt("a runner crosses a bridge at dusk", {
    modelId: "seedance-2.0",
    durationSeconds: 8,
    sceneCard: undefined,
    cameraTrajectory: undefined,
  });
  assert.equal(a, b);
});

test("sceneCard+trajectory 在场、无 camera 槽：Camera 槽被轨迹翻译词接管，其他槽不动", () => {
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
  // 其他槽不受影响：style/lighting 仍按原规则补齐
  assert.match(out, /Style: cinematic color grade/);
  assert.match(out, /Lighting: one motivated light source/);
});

test("sceneCard+trajectory 在场、模糊描述：轨迹翻译词覆盖 camera 槽", () => {
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

test("sceneCard+trajectory 在场、用户明示运镜：输出与无 sceneCard 逐字一致（零干预）", () => {
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

test("只有 cameraTrajectory 没有 sceneCard（或反之）：零行为变化", () => {
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
