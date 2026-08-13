import assert from "node:assert/strict";
import test from "node:test";
import { mergeGenerationTaskProjections, type GenerationTaskProjection } from "./generation-task-types.ts";

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
