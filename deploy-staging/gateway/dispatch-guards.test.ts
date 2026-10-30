// H9/M1/M2/M3 派遣守卫（纯逻辑）。跑法：timeout 240 npx tsx --test deploy-staging/gateway/dispatch-guards.test.ts
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { guardExpertContent, musicFirstBlockReason, isReworkSpec, reworkLockDirective } from "./jev-gate.ts"

const dir = new URL(".", import.meta.url).pathname

test("H9 ROUTE_CRITERIA 含 critic/research", () => {
  const src = readFileSync(`${dir}jev-gate.ts`, "utf8")
  assert.match(src, /critic: "审核/)
  assert.match(src, /research: "调研/)
})

test("H9 研究任务填 critic → 降为通用子代理", () => {
  const r = guardExpertContent("调研 2026 日本动漫 OP 的视觉趋势，整理参考资料", "critic")
  assert.equal(r.expertId, "")
  assert.ok(r.reason)
})

test("H9 真审核任务保留 critic", () => {
  assert.equal(guardExpertContent("审核以下分镜稿，给 verdict", "critic").expertId, "critic")
  assert.equal(guardExpertContent("研究结论验收：请审核这份调研报告", "critic").expertId, "critic")
})

test("H9 跨域翻转已移除（2026-10-02 改派废除令）：点名域一律保留", () => {
  // 事故史：「请作曲…」+editor 曾被关键词计数翻成 music——表面词汇不反映工具持有面。
  assert.equal(guardExpertContent("请作曲并写旋律与歌词", "editor").expertId, "editor")
  assert.equal(guardExpertContent("写一段旋律", "editor").expertId, "editor")
  assert.equal(guardExpertContent("作曲、旋律", "music").expertId, "music")
  assert.equal(guardExpertContent("随便", "").expertId, "")
  // 事故原案重放：转存任务点名 video-director，不得被「上传/转存」词汇翻成 editor。
  assert.equal(guardExpertContent("把 S02 渲染结果转存为公网 URL（上传入库）", "video-director").expertId, "video-director")
})

test("刀3 点名域＝最终裁决（routeExpertAuthoritative 不再改派）", async () => {
  const src = readFileSync(`${dir}jev-gate.ts`, "utf8")
  // ROUTE_OVERRIDE 已废除：残留字样只允许出现在事故记录注解里，不得再有改派分支。
  assert.doesNotMatch(src, /ROUTE_OVERRIDE provided=/)
  assert.match(src, /ROUTE_DISSENT provided=/)
  assert.match(src, /if \(provided\) \{[\s\S]*?return \{ expertId: provided, source: "provided" \}/)
})

test("M1 研究模板与 playbook 带『不得填 critic』", () => {
  const t = JSON.parse(readFileSync(`${dir}spec-templates.json`, "utf8")) as Record<string, string>
  assert.match(t.research, /不得填 critic/)
  assert.match(readFileSync(`${dir}expert/orchestrator-dispatch-playbook.md`, "utf8"), /不得填 critic/)
})

test("M2 music 在途 → 依赖音乐的剪辑任务挡下", () => {
  // 2026-10-02 M2 收紧后：需「音乐依赖词」＋「生产动词（剪辑/时间轴/混音…）」才构成依赖。
  const r = musicFirstBlockReason("按音乐节拍剪辑 12 个镜头的分镜", "video-director", { musicInFlight: true, musicDelivered: false })
  assert.match(r ?? "", /music-first/)
})

test("M2 纯提节拍但无生产动词 → 不挡（收紧后语义）", () => {
  assert.equal(musicFirstBlockReason("按音乐节拍设计分镜", "video-director", { musicInFlight: true, musicDelivered: false }), null)
})

test("M2 研究性质且明说不依赖音乐 → 豁免放行", () => {
  const spec = "研究水墨图动剪辑技法与节拍关系，本任务完全不依赖音乐产出。"
  assert.equal(musicFirstBlockReason(spec, "editor", { musicInFlight: false, musicDelivered: false }), null)
})

test("M2 无 music 交付且无音讯档 → 挡；有交付/有音讯档/无依赖 → 放行", () => {
  const dep = "根据音乐节拍剪辑 12 个镜头的分镜"
  assert.ok(musicFirstBlockReason(dep, "video-director", { musicInFlight: false, musicDelivered: false }))
  assert.equal(musicFirstBlockReason(dep, "video-director", { musicInFlight: false, musicDelivered: true }), null)
  assert.equal(musicFirstBlockReason(dep + " 音讯 outputs/song.mp3", "video-director", { musicInFlight: false, musicDelivered: false }), null)
  assert.equal(musicFirstBlockReason("设计角色立绘", "video-director", { musicInFlight: true, musicDelivered: false }), null)
  assert.equal(musicFirstBlockReason("为节拍作曲", "music", { musicInFlight: true, musicDelivered: false }), null)
})

test("M3 返工侦测与内容锁", () => {
  assert.equal(isReworkSpec("返工：只重写时长栏"), true)
  assert.equal(isReworkSpec("设计新角色"), false)
  const d = reworkLockDirective("outputs/subagent/ab12.md")
  assert.match(d, /逐字沿用原稿 outputs\/subagent\/ab12\.md/)
  assert.match(d, /diff/)
  assert.match(reworkLockDirective(""), /原稿路径缺失/)
})

test("subagent.ts 已接线四个守卫", () => {
  const s = readFileSync(`${dir}subagent.ts`, "utf8")
  for (const k of ["guardExpertContent(", "musicFirstBlockReason(", "isReworkSpec(", "reworkLockDirective("]) assert.ok(s.includes(k), k)
})
