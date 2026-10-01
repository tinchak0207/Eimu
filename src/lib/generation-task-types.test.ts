import assert from "node:assert/strict";
import test from "node:test";
import {
  GENERATION_SYNC_IDLE_MS,
  GENERATION_SYNC_LIVE_MS,
  generationTaskListSignature,
  mergeGenerationTaskProjections,
  nextGenerationSyncDelay,
  type GenerationTaskProjection,
} from "./generation-task-types.ts";

function task(taskId: string, updatedAt: string, status: GenerationTaskProjection["status"]): GenerationTaskProjection {
  return {
    taskId,
    status,
    modelId: "gpt-image-2",
    kind: "image_generate",
    submittedConfig: {
      modelId: "gpt-image-2",
      mediaType: "image",
      aspectRatio: "1:1",
      outputResolution: "1k",
      qualityMode: "fast",
      referenceCount: 0,
      loraModelVersionIds: [],
    },
    resultIds: [],
    results: [],
    requestedCount: 1,
    completedCount: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt,
  };
}

test("server task projections converge by stable task id and newest update", () => {
  const merged = mergeGenerationTaskProjections(
    [task("task-1", "2026-08-01T00:00:01.000Z", "queued")],
    [task("task-1", "2026-08-01T00:00:02.000Z", "succeeded")],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].taskId, "task-1");
  assert.equal(merged[0].status, "succeeded");
});

test("同步指紋：狀態/更新時間/完成數任一變化才算變化", () => {
  const base = { taskId: "a", status: "running", updatedAt: "2026-10-01T00:00:00.000Z", completedCount: 0 } as GenerationTaskProjection;
  const same = generationTaskListSignature([base]);
  assert.equal(generationTaskListSignature([{ ...base }]), same);
  assert.notEqual(generationTaskListSignature([{ ...base, status: "succeeded" } as GenerationTaskProjection]), same);
  assert.notEqual(generationTaskListSignature([{ ...base, updatedAt: "2026-10-01T00:00:01.000Z" }]), same);
  assert.notEqual(generationTaskListSignature([{ ...base, completedCount: 1 }]), same);
  assert.notEqual(generationTaskListSignature([]), same);
});

test("同步節奏：隱藏不排、有任務 3s、閒置 30s", () => {
  assert.equal(nextGenerationSyncDelay({ hidden: true, hasLiveTasks: true }), null);
  assert.equal(nextGenerationSyncDelay({ hidden: false, hasLiveTasks: true }), GENERATION_SYNC_LIVE_MS);
  assert.equal(nextGenerationSyncDelay({ hidden: false, hasLiveTasks: false }), GENERATION_SYNC_IDLE_MS);
});

