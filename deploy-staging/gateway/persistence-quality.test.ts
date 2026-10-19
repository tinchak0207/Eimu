// D7（2026-10-02）品质量测基座单元测试。
// 病灶：critic_passes 只有 session_id/created_at（无 verdict）、subagent_reworks 终局删除
// （无终身计数）、无重问率 → 「品质」在系统里完全不可观测（LESSONS L8）。
// 本测试验三张新表（critic_verdicts / expert_lessons / deliveries）与统计函式。
//
// 注意：DB 路径在 persistence 模组载入时固定，全进程共享；故本档在**载入 persistence 之前**
// 把 SESSIONS_DB_PATH 指向自己的临时档（见下方动态 import），不碰生产 sessions.db。
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

// 必须在 import persistence **之前**指定 DB 路径（persistence 于模组载入时固定路径）。
// 故用动态 import（静态 import 会被提升到 env 设定之前）。
process.env.SESSIONS_DB_PATH = join(mkdtempSync(join(tmpdir(), "d7-quality-")), "sessions.db")
const persistence = await import("./persistence")
const gate = await import("./delivery-gate.ts")

persistence.initPersistence()

const uniq = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

describe("D7 品质量测基座", () => {
  test("critic_verdicts：判决写入、统计、同 run 幂等（INSERT OR REPLACE）", () => {
    const r1 = `r1-${uniq()}`
    const r3 = `r3-${uniq()}`
    persistence.saveCriticVerdict({ sessionId: "s1", runId: r1, agent: "music", verdict: "pass", judgeModel: "p/m", verdictText: "逐项通过" })
    persistence.saveCriticVerdict({ sessionId: "s1", runId: r3, agent: "editor", verdict: "reject", verdictText: "缺少交付栏位" })
    // 同 run 重复写入不得长出第二列（重试/竞态安全），且以最后一次为准。
    persistence.saveCriticVerdict({ sessionId: "s1", runId: r3, agent: "editor", verdict: "reject", verdictText: "改判后仍退回" })
    const a = persistence.getCriticVerdictByRun(r1)!
    const b = persistence.getCriticVerdictByRun(r3)!
    expect(a.verdict).toBe("pass")
    expect(b.verdict).toBe("reject")
    expect(b.verdict_text).toBe("改判后仍退回")
    expect(persistence.qualitySignalStats().criticVerdicts).toBeGreaterThanOrEqual(2)
  })

  test("score 未量测时存 NULL，不填 0 假值", () => {
    const r = `rnull-${uniq()}`
    persistence.saveCriticVerdict({ sessionId: "s-null", runId: r, agent: "music", verdict: "pass" })
    expect(persistence.getCriticVerdictByRun(r)!.score).toBeNull()
  })

  test("expert_lessons：失败模式永久留存（非终局删除）", () => {
    const before = persistence.qualitySignalStats().expertLessons
    persistence.saveExpertLesson({ sessionId: "s1", agent: "music", runId: `rl-${uniq()}`, source: "delivery_gate", failureMode: "audio_url,duration_source", detail: "缺两个必填栏" })
    persistence.saveExpertLesson({ sessionId: "s1", agent: "editor", runId: `rl-${uniq()}`, source: "critic_reject", failureMode: "machine_critic_reject" })
    expect(persistence.qualitySignalStats().expertLessons).toBe(before + 2)
  })

  test("deliveries + 重问率：同 (session, agent, label) 再次交付计入重问", () => {
    const sid = `s2-${uniq()}`
    persistence.saveDelivery({ sessionId: sid, runId: `d1-${uniq()}`, agent: "music", label: "配乐", relPath: "outputs/subagent/d1.md", contractOk: true })
    persistence.saveDelivery({ sessionId: sid, runId: `d2-${uniq()}`, agent: "music", label: "配乐", relPath: "outputs/subagent/d2.md", contractOk: false })
    persistence.saveDelivery({ sessionId: sid, runId: `d3-${uniq()}`, agent: "music", label: "母带", relPath: "outputs/subagent/d3.md", contractOk: true })
    const st = persistence.qualitySignalStats()
    // 本会话 3 笔交付中 1 笔重复（配乐 ×2）→ 重问率 > 0（全库比例，只能断言方向）。
    expect(st.deliveries).toBeGreaterThanOrEqual(3)
    expect(st.reaskRate).toBeGreaterThan(0)
    expect(st.reaskRate).toBeLessThanOrEqual(1)
  })
})

// v3（2026-10-03）：「评审可计量」——分数样本 + 人工标签 join + 代码强制数值阈值。
// 反伪造红线：不得填 0 假值；宣告 measured 必须有数值；模型自评永不构成验收 oracle。
// ⚠ 本 describe 第一个测试断言「零样本」不变式，故它之前不得有任何写入 score 的测试
// （上面的 D7 describe 只写 null score，符合）。measured 入库测试放在其后。
describe("评审可计量（v3）", () => {
  test("meanScore / acceptRate 在零样本时为 null，不得回 0 假值", () => {
    const st = persistence.qualitySignalStats()
    expect(st.scoreSamples).toBe(0)
    expect(st.meanScore).toBeNull()
    expect(st.labeledDeliveries).toBe(0)
    expect(st.acceptRate).toBeNull()
  })

  test("human_labels：同 run 重复标注幂等（以最后一次为准，不长第二列）", () => {
    const sid = `h-${uniq()}`
    const r = `hl-${uniq()}`
    persistence.saveHumanLabel({ sessionId: sid, runId: r, agent: "music", label: "accept", note: "首轮通过" })
    persistence.saveHumanLabel({ sessionId: sid, runId: r, agent: "music", label: "reject", note: "重看后改判" })
    const got = persistence.getHumanLabelByRun(r)!
    expect(got.label).toBe("reject")
    expect(got.note).toBe("重看后改判")
    const labeled = persistence.qualitySignalStats().labeledDeliveries
    persistence.saveHumanLabel({ sessionId: sid, runId: r, agent: "music", label: "accept" })
    // 同 run 再写一次不新增列（幂等）。
    expect(persistence.qualitySignalStats().labeledDeliveries).toBe(labeled)
  })

  test("acceptRate：accept/已标注交付；增减正确", () => {
    const sid = `hr-${uniq()}`
    const before = persistence.qualitySignalStats()
    persistence.saveHumanLabel({ sessionId: sid, runId: `ha1-${uniq()}`, agent: "music", label: "accept" })
    persistence.saveHumanLabel({ sessionId: sid, runId: `ha2-${uniq()}`, agent: "music", label: "accept" })
    persistence.saveHumanLabel({ sessionId: sid, runId: `hr1-${uniq()}`, agent: "music", label: "reject" })
    const after = persistence.qualitySignalStats()
    expect(after.labeledDeliveries).toBe(before.labeledDeliveries + 3)
    const beforeAccepts = (before.acceptRate ?? 0) * before.labeledDeliveries
    expect(after.acceptRate).not.toBeNull()
    expect(after.acceptRate!).toBeCloseTo((beforeAccepts + 2) / (before.labeledDeliveries + 3), 10)
    expect(after.acceptRate!).toBeLessThanOrEqual(1)
  })

  test("scoreSource：measured 需有数值（否则留 null）；measured 分数才反映进 meanScore", () => {
    // 宣告 measured 却没有数值 → score 与 score_source 皆维持 null（不制造假量测）。
    const rm = `rm-${uniq()}`
    persistence.saveCriticVerdict({ sessionId: "s-m", runId: rm, agent: "music", verdict: "pass", scoreSource: "measured" })
    const vm = persistence.getCriticVerdictByRun(rm)!
    expect(vm.score).toBeNull()
    expect(vm.score_source).toBeNull()

    // model_self 可与 null score 并存（分类判决无数值），来源如实记录。
    const rs = `rs-${uniq()}`
    persistence.saveCriticVerdict({ sessionId: "s-m", runId: rs, agent: "music", verdict: "pass", score: null, scoreSource: "model_self" })
    const vs = persistence.getCriticVerdictByRun(rs)!
    expect(vs.score).toBeNull()
    expect(vs.score_source).toBe("model_self")

    // 真实量测分数入库：score/source 落库，meanScore/scoreSamples 反映（此前 score 恒 NULL）。
    const rmeas = `rmeas-${uniq()}`
    persistence.saveCriticVerdict({
      sessionId: "s-m",
      runId: rmeas,
      agent: "music",
      verdict: "reject",
      score: 3.5,
      scoreSource: "measured",
      judgeModel: "hardcheck/ffprobe",
    })
    const vmeas = persistence.getCriticVerdictByRun(rmeas)!
    expect(vmeas.score).toBe(3.5)
    expect(vmeas.score_source).toBe("measured")
    const st = persistence.qualitySignalStats()
    expect(st.scoreSamples).toBe(1)
    expect(st.meanScore).toBe(3.5)
  })

  test("evaluateCriticScoreThreshold：只对 measured enforce；model_self/human/无分数不 enforce；词表层保留", () => {
    const P = gate.CRITIC_SCORE_THRESHOLD_POLICY
    expect(P.reworkBelow).toBe(7)
    expect(P.enforcedSource).toBe("measured")
    // measured 且低于阈值 → 代码强制返工
    const low = gate.evaluateCriticScoreThreshold({ value: 5, source: "measured" }, P)
    expect(low.enforce).toBe(true)
    expect(low.reason.length).toBeGreaterThan(0)
    // measured 但已达标 / 无数值 / 非 measured 来源 → 不强制
    expect(gate.evaluateCriticScoreThreshold({ value: 8, source: "measured" }, P).enforce).toBe(false)
    expect(gate.evaluateCriticScoreThreshold({ value: null, source: "measured" }, P).enforce).toBe(false)
    expect(gate.evaluateCriticScoreThreshold({ value: 5, source: "model_self" }, P).enforce).toBe(false)
    expect(gate.evaluateCriticScoreThreshold({ value: 5, source: "human" }, P).enforce).toBe(false)
    // 既有布林词表层行为不变（作为布林层继续存在）。
    expect(gate.criticVerdictRejected("verdict：通过")).toBe(false)
    expect(gate.criticVerdictRejected("verdict：退回，缺少栏位")).toBe(true)
    expect(gate.criticVerdictRejected("")).toBe(true)
  })
})
