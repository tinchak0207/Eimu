import { describe, expect, test } from "bun:test"
import { isMissingUpstreamTask, isUndeliveredNoHandle } from "./reconcile-missing-task"

describe("上游没做成", () => {
  test("只有 404 且 Task not found 才算任务不存在", () => {
    expect(isMissingUpstreamTask("HTTP 404 Task not found")).toBe(true)
    expect(isMissingUpstreamTask("HTTP 404")).toBe(false)
    expect(isMissingUpstreamTask("timeout")).toBe(false)
    expect(isMissingUpstreamTask("")).toBe(false)
  })

  test("没有任务标识、没有响应、还挂在 submit_unknown，才算没交付", () => {
    expect(isUndeliveredNoHandle({ providerTaskId: "", responseCiphertext: null, jobStatus: "submit_unknown" })).toBe(true)
    expect(isUndeliveredNoHandle({ providerTaskId: "task_1", responseCiphertext: null, jobStatus: "submit_unknown" })).toBe(false)
    expect(isUndeliveredNoHandle({ providerTaskId: "", responseCiphertext: "cipher", jobStatus: "submit_unknown" })).toBe(false)
    expect(isUndeliveredNoHandle({ providerTaskId: "", responseCiphertext: "", jobStatus: "running" })).toBe(false)
  })
})
