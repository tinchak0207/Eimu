/**
 * film-qc / reasoning-cap / plan-promise 测试。跑法：bun test gateway/film-qc.test.ts
 * 集成段用 ffmpeg lavfi 现场合成「低响度 + 结尾冻结」片，不依赖外部素材。
 */
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { analyzeFilm, parseEbur128, parseSegments, qcAndFixFilm, tailSegmentStart } from "./film-qc.ts"
import {
  noteReasoningDelta,
  resetReasoningCap,
  REASONING_NOACTION_MAX_CHARS,
  REASONING_NOACTION_MAX_MS,
  REASONING_FIRST_GEN_MAX_CHARS,
  type ReasoningCapState,
} from "./reasoning-cap.ts"
import { emitUnfulfilledPlanNotice, recordUnfulfilledPlan, takeUnfulfilledPlanInjection, unfulfilledPlanNotice, type PlanPromiseState } from "./plan-promise.ts"

test("parseEbur128 / parseSegments / tailSegmentStart 纯解析", () => {
  const e = parseEbur128("Summary:\n  Integrated loudness:\n    I:         -38.5 LUFS\n  True peak:\n    Peak:      -22.1 dBFS\n")
  assert.deepEqual(e, { lufs: -38.5, truePeakDb: -22.1 })
  const f = parseSegments("lavfi.freezedetect.freeze_start: 28.85\n", "freeze")
  assert.deepEqual(f, [{ start: 28.85, end: null }])
  assert.equal(tailSegmentStart(f, 30.26), 28.85)
  assert.equal(tailSegmentStart([{ start: 5, end: 8 }], 30), null, "中段冻结不算尾部")
  assert.equal(tailSegmentStart([{ start: 29.9, end: null }], 30), null, "不足 0.5s 不处理")
})

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0
test("集成：低响度+结尾冻结 → 正规化到 -16 LUFS 并剪掉冻结；干净片原样放行", { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "filmqc-"))
  const bad = path.join(dir, "bad.mp4")
  // 20s：前 18.5s 运动测试图 + 末 1.5s 冻结（tpad clone）；音频 -35dB 正弦
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=18.5", "-f", "lavfi", "-i", "sine=f=440:d=20", "-vf", "tpad=stop_mode=clone:stop_duration=1.5", "-af", "volume=-30dB", "-t", "20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", bad])
  const before = await analyzeFilm("ffmpeg", bad)
  assert.ok(before.lufs !== null && before.lufs < -30, `before lufs=${before.lufs}`)
  assert.ok(before.tailFreezeStart !== null && before.tailFreezeStart > 17, `before freeze=${before.tailFreezeStart}`)
  const r = await qcAndFixFilm("ffmpeg", bad, path.join(dir, "fixed.mp4"))
  assert.equal(r.changed, true, r.notes.join("|"))
  assert.ok(r.after && r.after.lufs !== null && Math.abs(r.after.lufs + 16) < 2.5, `after lufs=${r.after?.lufs}`)
  assert.equal(r.after?.tailFreezeStart, null)
  assert.ok(r.after!.durationSec < before.durationSec - 1)
  // 已合格的片（修复版再跑一次）不再被动
  const again = await qcAndFixFilm("ffmpeg", r.path, path.join(dir, "fixed2.mp4"))
  assert.equal(again.changed, false)
  // 不存在的输入：不抛错、回原路径
  const miss = await qcAndFixFilm("ffmpeg", path.join(dir, "nope.mp4"), path.join(dir, "o.mp4"))
  assert.equal(miss.changed, false)
})

test("reasoning-cap：零长不计；首回合超软限回 soft（不 abort）；再破常规上限回 hard；reset 归零", () => {
  const st: ReasoningCapState = {}
  // 零长度不计、不设时间窗。
  assert.equal(noteReasoningDelta(st, 0, { now: 1000 }).kind, "none")
  assert.equal(st.reasonSinceActionChars ?? 0, 0)
  // 首回合（尚无工具调用与非空正文）：破首回合软限 → soft（诚实上报，不中止）。
  const first = noteReasoningDelta(st, REASONING_FIRST_GEN_MAX_CHARS, { now: 2000, ctx: { hasTool: false, hasText: false } })
  assert.equal(first.kind, "soft")
  assert.equal((first as { phase: string }).phase, "first-gen")
  // 软限用尽后视窗归零（第二段以常规上限重计）：再破常规上限 → hard。
  assert.equal(st.reasonSinceActionChars, 0)
  const hard = noteReasoningDelta(st, REASONING_NOACTION_MAX_CHARS, { now: 3000, ctx: { hasTool: false, hasText: false } })
  assert.equal(hard.kind, "hard")
  // reset 后归零，且阶段回 0（重新给首回合宽限）。
  resetReasoningCap(st)
  assert.equal(st.reasonSinceActionChars, 0)
  assert.equal(noteReasoningDelta(st, 10, { now: 4000, ctx: { hasTool: false, hasText: false } }).kind, "none")
})

test("reasoning-cap：本轮已有动作 → 无首回合宽限，超字数直接 hard", () => {
  const st: ReasoningCapState = {}
  // active 阶段（已有工具/正文）以常规上限计，首回合的 24000 宽限不适用。
  assert.equal(noteReasoningDelta(st, 100, { now: 1000, ctx: { hasTool: true, hasText: true } }).kind, "none")
  const v = noteReasoningDelta(st, REASONING_NOACTION_MAX_CHARS, { now: 2000, ctx: { hasTool: true, hasText: true } })
  assert.equal(v.kind, "hard")
  assert.equal((v as { overChars: boolean }).overChars, true)
})

test("reasoning-cap：长时间空转（超时）→ hard 且 overMs=true", () => {
  const st: ReasoningCapState = {}
  noteReasoningDelta(st, 10, { now: 5000, ctx: { hasTool: true, hasText: true } })
  const v = noteReasoningDelta(st, 10, { now: 5000 + REASONING_NOACTION_MAX_MS + 1, ctx: { hasTool: true, hasText: true } })
  assert.equal(v.kind, "hard")
  assert.equal((v as { overMs: boolean }).overMs, true)
})

test("plan-promise：计画点名专家但零 subagent.started → 诚实告知；有派或没点名 → 不吭声", () => {
  assert.match(unfulfilledPlanNotice({ planExperts: ["screenwriter"], turnSubagentStarts: 0 })!, /screenwriter.*未实际派出/)
  assert.equal(unfulfilledPlanNotice({ planExperts: ["screenwriter"], turnSubagentStarts: 1 }), null)
  assert.equal(unfulfilledPlanNotice({ turnSubagentStarts: 0 }), null)
})

test("plan-promise C 方案：收盘记录 → 次轮注入 → 一次性清除（不残留）", () => {
  const st: PlanPromiseState = { planExperts: ["screenwriter"], turnSubagentStarts: 0 }
  assert.equal(recordUnfulfilledPlan(st), true)
  assert.deepEqual(st.pendingUnfulfilledPlan, ["screenwriter"], "收盘应存下未兑现计画")
  // 同一 idle 重入：planExperts 已被清 → 不得覆写既有事实（防抹除）
  st.planExperts = undefined
  assert.equal(recordUnfulfilledPlan(st), false)
  assert.deepEqual(st.pendingUnfulfilledPlan, ["screenwriter"], "重入不得抹除待注入事实")
  // 次轮注入：字串是事实陈述且点名专家；取出即清
  const inj = takeUnfulfilledPlanInjection(st)
  assert.ok(inj !== null)
  assert.match(inj!, /screenwriter/)
  assert.match(inj!, /0 次专家派遣/)
  assert.equal(st.pendingUnfulfilledPlan, undefined, "取出后栏位必须清空（不残留）")
  assert.equal(takeUnfulfilledPlanInjection(st), null, "不得重复注入")
})

test("plan-promise C 方案：已兑现（有派遣）/中止/没点名 → 不记录、不注入", () => {
  const fulfilled: PlanPromiseState = { planExperts: ["screenwriter"], turnSubagentStarts: 1 }
  assert.equal(recordUnfulfilledPlan(fulfilled), false)
  assert.equal(takeUnfulfilledPlanInjection(fulfilled), null)
  const aborted: PlanPromiseState = { planExperts: ["screenwriter"], turnSubagentStarts: 0, turnAborted: true }
  assert.equal(recordUnfulfilledPlan(aborted), false)
  assert.equal(takeUnfulfilledPlanInjection(aborted), null)
  const noPlan: PlanPromiseState = { turnSubagentStarts: 0 }
  assert.equal(recordUnfulfilledPlan(noPlan), false)
  assert.equal(takeUnfulfilledPlanInjection(noPlan), null)
})

test("plan-promise 诚实告知走耐久通道 message.delta（真送出一帧，非只断言字串）", () => {
  const frames: { name: string; data: unknown }[] = []
  const emit = (name: string, data: unknown): void => {
    frames.push({ name, data })
  }
  const st: PlanPromiseState = { planExperts: ["screenwriter"], turnSubagentStarts: 0 }
  assert.equal(emitUnfulfilledPlanNotice(st, emit), true, "未兑现计画必须真的送出")
  assert.equal(frames.length, 1, "必须送出一帧")
  assert.equal(frames[0].name, "message.delta", "必须走耐久通道（非 turn.status）")
  assert.match((frames[0].data as { text: string }).text, /screenwriter/)
  // 已兑现 / 中止 → 一帧都不送
  frames.length = 0
  assert.equal(emitUnfulfilledPlanNotice({ planExperts: ["screenwriter"], turnSubagentStarts: 2 }, emit), false)
  assert.equal(
    emitUnfulfilledPlanNotice({ planExperts: ["screenwriter"], turnSubagentStarts: 0, turnAborted: true }, emit),
    false,
  )
  assert.equal(frames.length, 0, "不该送的场景零帧")
})
