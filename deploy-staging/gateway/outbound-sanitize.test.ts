/**
 * outbound-sanitize.test.ts — 内部路径／规则代号出站剥离（node:test 纯逻辑）。
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

test("工作区路径与 R 系列代号被剥离（评测实录原句）", () => {
  assert.equal(
    scrubInternalRefs("spec 已落盘 `runs/txj-ep01/audio/BGM-spec-and-failure-report.md`（稍后重投）"),
    "spec 已落盘 （内部存档）（稍后重投）",
  )
  assert.equal(scrubInternalRefs("证据链完整，R7 止损线到点即停"), "证据链完整，止损线到点即停")
  assert.equal(
    scrubInternalRefs("[完整结果已落盘：outputs/subagent/0be1228b-EP01配乐BGM.md（1159 字）]"),
    "[完整结果已落盘：（内部存档）（1159 字）]",
  )
  assert.equal(scrubInternalRefs("产物在 /opt/eimu-harness/workspace/tixia_ep1/storyboard.json 里"), "产物在 （内部存档） 里")
  assert.equal(scrubInternalRefs("清单已落盘 `tixia_ep1/audio/tts_manifest.json`，"), "清单已落盘 （内部存档），")
})

test("交付物 URL 原样保留（含路径段与副档名）", () => {
  const line = "成片：https://store.eimu.dev/agent/v1/audio/tts_mukadd47_ugkpykpi.mp3 ，字幕 https://x.example/runs/a.srt"
  assert.equal(scrubInternalRefs(line), line)
})

test("正常中文句与数字比例不误伤", () => {
  for (const line of ["分镜 10 镜，60 秒，9:16 竖屏", "预算 500 币 / 10 镜", "R 级片不做", "林晚/林柔/顾沉三人同框"]) {
    assert.equal(scrubInternalRefs(line), line)
  }
})

test("出站状态机接线：feed/flush 都走剥离", () => {
  const st = { pending: "", suppress: false, fence: false, sawEnglish: false }
  const out = stripOutboundFeed(st, "已落盘 `runs/a/b.md`\n尾行 R7 铁律") + stripOutboundFlush(st)
  assert.equal(out, "已落盘 （内部存档）\n尾行 铁律")
})

// ── R9-B（2026-09-30）：R5-C 跟随用户书写体 + 日文行不转 ──
const newSt = (t2s?: boolean): PartStripState => ({ pending: "", suppress: false, fence: false, sawEnglish: false, t2s })
const TRAD_USER = "帮我做一支日系百合番的片头曲 MV，要 2026 年的最新风格，歌和画面都要，直接给我成片。" // eval-yuri-op-mv-0930 原句
const SIMP_USER = "帮我做一支日系百合番的片头曲 MV，要 2026 年的最新风格，歌和画面都要，直接给我成片。"

test("R9-B 日文行（含假名）一律不转：评测实录歌词", () => {
  for (const line of ["> この距离が　いまは宝物", "> ねえ　放课后の空を　君と见ていたい", "放课后のチャイムが　空に溶けてゆく"]) {
    assert.equal(t2sLine(line), line)
  }
  // 简体会话（t2s 开）同样不碰日文行，中文行照转
  const st = newSt(true)
  const out = stripOutboundFeed(st, "> この距离が　いまは宝物\n这个时间\n") + stripOutboundFlush(st)
  assert.equal(out, "> この距离が　いまは宝物\n这个时间\n")
  // 中文排版的 ・ 不算假名
  assert.equal(t2sLine("阻塞 1・帐号余额不足"), "阻塞 1・帐号余额不足")
})

test("R9-B 繁体用户：出口改做简→繁矫正（已为繁体者逐字不变，评测原句）", () => {
  assert.equal(detectUserScript(TRAD_USER), "hant")
  assert.equal(shouldT2sForUserScript(detectUserScript(TRAD_USER)), false)
  const st = newSt(false)
  const body = "**阻塞 1・帐号余额不足**\n我分别试了最便宜的通路，**两边都被挡**。\n音乐通路若那时还没恢复"
  assert.equal(stripOutboundFeed(st, body) + stripOutboundFlush(st), body) // 全繁体：S2T 无命中，逐字不变
  // 无判定力的短回覆沿用上次书写体
  assert.equal(resolveUserScript("hant", "A"), "hant")
  assert.equal(resolveUserScript("hant", SIMP_USER), "hans")
  // 繁体共用字（皇后/台北/只）不被误判成简体
  assert.equal(detectUserScript("皇后在台北只待一天"), "unknown")
})

test("R9-B 简体用户：R5-C 行为不变", () => {
  assert.equal(detectUserScript(SIMP_USER), "hans")
  assert.equal(shouldT2sForUserScript("hans"), true)
  assert.equal(shouldT2sForUserScript("unknown"), true) // 未判定＝保 R5-C 旧行为
  const legacy = newSt() // t2s 未设＝旧行为
  const on = newSt(true)
  const text = "这里的时间会来\n## 标题说明\n尾行还没换行"
  const a = stripOutboundFeed(legacy, text) + stripOutboundFlush(legacy)
  const b = stripOutboundFeed(on, text) + stripOutboundFlush(on)
  assert.equal(a, "这里的时间会来\n## 标题说明\n尾行还没换行") // 2026-10-02 补表后 没/换 已覆盖（原锁定的半转换正是繁简混杂根因）
  assert.equal(b, a)
})

// ── R9-B：旁白重播路径重放（eval-yuri-op-mv-0930 SSE 9861–9895）──
// 事件序列取自 evidence/messages.json 的 assistant part 真实顺序（text/tool 交错），
// text part 按 5 字一块切成 delta 喂入；接线与 opencode-event-handler.ts 相同：
// delta 前 flushOtherPartTails(map, pid)、tool pending 时 flushOtherPartTails(map)、
// idle 时 takeTurnEndTail(map)。修前（idle 全量 flush）会把 7 句尾行接在最终答覆后。
const FINAL_PART =
  "**结论先讲：现在交不出成片——两个硬阻塞，我照实报，不糊弄。**\n\n**阻塞 1・帐号余额不足**\n" +
  "   - **C 省钱运镜版**：纯关键帧＋运镜快切 → 约 0.02 币\n\n" +
  "音乐通路若那时还没恢复，我就**先把画面＋剪辑做到成片**，歌一恢复补轨重合成，同一支片不用重做。"
const TURN: Array<["text", string, string] | ["tool", string]> = [
  ["text", "CsaoEg", "我先掌握行情与视频工作流规则，再给你一份完整方案和预算。"],
  ["tool", "read"], ["tool", "image_quote"], ["tool", "video_quote"], ["tool", "read"], ["tool", "asset_search"], ["tool", "quote_bundle"],
  ["text", "5VVsep", "方向我先定好，歌同步开始做。\n\n- **C 省钱运镜版**：纯关键帧 ＋ 运镜快切 → 约 0.02 币\n\n先让歌跑起来："],
  ["tool", "music_gen"],
  ["text", "fsorom", "音乐通路第一轮三条全挂了，我换个节奏再试一次："],
  ["tool", "music_gen"],
  ["text", "fkUPQ3", "**现况先讲清楚**：音乐生成的三条上游通路目前全部不可用。\n\n不空等，画面先开工。我已经把两位女主的定妆锁定卡送去生成（成本≈0.002 币），先把 2026 作画调性定下来："],
  ["tool", "cast_asset_lock"],
  ["text", "4Cte63", "图片通路也回报「余额不足」。我用付费通路测一张确认是不是整帐号的问题："],
  ["tool", "image_generate"], ["tool", "image_generate"], ["tool", "image_generate"],
  ["text", "Jg2AFU", "付费通路是活的（刚才是尺寸参数不对）。用正确尺寸再打一张，确认整条链能跑："],
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
const NARRATION = ["我先掌握行情", "先让歌跑起来：", "我换个节奏再试一次：", "不空等，画面先开工", "我用付费通路测一张", "付费通路是活的"]

test("R9-B 重放 SSE 9861–9895：修前重现过期旁白接在最终答覆之后", () => {
  const out = replayTurn(false, false).join("")
  const finalAt = out.indexOf("**结论先讲")
  for (const n of NARRATION) assert.ok(out.indexOf(n) > finalAt, `修前应重现：${n} 在最终答覆后`)
})

test("R9-B 重放 SSE 9861–9895：修后旁白按时序出现、最终答覆后零过期旁白", () => {
  const frames = replayTurn(false, true)
  const out = frames.join("")
  const finalAt = out.indexOf("**结论先讲")
  assert.ok(finalAt > 0)
  for (const n of NARRATION) {
    assert.equal(out.split(n).length - 1, 1, `只出现一次：${n}`)
    assert.ok(out.indexOf(n) < finalAt, `应在最终答覆前：${n}`)
  }
  // 时序：旁白紧贴在其后的工具之前
  assert.ok(out.indexOf("先让歌跑起来：") < out.indexOf("<tool.invoke music_gen>"))
  assert.ok(out.indexOf("付费通路是活的") < out.indexOf("<tool.invoke skill>"))
  // 最终答覆之后只有它自己的最后一行，然后 turn.done
  assert.ok(out.endsWith("同一支片不用重做。<turn.done>"))
  assert.equal(out.slice(finalAt), FINAL_PART + "<turn.done>")
  // 繁体用户：全程无繁→简（「帐号」「现在」原样）
  assert.ok(out.includes("**阻塞 1・帐号余额不足**"))
})

// ── 2026-10-02 e2e 成片评测：UTF-8 边界乱码（「未��用」）──
import { cleanUtf16Chunk } from "./outbound-sanitize.ts"

function freshSt(): PartStripState {
  return { pending: "", suppress: false, fence: false, sawEnglish: false, t2s: true }
}

test("多位元组字被切断：每块独立解码产生 U+FFFD → 出口剔除，不外发乱码", () => {
  const bytes = Buffer.from("该模型未启用，请换一个。\n", "utf8")
  // 在「启」(3 bytes) 中间切断，并且丢失中间位元组＝上游/传输层切断后各块独立解码的典型后果
  const cut = bytes.indexOf(Buffer.from("启")) + 1
  const a = bytes.subarray(0, cut).toString("utf8") // 「…未」+ �
  const b = bytes.subarray(cut).toString("utf8") // � + 「用，…」
  assert.ok((a + b).includes("�"), "重现：切断确实产生 U+FFFD")
  const st = freshSt()
  const out = stripOutboundFeed(st, a) + stripOutboundFeed(st, b) + stripOutboundFlush(st)
  assert.ok(!out.includes("�"), `出口不得含 U+FFFD，实际：${JSON.stringify(out)}`)
  assert.ok(out.includes("未") && out.includes("用"), "其余正文不丢")
})

test("emoji 代理对跨 chunk：高代理项扣留到下一块，拼回完整字元；孤立代理项被剔除", () => {
  const st = freshSt()
  const e = "😀"
  const out = stripOutboundFeed(st, "好" + e[0]) + stripOutboundFeed(st, e[1] + "的\n") + stripOutboundFlush(st)
  assert.equal(out, "好😀的\n")
  assert.equal(cleanUtf16Chunk({}, "a\uD83Db", true), "ab")
  assert.equal(cleanUtf16Chunk({}, "a\uDE00b", true), "ab")
})

test("繁简：「未启用」「没有」「确认」「现在」在简体会话出口统一转简（原表缺 启/没/确/现/测 等）", () => {
  assert.equal(t2sLine("该模型未启用，没有结果，请确认现在测试"), "该模型未启用，没有结果，请确认现在测试")
  assert.notEqual(detectUserScript("皇后在台北并占布"), "hans") // 新增共用字不误判简体
})

// ── 2026-10-02 S2T：繁体会话出口「简→繁」矫正（繁简混杂兜底）──
test("S2T 矫正：歧义同形字不回转（不把合法繁体改坏），非歧义简体字正常回正", () => {
  const keep = "公里 只有 面对 回来 干涉 志愿 并行" // 里/只/面/回/干/志/并 皆为合法繁体字
  assert.equal(s2tLine(keep), keep)
  assert.equal(s2tLine("这个时间会来对开关门说请谢应该当处动静"), "这个时间会来对开关门说请谢应该当处动静")
  assert.equal(s2tLine("> この距离が　いまは宝物"), "> この距离が　いまは宝物") // 日文行不转
})

// 真实 SSE 片段：eval-2026-op-theme/round2/session.sse 的 message.delta 原文
//（event_id 2675 / 2676 / 8953 / 14117），原文即「繁简混杂」的典型：既有繁体字亦有漏出简体字。
const S2T_REAL_FRAMES = [
  "派三路研究先行，回来整合成原创番剧概念＋信息量片头曲。",
  "已派出 3 路研究（番剧世界观趋势／信息密度 OP 歌曲手法／病毒化 OP 视觉钩子），约 15 分钟内回来后，我会整合成一部 2026 原创番剧概念＋带信息量的片头曲方案。期间你可随时喊停或指定方向（如「要校园/要科幻/要悬疑」），我会把偏好并入后续设计。",
  "首路研究已回（2026 番剧趋势＋3 个原创题材方向，附真实出处）。另两路（OP 歌曲手法、病毒化视觉）还在跑，齐了再整合成完整方案，先收着不打扰。",
  "二路研究已回（病毒化 OP 视觉钩子＋8 个分镜级对位方案），还差 OP 歌曲手法那路，齐了马上整合。",
]
const S2T_REAL_CODE = '```json\n{"model":"gpt-image-2","size":"1024x1024","status":"ok"}\n```'
const S2T_REAL_URL = "成片：https://x.example/视频/出片.mp3"

test("S2T 矫正（真 SSE 验收）：繁体会话下简体字全数回正，英文／JSON／URL 零改动", () => {
  // 逐帧：回转后不得再残留任何可回转的简体字
  for (const fr of S2T_REAL_FRAMES) {
    const converted = s2tLine(fr)
    const leftover = Array.from(converted).filter((c) => S2T_MAP.has(c))
    assert.deepEqual(leftover, [], `帧仍残留简体字：${converted}`)
  }
  const input = S2T_REAL_FRAMES.join("\n") + "\n" + S2T_REAL_CODE + "\n" + S2T_REAL_URL + "\n"
  const st = newSt(false)
  const out = stripOutboundFeed(st, input) + stripOutboundFlush(st)
  // 真正经出口管线的重点样句已全部繁化
  assert.ok(out.includes("回来整合成原创番剧概念＋信息量片头曲"), "第 1 帧已全繁")
  assert.ok(out.includes("约 15 分钟内回来后，我会整合"), "第 2 帧已全繁（含简体『后』回正为『后』）")
  assert.ok(out.includes("3 个原创题材方向") && out.includes("附真实出处"), "第 3 帧已全繁")
  assert.ok(out.includes("马上整合"), "第 4 帧已全繁")
  // 英文代码／JSON 栅栏与 URL 段零改动（URL 内 CJK 亦不动）
  assert.ok(out.includes(S2T_REAL_CODE), "JSON 代码栅栏原样")
  assert.ok(out.includes(S2T_REAL_URL), "URL 段原样（含 CJK）")
})

