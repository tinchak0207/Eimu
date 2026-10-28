import assert from "node:assert/strict"
import { test } from "node:test"
import { cloudPathRefusal, decideAgentLocus } from "./agent-paths.ts"

const ws = "/opt/agent-harness/workspace"

test("使用者电脑上的绝对路径是本机 agent", () => {
  assert.equal(decideAgentLocus("/home/lenovo/Downloads/a.mp4", ws).locus, "local")
  assert.equal(decideAgentLocus("C:\\Users\\a\\a.mp4", ws).locus, "local")
  assert.match(cloudPathRefusal("/home/lenovo/Downloads/a.mp4", ws) ?? "", /locus=local/)
})

test("workspace、云端运行时、网址、相对路径是云端 agent", () => {
  assert.equal(decideAgentLocus(`${ws}/out/final.mp4`, ws).locus, "cloud")
  assert.equal(decideAgentLocus("/tmp/eimu-evidence-1.mp4", ws).locus, "cloud")
  assert.equal(decideAgentLocus("/opt/agent-harness/releases/x", ws).locus, "cloud")
  assert.equal(decideAgentLocus("https://example.com/a.mp4", ws).locus, "cloud")
  assert.equal(decideAgentLocus("uploads/a.mp4", ws).locus, "cloud")
  assert.equal(cloudPathRefusal(`${ws}/out/final.mp4`, ws), null)
})
