/**
 * outbound-sanitize.test.ts — 內部路徑／規則代號出站剝離（node:test 純邏輯）。
 * 跑法：npx --yes tsx --test gateway/outbound-sanitize.test.ts
 */
import assert from "node:assert/strict"
import test from "node:test"
import {
  detectUserScript,
  flushOtherPartTails,
  resolveUserScript,
  scrubInternalRefs,
  shouldT2sForUserScript,
  stripOutboundFeed,
  stripOutboundFlush,
  t2sLine,
  takeTurnEndTail,
  type PartStripState,
} from "./outbound-sanitize.ts"

test("工作區路徑與 R 系列代號被剝離（評測實錄原句）", () => {
  assert.equal(
    scrubInternalRefs("spec 已落盘 `runs/txj-ep01/audio/BGM-spec-and-failure-report.md`（稍后重投）"),
    "spec 已落盘 （内部存档）（稍后重投）",
  )
  assert.equal(scrubInternalRefs("证据链完整，R7 止损线到点即停"), "证据链完整，止损线到点即停")
  assert.equal(
    scrubInternalRefs("[完整结果已落盘：outputs/subagent/0be1228b-EP01配乐BGM.md（1159 字）]"),
    "[完整结果已落盘：（内部存档）（1159 字）]",
  )
  assert.equal(scrubInternalRefs("产物在 /opt/agent-harness/workspace/tixia_ep1/storyboard.json 里"), "产物在 （内部存档） 里")
  assert.equal(scrubInternalRefs("清单已落盘 `tixia_ep1/audio/tts_manifest.json`，"), "清单已落盘 （内部存档），")
})

test("交付物 URL 原樣保留（含路徑段與副檔名）", () => {
  const line = "成片：https://store.tinchak0207.xyz/agent/v1/audio/tts_mukadd47_ugkpykpi.mp3 ，字幕 https://x.example/runs/a.srt"
  assert.equal(scrubInternalRefs(line), line)
})

test("正常中文句與數字比例不誤傷", () => {
  for (const line of ["分镜 10 镜，60 秒，9:16 竖屏", "预算 500 币 / 10 镜", "R 级片不做", "林晚/林柔/顾沉三人同框"]) {
    assert.equal(scrubInternalRefs(line), line)
  }
})

test("出站狀態機接線：feed/flush 都走剝離", () => {
  const st = { pending: "", suppress: false, fence: false, sawEnglish: false }
  const out = stripOutboundFeed(st, "已落盘 `runs/a/b.md`\n尾行 R7 铁律") + stripOutboundFlush(st)
  assert.equal(out, "已落盘 （内部存档）\n尾行 铁律")
})

// ── R9-B（2026-09-30）：R5-C 跟隨用戶書寫體 + 日文行不轉 ──
const newSt = (t2s?: boolean): PartStripState => ({ pending: "", suppress: false, fence: false, sawEnglish: false, t2s })
const TRAD_USER = "幫我做一支日系百合番的片頭曲 MV，要 2026 年的最新風格，歌和畫面都要，直接給我成片。" // eval-yuri-op-mv-0930 原句
const SIMP_USER = "帮我做一支日系百合番的片头曲 MV，要 2026 年的最新风格，歌和画面都要，直接给我成片。"

test("R9-B 日文行（含假名）一律不轉：評測實錄歌詞", () => {
  for (const line of ["> この距離が　いまは宝物", "> ねえ　放課後の空を　君と見ていたい", "放課後のチャイムが　空に溶けてゆく"]) {
    assert.equal(t2sLine(line), line)
  }
  // 簡體會話（t2s 開）同樣不碰日文行，中文行照轉
  const st = newSt(true)
  const out = stripOutboundFeed(st, "> この距離が　いまは宝物\n這個時間\n") + stripOutboundFlush(st)
  assert.equal(out, "> この距離が　いまは宝物\n这个时间\n")
  // 中文排版的 ・ 不算假名
  assert.equal(t2sLine("阻塞 1・帳號餘額不足"), "阻塞 1・帳號余额不足")
})

test("R9-B 繁體用戶：判定 hant，出口不轉（評測原句）", () => {
  assert.equal(detectUserScript(TRAD_USER), "hant")
  assert.equal(shouldT2sForUserScript(detectUserScript(TRAD_USER)), false)
  const st = newSt(false)
  const body = "**阻塞 1・帳號餘額不足**\n我分別試了最便宜的通路，**兩邊都被擋**。\n音樂通路若那時還沒恢復"
  assert.equal(stripOutboundFeed(st, body) + stripOutboundFlush(st), body)
  // 無判定力的短回覆沿用上次書寫體
  assert.equal(resolveUserScript("hant", "A"), "hant")
  assert.equal(resolveUserScript("hant", SIMP_USER), "hans")
  // 繁體共用字（皇后/台北/只）不被誤判成簡體
  assert.equal(detectUserScript("皇后在台北只待一天"), "unknown")
})

test("R9-B 簡體用戶：R5-C 行為不變", () => {
  assert.equal(detectUserScript(SIMP_USER), "hans")
  assert.equal(shouldT2sForUserScript("hans"), true)
  assert.equal(shouldT2sForUserScript("unknown"), true) // 未判定＝保 R5-C 舊行為
  const legacy = newSt() // t2s 未設＝舊行為
  const on = newSt(true)
  const text = "這裡的時間會來\n## 標題說明\n尾行還沒換行"
  const a = stripOutboundFeed(legacy, text) + stripOutboundFlush(legacy)
  const b = stripOutboundFeed(on, text) + stripOutboundFlush(on)
  assert.equal(a, "这里的时间会来\n## 标题说明\n尾行还沒換行") // 沒/換 不在 R5-C 精簡表：舊行為即如此，原樣鎖定
  assert.equal(b, a)
})

// ── R9-B：旁白重播路徑重放（eval-yuri-op-mv-0930 SSE 9861–9895）──
// 事件序列取自 evidence/messages.json 的 assistant part 真實順序（text/tool 交錯），
// text part 按 5 字一塊切成 delta 餵入；接線與 opencode-event-handler.ts 相同：
// delta 前 flushOtherPartTails(map, pid)、tool pending 時 flushOtherPartTails(map)、
// idle 時 takeTurnEndTail(map)。修前（idle 全量 flush）會把 7 句尾行接在最終答覆後。
const FINAL_PART =
  "**結論先講：現在交不出成片——兩個硬阻塞，我照實報，不糊弄。**\n\n**阻塞 1・帳號餘額不足**\n" +
  "   - **C 省錢運鏡版**：純關鍵幀＋運鏡快切 → 約 0.02 幣\n\n" +
  "音樂通路若那時還沒恢復，我就**先把畫面＋剪輯做到成片**，歌一恢復補軌重合成，同一支片不用重做。"
const TURN: Array<["text", string, string] | ["tool", string]> = [
  ["text", "CsaoEg", "我先掌握行情与视频工作流规则，再给你一份完整方案和预算。"],
  ["tool", "read"], ["tool", "image_quote"], ["tool", "video_quote"], ["tool", "read"], ["tool", "asset_search"], ["tool", "quote_bundle"],
  ["text", "5VVsep", "方向我先定好，歌同步開始做。\n\n- **C 省錢運鏡版**：純關鍵幀 ＋ 運鏡快切 → 約 0.02 幣\n\n先讓歌跑起來："],
  ["tool", "music_gen"],
  ["text", "fsorom", "音樂通路第一輪三條全掛了，我換個節奏再試一次："],
  ["tool", "music_gen"],
  ["text", "fkUPQ3", "**現況先講清楚**：音樂生成的三條上游通路目前全部不可用。\n\n不空等，畫面先開工。我已經把兩位女主的定妝鎖定卡送去生成（成本≈0.002 幣），先把 2026 作畫調性定下來："],
  ["tool", "cast_asset_lock"],
  ["text", "4Cte63", "圖片通路也回報「餘額不足」。我用付費通路測一張確認是不是整帳號的問題："],
  ["tool", "image_generate"], ["tool", "image_generate"], ["tool", "image_generate"],
  ["text", "Jg2AFU", "付費通路是活的（剛才是尺寸參數不對）。用正確尺寸再打一張，確認整條鏈能跑："],
  ["tool", "image_generate"], ["tool", "skill"],
  ["text", "nmKooU", FINAL_PART],
]
function replayTurn(t2s: boolean, fixed: boolean): string[] {
  const map = new Map<string, PartStripState>()
  const frames: string[] = []
  for (const ev of TURN) {
    if (ev[0] === "tool") {
      if (fixed) {
        const t = flushOtherPartTails(map)
        if (t) frames.push(t)
      }
      frames.push(`<tool.invoke ${ev[1]}>`)
      continue
    }
    const [, pid, text] = ev
    for (let i = 0; i < text.length; i += 5) {
      if (fixed) {
        const t = flushOtherPartTails(map, pid)
        if (t) frames.push(t)
      }
      let st = map.get(pid)
      if (!st) map.set(pid, (st = newSt(t2s)))
      const safe = stripOutboundFeed(st, text.slice(i, i + 5))
      if (safe) frames.push(safe)
    }
  }
  if (fixed) {
    const { tail } = takeTurnEndTail(map)
    if (tail) frames.push(tail)
  } else {
    for (const [, st] of map) {
      const tail = stripOutboundFlush(st)
      if (tail) frames.push(tail)
    }
  }
  frames.push("<turn.done>")
  return frames
}
const NARRATION = ["我先掌握行情", "先讓歌跑起來：", "我換個節奏再試一次：", "不空等，畫面先開工", "我用付費通路測一張", "付費通路是活的"]

test("R9-B 重放 SSE 9861–9895：修前重現過期旁白接在最終答覆之後", () => {
  const out = replayTurn(false, false).join("")
  const finalAt = out.indexOf("**結論先講")
  for (const n of NARRATION) assert.ok(out.indexOf(n) > finalAt, `修前應重現：${n} 在最終答覆後`)
})

test("R9-B 重放 SSE 9861–9895：修後旁白按時序出現、最終答覆後零過期旁白", () => {
  const frames = replayTurn(false, true)
  const out = frames.join("")
  const finalAt = out.indexOf("**結論先講")
  assert.ok(finalAt > 0)
  for (const n of NARRATION) {
    assert.equal(out.split(n).length - 1, 1, `只出現一次：${n}`)
    assert.ok(out.indexOf(n) < finalAt, `應在最終答覆前：${n}`)
  }
  // 時序：旁白緊貼在其後的工具之前
  assert.ok(out.indexOf("先讓歌跑起來：") < out.indexOf("<tool.invoke music_gen>"))
  assert.ok(out.indexOf("付費通路是活的") < out.indexOf("<tool.invoke skill>"))
  // 最終答覆之後只有它自己的最後一行，然後 turn.done
  assert.ok(out.endsWith("同一支片不用重做。<turn.done>"))
  assert.equal(out.slice(finalAt), FINAL_PART + "<turn.done>")
  // 繁體用戶：全程無繁→簡（「帳號」「現在」原樣）
  assert.ok(out.includes("**阻塞 1・帳號餘額不足**"))
})
