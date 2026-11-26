import assert from "node:assert/strict"
import test from "node:test"
import { currentKernelFingerprint, decideKernelResume, kernelFingerprint } from "./agent-kernel.ts"

test("同一工具面与模型，指纹稳定", () => {
  const a = currentKernelFingerprint("video-director", "seedance-2.5")
  const b = kernelFingerprint({ agent: "video-director", modelId: "seedance-2.5" })
  assert.equal(a, b)
  assert.equal(a.length, 64)
})

test("工具面变了，续跑 409", () => {
  const stored = kernelFingerprint({
    agent: "video-director",
    modelId: "seedance-2.5",
    surfaces: ["worker-hard-rules"],
  })
  const current = currentKernelFingerprint("video-director", "seedance-2.5")
  const decision = decideKernelResume(stored, current)
  assert.equal(decision.ok, false)
  assert.equal(decision.status, 409)
  assert.equal(decision.code, "kernel_drift")
})

test("未盖章的旧 run 放行", () => {
  assert.equal(decideKernelResume(undefined, currentKernelFingerprint("critic", "m")).ok, true)
})

test("指纹一致才允许续跑", () => {
  const current = currentKernelFingerprint("editor", "ffmpeg")
  assert.equal(decideKernelResume(current, current).ok, true)
})
