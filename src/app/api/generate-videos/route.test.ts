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
