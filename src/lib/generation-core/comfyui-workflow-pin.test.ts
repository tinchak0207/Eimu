import assert from "node:assert/strict"
import test from "node:test"
import {
  ComfyVersionPinError,
  keepPinnedVersion,
  markTested,
  markValidated,
  pinTask,
  publishVersion,
  requirePinnedPublishedWorkflow,
  type ComfyWorkflowVersion,
} from "./comfyui-workflow-pin"

const imported: ComfyWorkflowVersion = { versionId: "v1", workflowId: "wf", status: "imported" }

test("未校验通过不能发布，校验+试跑通过后才能钉版本", () => {
  assert.throws(() => publishVersion(markValidated(imported, true)), ComfyVersionPinError)
  const published = publishVersion(markTested(markValidated(imported, true), true))
  assert.equal(published.status, "published")
  assert.deepEqual(pinTask("task-1", published), { taskId: "task-1", workflowVersionId: "v1" })
})

test("校验失败不能试跑，未发布不能钉", () => {
  const invalid = markValidated(imported, false)
  assert.equal(invalid.status, "invalid")
  assert.throws(() => markTested(invalid, true), /不能试跑/)
  assert.throws(() => pinTask("task-1", { ...imported, status: "test_passed" }), /已发布/)
})

test("后发布的新版本不改写进行中任务", () => {
  const pinned = pinTask("task-1", publishVersion(markTested(markValidated(imported, true), true)))
  const later = publishVersion(markTested(markValidated({ versionId: "v2", workflowId: "wf", status: "imported" }, true), true))
  assert.equal(keepPinnedVersion(pinned, later).workflowVersionId, "v1")
})

test("普通生成任务不要求钉版本；Comfy 任务缺发布版本则拒绝", () => {
  assert.doesNotThrow(() => requirePinnedPublishedWorkflow({}))
  assert.doesNotThrow(() => requirePinnedPublishedWorkflow(undefined))
  assert.throws(
    () => requirePinnedPublishedWorkflow({ protocol: "comfyui", comfyuiWorkflowId: "wf" }),
    /workflowVersionId/,
  )
  assert.throws(
    () => requirePinnedPublishedWorkflow({ comfyuiWorkflowId: "wf", workflowVersionId: "v1", comfyuiVersionStatus: "valid" }),
    /已发布/,
  )
  assert.doesNotThrow(() => requirePinnedPublishedWorkflow({
    comfyuiWorkflowId: "wf",
    workflowVersionId: "v1",
    comfyuiVersionStatus: "published",
  }))
})
