import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { isMissingUpstreamTask, isUndeliveredNoHandle } from "./reconcile-missing-task"

describe("上游没做成", () => {
  test("只有 404 且 Task not found 才算任务不存在", () => {
    assert.strictEqual(isMissingUpstreamTask("HTTP 404 Task not found"), true)
    assert.strictEqual(isMissingUpstreamTask("HTTP 404"), false)
    assert.strictEqual(isMissingUpstreamTask("timeout"), false)
    assert.strictEqual(isMissingUpstreamTask(""), false)
  })

  test("没有任务标识、没有响应、还挂在 submit_unknown，才算没交付", () => {
    assert.strictEqual(isUndeliveredNoHandle({ providerTaskId: "", responseCiphertext: null, jobStatus: "submit_unknown" }), true)
    assert.strictEqual(isUndeliveredNoHandle({ providerTaskId: "task_1", responseCiphertext: null, jobStatus: "submit_unknown" }), false)
    assert.strictEqual(isUndeliveredNoHandle({ providerTaskId: "", responseCiphertext: "cipher", jobStatus: "submit_unknown" }), false)
    assert.strictEqual(isUndeliveredNoHandle({ providerTaskId: "", responseCiphertext: "", jobStatus: "running" }), false)
  })
})
