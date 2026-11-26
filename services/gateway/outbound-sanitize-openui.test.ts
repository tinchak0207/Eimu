// OpenUI 裸语句行不被当英文正文压制（2026-10-18）。
// 背景：模型偶尔不套 ```openui 围栏直接输出程序；`form = Form("p", btns, [a, b, c])`
// 无中文且 ≥8 英文词，旧逻辑会整行吞掉，前端只拿到半截程序。
import assert from "node:assert/strict"
import test from "node:test"
import { isEnglishProseLine, stripOutboundFeed } from "./outbound-sanitize"

test("OpenUI 语句行放行，真英文正文仍压制", () => {
  assert.equal(isEnglishProseLine('form = Form("gen_params", submit_buttons, [field_one, field_two, field_three])'), false)
  assert.equal(isEnglishProseLine("root = Card([header, form, quick_actions, footer_note, extra_one])"), false)
  assert.equal(isEnglishProseLine('picks = [Button("Realistic photo style", @ToAssistant("use realistic photo style"))]'), false)
  assert.equal(isEnglishProseLine("Let me check the chapter outline before writing the next scene."), true)
})

test("流式出口：裸 DSL 行原样外发、不记英文压制", () => {
  const st = { pending: "", suppress: false, fence: false, sawEnglish: false }
  const out = stripOutboundFeed(st, 'root = Card([hdr, form])\nform = Form("gen_params", btns, [field_one, field_two, field_three])\n')
  assert.match(out, /form = Form\("gen_params"/)
  assert.equal(st.sawEnglish, false)
})
