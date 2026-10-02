/**
 * film-qc / reasoning-cap / plan-promise 測試。跑法：bun test gateway/film-qc.test.ts
 * 集成段用 ffmpeg lavfi 現場合成「低響度 + 結尾凍結」片，不依賴外部素材。
 */
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { analyzeFilm, parseEbur128, parseSegments, qcAndFixFilm, tailSegmentStart } from "./film-qc.ts"
import { noteReasoningDelta, resetReasoningCap, REASONING_NOACTION_MAX_CHARS } from "./reasoning-cap.ts"
import { emitUnfulfilledPlanNotice, recordUnfulfilledPlan, takeUnfulfilledPlanInjection, unfulfilledPlanNotice, type PlanPromiseState } from "./plan-promise.ts"

test("parseEbur128 / parseSegments / tailSegmentStart 純解析", () => {
  const e = parseEbur128("Summary:\n  Integrated loudness:\n    I:         -38.5 LUFS\n  True peak:\n    Peak:      -22.1 dBFS\n")
  assert.deepEqual(e, { lufs: -38.5, truePeakDb: -22.1 })
  const f = parseSegments("lavfi.freezedetect.freeze_start: 28.85\n", "freeze")
  assert.deepEqual(f, [{ start: 28.85, end: null }])
  assert.equal(tailSegmentStart(f, 30.26), 28.85)
  assert.equal(tailSegmentStart([{ start: 5, end: 8 }], 30), null, "中段凍結不算尾部")
  assert.equal(tailSegmentStart([{ start: 29.9, end: null }], 30), null, "不足 0.5s 不處理")
})

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0
test("集成：低響度+結尾凍結 → 正規化到 -16 LUFS 並剪掉凍結；乾淨片原樣放行", { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "filmqc-"))
  const bad = path.join(dir, "bad.mp4")
  // 20s：前 18.5s 運動測試圖 + 末 1.5s 凍結（tpad clone）；音頻 -35dB 正弦
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=18.5", "-f", "lavfi", "-i", "sine=f=440:d=20", "-vf", "tpad=stop_mode=clone:stop_duration=1.5", "-af", "volume=-30dB", "-t", "20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", bad])
  const before = await analyzeFilm("ffmpeg", bad)
  assert.ok(before.lufs !== null && before.lufs < -30, `before lufs=${before.lufs}`)
  assert.ok(before.tailFreezeStart !== null && before.tailFreezeStart > 17, `before freeze=${before.tailFreezeStart}`)
  const r = await qcAndFixFilm("ffmpeg", bad, path.join(dir, "fixed.mp4"))
  assert.equal(r.changed, true, r.notes.join("|"))
  assert.ok(r.after && r.after.lufs !== null && Math.abs(r.after.lufs + 16) < 2.5, `after lufs=${r.after?.lufs}`)
  assert.equal(r.after?.tailFreezeStart, null)
  assert.ok(r.after!.durationSec < before.durationSec - 1)
  // 已合格的片（修復版再跑一次）不再被動
  const again = await qcAndFixFilm("ffmpeg", r.path, path.join(dir, "fixed2.mp4"))
  assert.equal(again.changed, false)
  // 不存在的輸入：不拋錯、回原路徑
  const miss = await qcAndFixFilm("ffmpeg", path.join(dir, "nope.mp4"), path.join(dir, "o.mp4"))
  assert.equal(miss.changed, false)
})

test("reasoning-cap：超字數/超時回報 true；動作歸零；零長度不計", () => {
  const st: { reasonSinceActionChars?: number; reasonSinceActionAt?: number } = {}
  assert.equal(noteReasoningDelta(st, 0, 1000), false)
  assert.equal(noteReasoningDelta(st, 100, 1000), false)
  assert.equal(noteReasoningDelta(st, REASONING_NOACTION_MAX_CHARS, 2000), true, "字數超限")
  resetReasoningCap(st)
  assert.equal(noteReasoningDelta(st, 10, 5000), false)
  assert.equal(noteReasoningDelta(st, 10, 5000 + 100_001), true, "時間超限（3 分鐘空轉場景）")
})

test("plan-promise：計畫點名專家但零 subagent.started → 誠實告知；有派或沒點名 → 不吭聲", () => {
  assert.match(unfulfilledPlanNotice({ planExperts: ["screenwriter"], turnSubagentStarts: 0 })!, /screenwriter.*未实际派出/)
  assert.equal(unfulfilledPlanNotice({ planExperts: ["screenwriter"], turnSubagentStarts: 1 }), null)
  assert.equal(unfulfilledPlanNotice({ turnSubagentStarts: 0 }), null)
})

test("plan-promise C 方案：收盤記錄 → 次輪注入 → 一次性清除（不殘留）", () => {
  const st: PlanPromiseState = { planExperts: ["screenwriter"], turnSubagentStarts: 0 }
  assert.equal(recordUnfulfilledPlan(st), true)
  assert.deepEqual(st.pendingUnfulfilledPlan, ["screenwriter"], "收盤應存下未兌現計畫")
  // 同一 idle 重入：planExperts 已被清 → 不得覆寫既有事實（防抹除）
  st.planExperts = undefined
  assert.equal(recordUnfulfilledPlan(st), false)
  assert.deepEqual(st.pendingUnfulfilledPlan, ["screenwriter"], "重入不得抹除待注入事實")
  // 次輪注入：字串是事實陳述且點名專家；取出即清
  const inj = takeUnfulfilledPlanInjection(st)
  assert.ok(inj !== null)
  assert.match(inj!, /screenwriter/)
  assert.match(inj!, /0 次专家派遣/)
  assert.equal(st.pendingUnfulfilledPlan, undefined, "取出後欄位必須清空（不殘留）")
  assert.equal(takeUnfulfilledPlanInjection(st), null, "不得重複注入")
})

test("plan-promise C 方案：已兌現（有派遣）/中止/沒點名 → 不記錄、不注入", () => {
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

test("plan-promise 誠實告知走耐久通道 message.delta（真送出一幀，非只斷言字串）", () => {
  const frames: { name: string; data: unknown }[] = []
  const emit = (name: string, data: unknown): void => {
    frames.push({ name, data })
  }
  const st: PlanPromiseState = { planExperts: ["screenwriter"], turnSubagentStarts: 0 }
  assert.equal(emitUnfulfilledPlanNotice(st, emit), true, "未兌現計畫必須真的送出")
  assert.equal(frames.length, 1, "必須送出一幀")
  assert.equal(frames[0].name, "message.delta", "必須走耐久通道（非 turn.status）")
  assert.match((frames[0].data as { text: string }).text, /screenwriter/)
  // 已兌現 / 中止 → 一幀都不送
  frames.length = 0
  assert.equal(emitUnfulfilledPlanNotice({ planExperts: ["screenwriter"], turnSubagentStarts: 2 }, emit), false)
  assert.equal(
    emitUnfulfilledPlanNotice({ planExperts: ["screenwriter"], turnSubagentStarts: 0, turnAborted: true }, emit),
    false,
  )
  assert.equal(frames.length, 0, "不該送的場景零幀")
})
