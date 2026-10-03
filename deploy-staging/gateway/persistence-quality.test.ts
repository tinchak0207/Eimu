// D7（2026-10-02）品質量測基座單元測試。
// 病灶：critic_passes 只有 session_id/created_at（無 verdict）、subagent_reworks 終局刪除
// （無終身計數）、無重問率 → 「品質」在系統裡完全不可觀測（LESSONS L8）。
// 本測試驗三張新表（critic_verdicts / expert_lessons / deliveries）與統計函式。
//
// 注意：DB 路徑在 persistence 模組載入時固定，全進程共享；故本檔在**載入 persistence 之前**
// 把 SESSIONS_DB_PATH 指向自己的臨時檔（見下方動態 import），不碰生產 sessions.db。
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

// 必須在 import persistence **之前**指定 DB 路徑（persistence 於模組載入時固定路徑）。
// 故用動態 import（靜態 import 會被提升到 env 設定之前）。
process.env.SESSIONS_DB_PATH = join(mkdtempSync(join(tmpdir(), "d7-quality-")), "sessions.db")
const persistence = await import("./persistence")
const gate = await import("./delivery-gate.ts")

persistence.initPersistence()

const uniq = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

describe("D7 品質量測基座", () => {
  test("critic_verdicts：判決寫入、統計、同 run 冪等（INSERT OR REPLACE）", () => {
    const r1 = `r1-${uniq()}`
    const r3 = `r3-${uniq()}`
    persistence.saveCriticVerdict({ sessionId: "s1", runId: r1, agent: "music", verdict: "pass", judgeModel: "p/m", verdictText: "逐项通过" })
    persistence.saveCriticVerdict({ sessionId: "s1", runId: r3, agent: "editor", verdict: "reject", verdictText: "缺少交付栏位" })
    // 同 run 重複寫入不得長出第二列（重試/競態安全），且以最後一次為準。
    persistence.saveCriticVerdict({ sessionId: "s1", runId: r3, agent: "editor", verdict: "reject", verdictText: "改判后仍退回" })
    const a = persistence.getCriticVerdictByRun(r1)!
    const b = persistence.getCriticVerdictByRun(r3)!
    expect(a.verdict).toBe("pass")
    expect(b.verdict).toBe("reject")
    expect(b.verdict_text).toBe("改判后仍退回")
    expect(persistence.qualitySignalStats().criticVerdicts).toBeGreaterThanOrEqual(2)
  })

  test("score 未量測時存 NULL，不填 0 假值", () => {
    const r = `rnull-${uniq()}`
    persistence.saveCriticVerdict({ sessionId: "s-null", runId: r, agent: "music", verdict: "pass" })
    expect(persistence.getCriticVerdictByRun(r)!.score).toBeNull()
  })

  test("expert_lessons：失敗模式永久留存（非終局刪除）", () => {
    const before = persistence.qualitySignalStats().expertLessons
    persistence.saveExpertLesson({ sessionId: "s1", agent: "music", runId: `rl-${uniq()}`, source: "delivery_gate", failureMode: "audio_url,duration_source", detail: "缺两个必填栏" })
    persistence.saveExpertLesson({ sessionId: "s1", agent: "editor", runId: `rl-${uniq()}`, source: "critic_reject", failureMode: "machine_critic_reject" })
    expect(persistence.qualitySignalStats().expertLessons).toBe(before + 2)
  })

  test("deliveries + 重問率：同 (session, agent, label) 再次交付計入重問", () => {
    const sid = `s2-${uniq()}`
    persistence.saveDelivery({ sessionId: sid, runId: `d1-${uniq()}`, agent: "music", label: "配乐", relPath: "outputs/subagent/d1.md", contractOk: true })
    persistence.saveDelivery({ sessionId: sid, runId: `d2-${uniq()}`, agent: "music", label: "配乐", relPath: "outputs/subagent/d2.md", contractOk: false })
    persistence.saveDelivery({ sessionId: sid, runId: `d3-${uniq()}`, agent: "music", label: "母带", relPath: "outputs/subagent/d3.md", contractOk: true })
    const st = persistence.qualitySignalStats()
    // 本會話 3 筆交付中 1 筆重複（配乐 ×2）→ 重問率 > 0（全庫比例，只能斷言方向）。
    expect(st.deliveries).toBeGreaterThanOrEqual(3)
    expect(st.reaskRate).toBeGreaterThan(0)
    expect(st.reaskRate).toBeLessThanOrEqual(1)
  })
})

// v3（2026-10-03）：「評審可計量」——分數樣本 + 人工標籤 join + 代碼強制數值閾值。
// 反偽造紅線：不得填 0 假值；宣告 measured 必須有數值；模型自評永不構成驗收 oracle。
// ⚠ 本 describe 第一個測試斷言「零樣本」不變式，故它之前不得有任何寫入 score 的測試
// （上面的 D7 describe 只寫 null score，符合）。measured 入庫測試放在其後。
describe("評審可計量（v3）", () => {
  test("meanScore / acceptRate 在零樣本時為 null，不得回 0 假值", () => {
    const st = persistence.qualitySignalStats()
    expect(st.scoreSamples).toBe(0)
    expect(st.meanScore).toBeNull()
    expect(st.labeledDeliveries).toBe(0)
    expect(st.acceptRate).toBeNull()
  })

  test("human_labels：同 run 重複標註冪等（以最後一次為準，不長第二列）", () => {
    const sid = `h-${uniq()}`
    const r = `hl-${uniq()}`
    persistence.saveHumanLabel({ sessionId: sid, runId: r, agent: "music", label: "accept", note: "首轮通过" })
    persistence.saveHumanLabel({ sessionId: sid, runId: r, agent: "music", label: "reject", note: "重看后改判" })
    const got = persistence.getHumanLabelByRun(r)!
    expect(got.label).toBe("reject")
    expect(got.note).toBe("重看后改判")
    const labeled = persistence.qualitySignalStats().labeledDeliveries
    persistence.saveHumanLabel({ sessionId: sid, runId: r, agent: "music", label: "accept" })
    // 同 run 再寫一次不新增列（冪等）。
    expect(persistence.qualitySignalStats().labeledDeliveries).toBe(labeled)
  })

  test("acceptRate：accept/已標註交付；增減正確", () => {
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

  test("scoreSource：measured 需有數值（否則留 null）；measured 分數才反映進 meanScore", () => {
    // 宣告 measured 卻沒有數值 → score 與 score_source 皆維持 null（不製造假量測）。
    const rm = `rm-${uniq()}`
    persistence.saveCriticVerdict({ sessionId: "s-m", runId: rm, agent: "music", verdict: "pass", scoreSource: "measured" })
    const vm = persistence.getCriticVerdictByRun(rm)!
    expect(vm.score).toBeNull()
    expect(vm.score_source).toBeNull()

    // model_self 可與 null score 並存（分類判決無數值），來源如實記錄。
    const rs = `rs-${uniq()}`
    persistence.saveCriticVerdict({ sessionId: "s-m", runId: rs, agent: "music", verdict: "pass", score: null, scoreSource: "model_self" })
    const vs = persistence.getCriticVerdictByRun(rs)!
    expect(vs.score).toBeNull()
    expect(vs.score_source).toBe("model_self")

    // 真實量測分數入庫：score/source 落庫，meanScore/scoreSamples 反映（此前 score 恆 NULL）。
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

  test("evaluateCriticScoreThreshold：只對 measured enforce；model_self/human/無分數不 enforce；詞表層保留", () => {
    const P = gate.CRITIC_SCORE_THRESHOLD_POLICY
    expect(P.reworkBelow).toBe(7)
    expect(P.enforcedSource).toBe("measured")
    // measured 且低於閾值 → 代碼強制返工
    const low = gate.evaluateCriticScoreThreshold({ value: 5, source: "measured" }, P)
    expect(low.enforce).toBe(true)
    expect(low.reason.length).toBeGreaterThan(0)
    // measured 但已達標 / 無數值 / 非 measured 來源 → 不強制
    expect(gate.evaluateCriticScoreThreshold({ value: 8, source: "measured" }, P).enforce).toBe(false)
    expect(gate.evaluateCriticScoreThreshold({ value: null, source: "measured" }, P).enforce).toBe(false)
    expect(gate.evaluateCriticScoreThreshold({ value: 5, source: "model_self" }, P).enforce).toBe(false)
    expect(gate.evaluateCriticScoreThreshold({ value: 5, source: "human" }, P).enforce).toBe(false)
    // 既有布林詞表層行為不變（作為布林層繼續存在）。
    expect(gate.criticVerdictRejected("verdict：通过")).toBe(false)
    expect(gate.criticVerdictRejected("verdict：退回，缺少栏位")).toBe(true)
    expect(gate.criticVerdictRejected("")).toBe(true)
  })
})
