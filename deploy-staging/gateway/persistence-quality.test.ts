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
