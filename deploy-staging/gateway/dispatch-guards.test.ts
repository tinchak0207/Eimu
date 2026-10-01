// H9/M1/M2/M3 派遣守衛（純邏輯）。跑法：timeout 240 npx tsx --test deploy-staging/gateway/dispatch-guards.test.ts
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { guardExpertContent, musicFirstBlockReason, isReworkSpec, reworkLockDirective } from "./jev-gate.ts"

const dir = new URL(".", import.meta.url).pathname

test("H9 ROUTE_CRITERIA 含 critic/research", () => {
  const src = readFileSync(`${dir}jev-gate.ts`, "utf8")
  assert.match(src, /critic: "審核/)
  assert.match(src, /research: "調研/)
})

test("H9 研究任務填 critic → 降為通用子代理", () => {
  const r = guardExpertContent("調研 2026 日本動漫 OP 的視覺趨勢，整理參考資料", "critic")
  assert.equal(r.expertId, "")
  assert.ok(r.reason)
})

test("H9 真審核任務保留 critic", () => {
  assert.equal(guardExpertContent("審核以下分鏡稿，給 verdict", "critic").expertId, "critic")
  assert.equal(guardExpertContent("研究結論驗收：請審核這份調研報告", "critic").expertId, "critic")
})

test("H9 跨域翻轉已移除（2026-10-02 改派廢除令）：點名域一律保留", () => {
  // 事故史：「請作曲…」+editor 曾被關鍵詞計數翻成 music——表面詞彙不反映工具持有面。
  assert.equal(guardExpertContent("請作曲並寫旋律與歌詞", "editor").expertId, "editor")
  assert.equal(guardExpertContent("寫一段旋律", "editor").expertId, "editor")
  assert.equal(guardExpertContent("作曲、旋律", "music").expertId, "music")
  assert.equal(guardExpertContent("隨便", "").expertId, "")
  // 事故原案重放：轉存任務點名 video-director，不得被「上傳/轉存」詞彙翻成 editor。
  assert.equal(guardExpertContent("把 S02 渲染結果轉存為公網 URL（上傳入庫）", "video-director").expertId, "video-director")
})

test("刀3 點名域＝最終裁決（routeExpertAuthoritative 不再改派）", async () => {
  const src = readFileSync(`${dir}jev-gate.ts`, "utf8")
  // ROUTE_OVERRIDE 已廢除：殘留字樣只允許出現在事故記錄註解裡，不得再有改派分支。
  assert.doesNotMatch(src, /ROUTE_OVERRIDE provided=/)
  assert.match(src, /ROUTE_DISSENT provided=/)
  assert.match(src, /if \(provided\) \{[\s\S]*?return \{ expertId: provided, source: "provided" \}/)
})

test("M1 研究模板與 playbook 帶『不得填 critic』", () => {
  const t = JSON.parse(readFileSync(`${dir}spec-templates.json`, "utf8")) as Record<string, string>
  assert.match(t.research, /不得填 critic/)
  assert.match(readFileSync(`${dir}expert/orchestrator-dispatch-playbook.md`, "utf8"), /不得填 critic/)
})

test("M2 music 在途 → 分鏡擋下", () => {
  const r = musicFirstBlockReason("按音樂節拍設計分鏡", "video-director", { musicInFlight: true, musicDelivered: false })
  assert.match(r ?? "", /music-first/)
})

test("M2 無 music 交付且無音訊檔 → 擋；有交付/有音訊檔/無依賴 → 放行", () => {
  const dep = "根據音樂節拍做 12 個鏡頭的分鏡"
  assert.ok(musicFirstBlockReason(dep, "video-director", { musicInFlight: false, musicDelivered: false }))
  assert.equal(musicFirstBlockReason(dep, "video-director", { musicInFlight: false, musicDelivered: true }), null)
  assert.equal(musicFirstBlockReason(dep + " 音訊 outputs/song.mp3", "video-director", { musicInFlight: false, musicDelivered: false }), null)
  assert.equal(musicFirstBlockReason("設計角色立繪", "video-director", { musicInFlight: true, musicDelivered: false }), null)
  assert.equal(musicFirstBlockReason("為節拍作曲", "music", { musicInFlight: true, musicDelivered: false }), null)
})

test("M3 返工偵測與內容鎖", () => {
  assert.equal(isReworkSpec("返工：只重寫時長欄"), true)
  assert.equal(isReworkSpec("設計新角色"), false)
  const d = reworkLockDirective("outputs/subagent/ab12.md")
  assert.match(d, /逐字沿用原稿 outputs\/subagent\/ab12\.md/)
  assert.match(d, /diff/)
  assert.match(reworkLockDirective(""), /原稿路徑缺失/)
})

test("subagent.ts 已接線四個守衛", () => {
  const s = readFileSync(`${dir}subagent.ts`, "utf8")
  for (const k of ["guardExpertContent(", "musicFirstBlockReason(", "isReworkSpec(", "reworkLockDirective("]) assert.ok(s.includes(k), k)
})
