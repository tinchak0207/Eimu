import assert from "node:assert/strict"
import test from "node:test"
import { assertVideoAuthorityMix, videoAuthorityMixArgs } from "./video-authority-mix.ts"

test("混流参数以视频时长为权威，且不含 -shortest", () => {
  const args = videoAuthorityMixArgs(15.04)
  assertVideoAuthorityMix(args)
  assert.equal(args.includes("-shortest"), false)
  assert.equal(args[args.indexOf("-t") + 1], "15.040")
  assert.match(args[1] ?? "", /apad=whole_dur=15\.040/)
  assert.match(args[1] ?? "", /atrim=0:15\.040/)
})

test("时长无效时拒绝混流", () => {
  assert.throws(() => videoAuthorityMixArgs(0), /视频时长无效/)
  assert.throws(() => videoAuthorityMixArgs(Number.NaN), /视频时长无效/)
})

test("带 -shortest 的参数被拦住", () => {
  assert.throws(() => assertVideoAuthorityMix(["-shortest", "-t", "1"]), /-shortest/)
})
