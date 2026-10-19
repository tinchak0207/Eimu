import assert from "node:assert/strict";
import test from "node:test";

import {
  SHORTDRAMA_TOOL_IDS,
  getShortDramaToolDefinitions,
  runShortDramaTool,
  type ShortDramaToolId,
} from "./index";

test("shortdrama registry exposes every production stage with explicit contracts", () => {
  const definitions = getShortDramaToolDefinitions();
  assert.deepEqual(definitions.map((definition) => definition.id), SHORTDRAMA_TOOL_IDS);

  for (const definition of definitions) {
    assert.ok(definition.input, `${definition.id} input contract`);
    assert.ok(definition.output, `${definition.id} output contract`);
    assert.ok(definition.gates.length > 0, `${definition.id} gates`);
    assert.ok(definition.unsupported.length > 0, `${definition.id} unsupported contract`);
    assert.ok(definition.canvas.nodeType, `${definition.id} canvas node type`);
    assert.equal(definition.canvas.workflowId, "shortdrama-production");
  }
});

test("local script parsing returns a canvas-capturable structured scene artifact", () => {
  const result = runShortDramaTool("script_scene_parse", {
    script: "场1 夜 内景\n小雨：你来了。\n动作：她放下伞。\n阿明：我一直在等你。",
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.canvas.workflowId, "shortdrama-production");
  assert.equal(result.canvas.tool, "script_scene_parse");
  assert.equal(result.canvas.artifactKind, "script-scene");
  assert.equal(result.canvas.status, "succeeded");
  assert.ok(result.canvas.artifactId.startsWith("script_scene_parse-"));
  assert.equal(result.output.scenes.length, 1);
  assert.equal(result.output.scenes[0]?.beats[0]?.type, "dialogue");
});

test("cast lock resolves reusable assets and editing manifest stays explicit about its engine", () => {
  const cast = runShortDramaTool("cast_asset_lock", {
    assets: [
      { id: "C01", kind: "character", name: "小雨", appearancePrompt: "短发，黄色雨衣" },
      { id: "P01", kind: "scene", name: "门口", referenceUri: "https://assets.example/door.png" },
    ],
    requiredIds: ["C01", "P01"],
  });
  assert.equal(cast.status, "succeeded");
  assert.deepEqual(cast.output.locks.map((asset) => asset.id), ["C01", "P01"]);
  assert.deepEqual(cast.output.missingIds, []);

  const manifest = runShortDramaTool("editing_manifest", {
    engine: "ffmpeg",
    clips: [{ shotId: "S01-01", uri: "https://assets.example/clip.mp4", durationSeconds: 4 }],
  });
  assert.equal(manifest.status, "succeeded");
  assert.equal(manifest.output.engine, "ffmpeg");
  assert.ok(manifest.output.manifestId.startsWith("editing_manifest-"));
});

test("missing rendering upstream is unsupported rather than a fake success", () => {
  const result = runShortDramaTool("keyframe_render", {
    shots: [{ shotId: "S01-01", prompt: "雨夜门口，小雨回头", durationSeconds: 4 }],
  });

  assert.equal(result.status, "unsupported");
  assert.equal(result.unsupported?.code, "image_generation_upstream_missing");
  assert.notEqual(result.status, "succeeded");
  assert.equal(result.canvas.status, "unsupported");
});

test("storyboard qc reports all 17 deterministic gates", () => {
  const result = runShortDramaTool("storyboard_qc_17", {
    shots: [
      {
        shotId: "S01-01",
        sceneId: "S01",
        order: 1,
        prompt: "雨夜门口，小雨回头",
        characterCardIds: ["C01"],
        sceneCardIds: ["P01"],
        durationSeconds: 30,
        keyframeId: "kf-01",
        lastFrameId: "lf-01",
        audioAnchorId: "a-01",
        aspectRatio: "9:16",
      },
    ],
    lockedCharacterCardIds: ["C01"],
    lockedSceneCardIds: ["P01"],
    segmentDurationSeconds: 80,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.output.gates.length, 17);
  assert.equal(result.output.gates.every((gate) => gate.passed), true);
});

test("storyboard qc duration bounds allow full 30s clips and reject beyond 30s", () => {
  const base = {
    sceneId: "S01",
    prompt: "长镜头",
    characterCardIds: ["C01"],
    sceneCardIds: ["P01"],
    keyframeId: "kf-01",
    lastFrameId: "lf-01",
    audioAnchorId: "a-01",
    aspectRatio: "9:16",
  };
  const run = (durationSeconds: number) =>
    runShortDramaTool("storyboard_qc_17", {
      shots: [{ shotId: "S01-01", order: 1, ...base, durationSeconds }],
      lockedCharacterCardIds: ["C01"],
      lockedSceneCardIds: ["P01"],
      segmentDurationSeconds: 30,
    });

  const over = run(31);
  const bounds = over.output.gates.find((gate) => gate.id === "duration_bounds");
  assert.equal(bounds?.passed, false);
  const segment = over.output.gates.find((gate) => gate.id === "segment_duration");
  assert.equal(segment?.passed, true);

  // H7：<10s 短档判 fail 且文案点名镜号与秒数；10/30 边界通过。
  for (const d of [2, 4, 9, 9.9]) {
    const r = run(d).output.gates.find((gate) => gate.id === "duration_bounds");
    assert.equal(r?.passed, false, `${d}s must fail`);
    assert.match(r?.detail ?? "", /S01-01\(/);
    assert.match(r?.detail ?? "", /<10/);
  }
  for (const d of [10, 15, 30]) {
    assert.equal(run(d).output.gates.find((gate) => gate.id === "duration_bounds")?.passed, true, `${d}s must pass`);
  }
});

test("video, audio, editing, and delivery tools preserve upstream boundaries", () => {
  const cases: Array<[ShortDramaToolId, Record<string, unknown>, string]> = [
    ["audio_first_timeline", { dialogue: [{ id: "d1", text: "你好" }] }, "audio_generation_upstream_missing"],
    ["last_frame_video_chain", { shots: [{ shotId: "S01-01", keyframeId: "kf-01", durationSeconds: 4 }] }, "video_generation_upstream_missing"],
    ["editing_manifest", { clips: [{ shotId: "S01-01", uri: "clip.mp4", durationSeconds: 4 }] }, "editing_engine_missing"],
  ];

  for (const [tool, input, code] of cases) {
    const result = runShortDramaTool(tool, input);
    assert.equal(result.status, "unsupported", tool);
    assert.equal(result.unsupported?.code, code, tool);
    assert.equal(result.canvas.status, "unsupported", tool);
  }

  const delivery = runShortDramaTool("delivery_assets", { assets: [] });
  assert.equal(delivery.status, "blocked");
  assert.equal(delivery.gates.some((gate) => !gate.passed), true);
  assert.equal(delivery.canvas.status, "blocked");
});

test("audio-first and last-frame chain emit deterministic references when capabilities exist", () => {
  const audio = runShortDramaTool(
    "audio_first_timeline",
    { dialogue: [{ id: "d1", text: "你好", speaker: "小雨" }] },
    { audioGeneration: { provider: "local-tts" } },
  );
  assert.equal(audio.status, "succeeded");
  assert.equal(audio.output.tracks[0]?.anchorId, "d1");

  const video = runShortDramaTool(
    "last_frame_video_chain",
    {
      shots: [
        { shotId: "S01-01", keyframeId: "kf-01", lastFrameId: "lf-01", durationSeconds: 4 },
        { shotId: "S01-02", keyframeId: "kf-02", lastFrameId: "lf-02", durationSeconds: 4 },
      ],
    },
    { videoGeneration: { provider: "video-upstream" } },
  );
  assert.equal(video.status, "succeeded");
  assert.equal(video.output.chains[0]?.inputLastFrameId, "kf-01");
  assert.equal(video.output.chains[0]?.nextShotId, "S01-02");
  assert.equal(video.output.chains[1]?.inputLastFrameId, "lf-01");
  assert.equal(video.output.chains[1]?.nextShotId, undefined);
});
