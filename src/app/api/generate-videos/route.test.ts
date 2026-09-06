import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src/app/api/generate-videos/route.ts"), "utf8");

test("video generation uses a dedicated Adobe2API chat-completions protocol", () => {
  assert.match(source, /isSupportedVideoModel/);
  assert.match(source, /resolveAdobe2ApiVideoModelId/);
  assert.match(source, /\/chat\/completions/);
  assert.match(source, /<video\[\^>\]\+src=/);
  assert.match(source, /mediaType: "video"/);
  assert.match(source, /videoUrl: result\.videoUrl/);
});

test("video generation stays within the Vercel hobby execution ceiling", () => {
  assert.match(source, /export const maxDuration = 300/);
  assert.match(source, /VIDEO_UPSTREAM_BUDGET_MS = 285_000/);
  assert.match(source, /VIDEO_UPSTREAM_TIMEOUT_MS = 275_000/);
});

test("video generation prices and reserves quota from model, resolution, and duration", () => {
  assert.match(source, /generationCoins\(modelId, \{[\s\S]{0,160}generateAudio/);
  assert.match(source, /requiredCoins \* QUOTA_PER_COIN/);
  assert.match(source, /reserveImageQuota/);
  assert.match(source, /refundImageQuota/);
  assert.match(source, /if \(quotaReserved && !delivered\)/);
});

test("video generation shares the production routing registry and breaker", () => {
  assert.match(source, /buildModelQueue\(modelId, process\.env, pools, overrides\)/);
  assert.match(source, /prioritizeHealthyEndpoints/);
  assert.match(source, /recordEndpointSuccess/);
  assert.match(source, /recordEndpointFailure/);
  assert.match(source, /recordRoutingEvent/);
});

test("video generation accepts text, image references, aspect ratio, resolution, duration, and audio", () => {
  assert.match(source, /form\.get\("aspectRatio"\)/);
  assert.match(source, /form\.get\("outputResolution"\)/);
  assert.match(source, /form\.get\("durationSeconds"\)/);
  assert.match(source, /form\.get\("generateAudio"\)/);
  assert.match(source, /form\s*\.getAll\("referenceImages"\)/);
  assert.match(source, /data:\$\{image\.type \|\| "image\/png"\};base64,/);
  assert.match(source, /generate_audio: generateAudio/);
});

// ── 3D 場景卡嵌合（片AC，2026-09-06）─────────────────────────────────────

test("video generation threads optional scene_card and camera_trajectory into DirectorOptions (missing fields = zero change)", () => {
  // JSON body 可選欄（snake_case 讀取）
  assert.match(source, /optionalObject\(body\.scene_card\)/);
  assert.match(source, /optionalObject\(body\.camera_trajectory\)/);
  // 融合層短路：fuseSceneVideo 回 null（缺欄/髒欄）時不展開任何 DirectorOptions 欄
  assert.match(source, /fuseSceneVideo\(parsed\.sceneCard, parsed\.cameraTrajectory\)/);
  assert.match(source, /sceneCard: sceneVideoFusion\.sceneCard, cameraTrajectory: sceneVideoFusion\.cameraTrajectory/);
  // 帶欄生效：data URL 參考幀轉 File 進 multipart 圖位（cap 2、不頂用戶上傳位）
  assert.match(source, /2 - referenceFiles\.length/);
  assert.match(source, /referenceFiles\.push\(\.\.\.files\)/);
  // 上游調用吃融合後的參考檔（缺欄時 = 原 parsed.referenceImages 逐字同）
  assert.match(source, /referenceFiles,/);
});
