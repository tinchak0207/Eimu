import test from "node:test";
import assert from "node:assert/strict";
import { fuseSceneVideo, parseSceneCard, parseCameraTrajectory } from "./scene3d-video-fusion";
import { runShortDramaTool } from "./shortdrama-domain/index";

const FULL_SCENE_CARD = {
  turntable_url: "https://cdn.example.com/scene3d/turntable.mp4",
  stills_urls: [
    "https://cdn.example.com/scene3d/still-01.png",
    "https://cdn.example.com/scene3d/still-02.png",
    "https://cdn.example.com/scene3d/still-03.png",
  ],
  blend_path: "https://cdn.example.com/scene3d/scene.blend",
  glb_path: "https://cdn.example.com/scene3d/scene.glb",
  scene_summary: "荒漠驛站黃昏外景",
  duration_ms: 6000,
};

const CAPS_WITH_VIDEO = { videoGeneration: { provider: "image_tinchak" } };

test("fuseSceneVideo returns null when either side is missing (zero behavior change)", () => {
  assert.equal(fuseSceneVideo(FULL_SCENE_CARD, undefined), null);
  assert.equal(fuseSceneVideo(undefined, { moves: ["dolly-in"] }), null);
  assert.equal(fuseSceneVideo(null, null), null);
  assert.equal(fuseSceneVideo("card", "trajectory"), null);
});

test("fuseSceneVideo returns null on malformed shapes (dirty fields never block generation)", () => {
  assert.equal(fuseSceneVideo({ ...FULL_SCENE_CARD, stills_urls: "not-array" }, { moves: ["orbit"] }), null);
  assert.equal(fuseSceneVideo(FULL_SCENE_CARD, { moves: "not-array", summary: " " }), null);
  assert.equal(fuseSceneVideo({ stills_urls: [42] }, { summary: "slow push" }), null);
  assert.equal(fuseSceneVideo(FULL_SCENE_CARD, { moves: [] }), null);
  assert.equal(fuseSceneVideo(FULL_SCENE_CARD, {}), null);
});

test("fuseSceneVideo assembles references and camera directive from sceneZ contracts", () => {
  const fusion = fuseSceneVideo(FULL_SCENE_CARD, { moves: ["dolly-in", "orbit"], focalLengthMm: 35 });
  assert.ok(fusion);
  // references：previz 缺省檔 → composition role，cap 2（i2v 首/尾幀通道契約）
  assert.equal(fusion.frameCard.references.length, 2);
  assert.ok(fusion.frameCard.references.every((reference) => reference.referenceRole === "composition"));
  assert.ok(fusion.frameCard.compositionOnly);
  assert.ok(fusion.frameCard.referenceDirective.includes("composition and spatial layout only"));
  // Camera 詞：CAMERA_MOVE_TO_PROMPT 逐 id 翻譯 + 焦距尾巴
  assert.ok(fusion.cameraDirective.startsWith("Camera: "));
  assert.ok(fusion.cameraDirective.includes("slow dolly-in pushing toward the subject"));
  assert.ok(fusion.cameraDirective.includes("full 360-degree orbit"));
  assert.ok(fusion.cameraDirective.includes("35mm lens"));
  // DirectorOptions 直通對（契約：把 sceneCard/cameraTrajectory 傳進 DirectorOptions 即生效）
  assert.equal(fusion.sceneCard.scene_summary, FULL_SCENE_CARD.scene_summary);
  assert.deepEqual(fusion.cameraTrajectory.moves, ["dolly-in", "orbit"]);
});

test("parseCameraTrajectory accepts bpy keyframes and summary seeds", () => {
  const keyframes = parseCameraTrajectory({
    keyframes: [
      { frame: 0, position: [0, 0, 5] },
      { frame: 48, position: [0, 0, 2] },
    ],
  });
  assert.ok(keyframes);
  const fused = fuseSceneVideo(FULL_SCENE_CARD, keyframes);
  assert.ok(fused);
  assert.ok(fused.cameraDirective.includes("pushing in toward the subject"));
  const summary = parseCameraTrajectory({ summary: "slow lateral truck past the doorway" });
  assert.ok(summary);
  const fusedSummary = fuseSceneVideo(FULL_SCENE_CARD, summary);
  assert.ok(fusedSummary?.cameraDirective.includes("slow lateral truck past the doorway"));
});

test("last_frame_video_chain without the two optional fields has zero behavior change", () => {
  const bare = runShortDramaTool<Record<string, unknown>>(
    "last_frame_video_chain",
    { shots: [{ shotId: "S01-01", keyframeId: "kf-01", durationSeconds: 4 }] },
    CAPS_WITH_VIDEO,
  );
  assert.ok(bare.output && typeof bare.output === "object");
  assert.equal((bare.output as { sceneDirector?: unknown }).sceneDirector, undefined);
  // 髒欄（非 JSON 物件/形狀不合）＝缺欄：不阻斷、不出 sceneDirector
  const dirty = runShortDramaTool<Record<string, unknown>>(
    "last_frame_video_chain",
    { shots: [{ shotId: "S01-01", keyframeId: "kf-01", durationSeconds: 4 }], scene_card_ref: "not-json", camera_trajectory: 42 },
    CAPS_WITH_VIDEO,
  );
  assert.equal((dirty.output as { sceneDirector?: unknown }).sceneDirector, undefined);
});

test("last_frame_video_chain with scene_card_ref + camera_trajectory stitches sceneDirector into output", () => {
  const stitched = runShortDramaTool<{ chains: unknown[]; sceneDirector?: { cameraDirective: string; referenceDirective: string; references: Array<{ referenceRole: string }>; notes: string[] } }>(
    "last_frame_video_chain",
    {
      shots: [{ shotId: "S01-01", keyframeId: "kf-01", durationSeconds: 4 }],
      scene_card_ref: FULL_SCENE_CARD,
      camera_trajectory: { moves: ["aerial"] },
    },
    CAPS_WITH_VIDEO,
  );
  assert.ok(stitched.output.sceneDirector);
  assert.ok(stitched.output.sceneDirector.cameraDirective.startsWith("Camera: "));
  assert.ok(stitched.output.sceneDirector.cameraDirective.includes("aerial drone descent"));
  assert.ok(stitched.output.sceneDirector.referenceDirective.length > 0);
  assert.equal(stitched.output.sceneDirector.references.length, 2);
  assert.ok(stitched.output.sceneDirector.references.every((reference) => reference.referenceRole === "composition"));
  assert.ok(Array.isArray(stitched.output.sceneDirector.notes));
  // 既有 chains 結構不動
  assert.equal(stitched.output.chains.length, 1);
});
