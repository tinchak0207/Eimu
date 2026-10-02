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
  s2tLine,
  S2T_MAP,
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
  assert.equal(t2sLine("阻塞 1・帳號餘額不足"), "阻塞 1・帐号余额不足")
})

test("R9-B 繁體用戶：出口改做簡→繁矯正（已為繁體者逐字不變，評測原句）", () => {
  assert.equal(detectUserScript(TRAD_USER), "hant")
  assert.equal(shouldT2sForUserScript(detectUserScript(TRAD_USER)), false)
  const st = newSt(false)
  const body = "**阻塞 1・帳號餘額不足**\n我分別試了最便宜的通路，**兩邊都被擋**。\n音樂通路若那時還沒恢復"
  assert.equal(stripOutboundFeed(st, body) + stripOutboundFlush(st), body) // 全繁體：S2T 無命中，逐字不變
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
  assert.equal(a, "这里的时间会来\n## 标题说明\n尾行还没换行") // 2026-10-02 補表後 沒/換 已覆蓋（原鎖定的半轉換正是繁簡混雜根因）
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

// ── 2026-10-02 e2e 成片評測：UTF-8 邊界亂碼（「未��用」）──
import { cleanUtf16Chunk } from "./outbound-sanitize.ts"

function freshSt(): PartStripState {
  return { pending: "", suppress: false, fence: false, sawEnglish: false, t2s: true }
}

test("多位元組字被切斷：每塊獨立解碼產生 U+FFFD → 出口剔除，不外發亂碼", () => {
  const bytes = Buffer.from("该模型未启用，请换一个。\n", "utf8")
  // 在「启」(3 bytes) 中間切斷，並且丟失中間位元組＝上游/傳輸層切斷後各塊獨立解碼的典型後果
  const cut = bytes.indexOf(Buffer.from("启")) + 1
  const a = bytes.subarray(0, cut).toString("utf8") // 「…未」+ �
  const b = bytes.subarray(cut).toString("utf8") // � + 「用，…」
  assert.ok((a + b).includes("�"), "重現：切斷確實產生 U+FFFD")
  const st = freshSt()
  const out = stripOutboundFeed(st, a) + stripOutboundFeed(st, b) + stripOutboundFlush(st)
  assert.ok(!out.includes("�"), `出口不得含 U+FFFD，實際：${JSON.stringify(out)}`)
  assert.ok(out.includes("未") && out.includes("用"), "其餘正文不丟")
})

test("emoji 代理對跨 chunk：高代理項扣留到下一塊，拼回完整字元；孤立代理項被剔除", () => {
  const st = freshSt()
  const e = "😀"
  const out = stripOutboundFeed(st, "好" + e[0]) + stripOutboundFeed(st, e[1] + "的\n") + stripOutboundFlush(st)
  assert.equal(out, "好😀的\n")
  assert.equal(cleanUtf16Chunk({}, "a\uD83Db", true), "ab")
  assert.equal(cleanUtf16Chunk({}, "a\uDE00b", true), "ab")
})

test("繁簡：「未啟用」「沒有」「確認」「現在」在簡體會話出口統一轉簡（原表缺 啟/沒/確/現/測 等）", () => {
  assert.equal(t2sLine("該模型未啟用，沒有結果，請確認現在測試"), "该模型未启用，没有结果，请确认现在测试")
  assert.notEqual(detectUserScript("皇后在台北并占布"), "hans") // 新增共用字不誤判簡體
})

// ── 2026-10-02 S2T：繁體會話出口「簡→繁」矯正（繁簡混雜兜底）──
test("S2T 矯正：歧義同形字不回轉（不把合法繁體改壞），非歧義簡體字正常回正", () => {
  const keep = "公里 只有 面對 回來 干涉 志願 并行" // 里/只/面/回/干/志/并 皆為合法繁體字
  assert.equal(s2tLine(keep), keep)
  assert.equal(s2tLine("这个时间会来对开关门说请谢应该当处动静"), "這個時間會來對開關門說請謝應該當處動靜")
  assert.equal(s2tLine("> この距離が　いまは宝物"), "> この距離が　いまは宝物") // 日文行不轉
})

// 真實 SSE 片段：eval-2026-op-theme/round2/session.sse 的 message.delta 原文
//（event_id 2675 / 2676 / 8953 / 14117），原文即「繁簡混雜」的典型：既有繁體字亦有漏出簡體字。
const S2T_REAL_FRAMES = [
  "派三路研究先行，回来整合成原創番劇概念＋信息量片头曲。",
  "已派出 3 路研究（番劇世界觀趨勢／信息密度 OP 歌曲手法／病毒化 OP 视觉鉤子），约 15 分钟内回来后，我会整合成一部 2026 原創番劇概念＋帶信息量的片头曲方案。期间你可随时喊停或指定方向（如「要校園/要科幻/要懸疑」），我会把偏好併入后续设计。",
  "首路研究已回（2026 番劇趨勢＋3 个原創题材方向，附真实出处）。另两路（OP 歌曲手法、病毒化视觉）还在跑，齊了再整合成完整方案，先收着不打擾。",
  "二路研究已回（病毒化 OP 视觉鉤子＋8 个分镜级对位方案），还差 OP 歌曲手法那路，齊了马上整合。",
]
const S2T_REAL_CODE = '```json\n{"model":"gpt-image-2","size":"1024x1024","status":"ok"}\n```'
const S2T_REAL_URL = "成片：https://x.example/视频/出片.mp3"

test("S2T 矯正（真 SSE 驗收）：繁體會話下簡體字全數回正，英文／JSON／URL 零改動", () => {
  // 逐幀：回轉後不得再殘留任何可回轉的簡體字
  for (const fr of S2T_REAL_FRAMES) {
    const converted = s2tLine(fr)
    const leftover = Array.from(converted).filter((c) => S2T_MAP.has(c))
    assert.deepEqual(leftover, [], `幀仍殘留簡體字：${converted}`)
  }
  const input = S2T_REAL_FRAMES.join("\n") + "\n" + S2T_REAL_CODE + "\n" + S2T_REAL_URL + "\n"
  const st = newSt(false)
  const out = stripOutboundFeed(st, input) + stripOutboundFlush(st)
  // 真正經出口管線的重點樣句已全部繁化
  assert.ok(out.includes("回來整合成原創番劇概念＋信息量片頭曲"), "第 1 幀已全繁")
  assert.ok(out.includes("約 15 分鐘內回來後，我會整合"), "第 2 幀已全繁（含簡體『后』回正為『後』）")
  assert.ok(out.includes("3 個原創題材方向") && out.includes("附真實出處"), "第 3 幀已全繁")
  assert.ok(out.includes("馬上整合"), "第 4 幀已全繁")
  // 英文代碼／JSON 柵欄與 URL 段零改動（URL 內 CJK 亦不動）
  assert.ok(out.includes(S2T_REAL_CODE), "JSON 代碼柵欄原樣")
  assert.ok(out.includes(S2T_REAL_URL), "URL 段原樣（含 CJK）")
})

