// collaborate-gate.test.ts —— 2026-09-24 协作确认闸（剧本批准／资产确认／分镜确认）
// 的真行为验收。为什么是 bun 而不是 tsx：本档要载真 session DB（bun:sqlite）、真
// settings、真 workflowService 与真 settleConfirm——tsx/node 载不动 bun:sqlite。
//
// 守门件不是 oracle（AGENTS.md 09-23 TG-02）：本档每条断言都走**真输入→真输出**——
//   * 真模板展开（shortdrama_visual）→ 真 generate 回圈 → 真 pendingConfirms 注册
//     → 真 settleConfirm 裁决 → 真续跑（节点状态真的从 pending 前进）；
//   * 「全自动不停」是护城河回归断言：preset/auto 两档跑同一支工作流，断言
//     **零 pendingConfirms、零 confirm.request 帧**，且节点照旧开跑；
//   * 判据用真实副作用：SSE 帧（confirm.request / canvas.node.generating /
//     confirm.resolved）＋ workflow 节点状态＋DB 里的 settings 回读。
//
// 跑法（必带超时）：timeout 180 bun run deploy-staging/gateway/collaborate-gate.test.ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { SessionState } from "./types-gateway.ts"

// ── 0. 先定环境再 import：DB 路径 + 平台位址指向不可达埠 ──────────────────
// PLATFORM_BASE 指 127.0.0.1:1：真执行路径（submitWorkflowNode）必然连线失败，
// 测试永不对生产平台发生成请求（零扣费、零上游副作用），但 generate 回圈照常推进
// （canvas.node.generating 帧照发）——这正是「续跑真的动了」的可观测证据。
const dir = mkdtempSync(join(tmpdir(), "collab-gate-"))
process.env.SESSIONS_DB_PATH = join(dir, "sessions.db")
process.env.PLATFORM_BASE = "http://127.0.0.1:1"
process.env.QUOTA_URL = "http://127.0.0.1:1/v1/quota"
process.env.OPENCODE_URL = "http://127.0.0.1:1"
// 看门狗周期降到 800ms：让「停点挂起期间 watchdog 让路」变成可等可断言的真行为。
process.env.TURN_WATCHDOG_MS = "800"

// ── 执行入口：本档需 bun（真 session DB = bun:sqlite，tsx/node 载不动，同
// steer-ledger-db.test.ts 的既有处境）。非 bun 环境下注册一条显式 skip，让
// `npx tsx --test deploy-staging/gateway/*.test.ts` 不会多出一条假失败。
async function runGateChecks(): Promise<void> {
  const persistence = await import("./persistence.ts")
  const { sessions } = await import("./sessions-core.ts")
  const gw = await import("./workflow-gw.ts")
  const { templatePlaceholderContent } = await import("./workflow-templates")
  const { settleConfirm } = await import("./media-internal-routes.ts")

  const { workflowService, workflowGateApprovals, wfGateContinuations, COLLABORATE_GATE_ROLES } = gw

  // ── 断言器（逐条印出；失败不中断，结尾以 exit code 表态）──────────────────
  let pass = 0
  const failures: string[] = []
  function check(label: string, ok: boolean, detail = ""): void {
    if (ok) {
      pass += 1
      console.log(`  ✓ ${label}`)
    } else {
      failures.push(label + (detail ? ` — ${detail}` : ""))
      console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`)
    }
  }

  const DECODER = new TextDecoder()
  type Frame = { name: string; data: Record<string, unknown> }
  /** 真 SSE 帧读回（replayBuffer 是 emitToSession 的唯一出口，前端靠它续传）。 */
  function frames(state: SessionState): Frame[] {
    const out: Frame[] = []
    for (const f of state.replayBuffer as { frame: Uint8Array }[]) {
      const head = DECODER.decode(f.frame.subarray(0, Math.min(f.frame.length, 80)))
      const ev = head.match(/^id: \d+\nevent: ([a-z.]+)\n/)?.[1]
      if (!ev) continue
      const body = DECODER.decode(f.frame)
      const raw = body.slice(body.indexOf("data: ") + 6).trim()
      let data: Record<string, unknown> = {}
      try {
        data = JSON.parse(raw) as Record<string, unknown>
      } catch {
        data = {}
      }
      out.push({ name: ev, data })
    }
    return out
  }
  const named = (state: SessionState, name: string): Frame[] => frames(state).filter((f) => f.name === name)

  function makeState(id: string, apiKey: string): SessionState {
    return {
      sessionId: id,
      apiKey,
      opencodeSessionId: `oc_${id}`,
      clients: new Set(),
      pendingConfirms: new Map(),
      pendingQuestions: new Map(),
      resolvedConfirms: new Map(),
      eventCounter: 0,
      replayBuffer: [],
      lastActivityAt: Date.now(),
      turnTerminalNodes: [],
      partTextEmitted: new Map(),
      partStripState: new Map(),
      announcedUrls: new Set(),
      toolStatusSeen: new Set(),
      toolInvokeSeen: new Set(),
      stepCostLogged: new Set(),
      messageRole: new Map(),
      suppressedParts: new Set(),
      canvasUnitByCall: new Map(),
      canvasUnitByTask: new Map(),
      sessionTasks: new Map(),
      vettingInjected: true,
      profileOnboardingPending: false,
      lastTurnActiveAt: Date.now(),
      turnGen: 1,
    } as unknown as SessionState
  }

  const COLLAB_KEY = "sk-collab-gate-collaborate"
  const PRESET_KEY = "sk-collab-gate-preset"
  const AUTO_KEY = "sk-collab-gate-auto"
  function writeMode(key: string, interaction_mode: string): void {
    persistence.saveUserSettings(key, {
      interrupt_mode: "steer",
      persona: "efficient",
      cost_mode: "balanced",
      interaction_mode,
    } as never)
  }

  const SCRIPT_TEXT = "第1场 夜／咖啡馆：林晚推门，看见霍辞渊。台词：『你来晚了。』"
  const SCRIPT_TEXT_V2 = "第1场 夜／咖啡馆（改）：林晚推门，霍辞渊已经不在。"

  /** 起一条真模板工作流（骨架＋占位内容，与生产 startFast 同路径）。 */
  function startDrama(state: SessionState): string {
    const r = workflowService.startFast("shortdrama_visual", templatePlaceholderContent("shortdrama_visual") as never, state)
    if (!("workflowId" in r)) throw new Error(`startFast failed: ${r.error}`)
    return r.workflowId
  }
  const nodeIdOf = (wfid: string, role: string): string => {
    const wf = workflowService.get(wfid)!
    const n = wf.graph.nodes.find((x: { role: string }) => x.role === role) as { id: string } | undefined
    if (!n) throw new Error(`node role not found: ${role}`)
    return n.id
  }

  // ═══════════ ① 停点定义（决策第 1 条：三个，其余环节自动）═══════════
  console.log("\n[1] 停点定义：三个停点，成片验收/投放物料不在内")
  check("停点＝剧本文档三环（script/cast_card/storyboard）", COLLABORATE_GATE_ROLES.join(",") === "script,cast_card,storyboard", COLLABORATE_GATE_ROLES.join(","))
  check("final_cut（成片验收）不是停点", !COLLABORATE_GATE_ROLES.includes("final_cut"))
  check("promo 不是停点", !COLLABORATE_GATE_ROLES.includes("promo"))

  // ═══════════ ② 协作档：交付物未产出时不挡（门禁不是无条件硬闸）═══════════
  console.log("\n[2] 协作档・占位文案不算交付物（不拿「（待填：…）」当可确认的资产）")
  writeMode(COLLAB_KEY, "collaborate")
  const sCollab = makeState("ses_collab_1", COLLAB_KEY)
  sessions.set(sCollab.sessionId, sCollab)
  const wfCollab = startDrama(sCollab)
  {
    const wf = workflowService.get(wfCollab)!
    const gate = gw.resolveCollaborateGate(wf as Parameters<typeof gw.resolveCollaborateGate>[0])
    check("剧本节点还是占位文案 → 不上门禁（没东西可确认）", gate === null, JSON.stringify(gate))
  }

  // ═══════════ ③ 协作档・资产图出完前先停（真停住）═══════════
  console.log("\n[3] 协作档・剧本填好后：真停住（pendingConfirms 真有注册，且一节点未跑）")
  const scriptNode = nodeIdOf(wfCollab, "script")
  const castCardNode = nodeIdOf(wfCollab, "cast_card")
  workflowService.updateNode(wfCollab, scriptNode, { content: SCRIPT_TEXT })
  const genPaused = await workflowService.generate(wfCollab)
  const wfAfterPause = workflowService.get(wfCollab)!
  check("generate 回非 ok（暂停不是成功）", genPaused.ok === false, JSON.stringify(genPaused))
  check("暂停回执是人话且点名停点", genPaused.status.includes("剧本批准") && genPaused.status.includes("已暂停"), genPaused.status)
  check("workflow 状态＝paused_awaiting_approval", wfAfterPause.status === "paused_awaiting_approval", String(wfAfterPause.status))
  check("pendingConfirms 真的有注册（watchdog 让路的唯一判据）", sCollab.pendingConfirms.size === 1, `size=${sCollab.pendingConfirms.size}`)
  const reqFrames = named(sCollab, "confirm.request")
  check("confirm.request 帧真的发了（前端确认卡靠它）", reqFrames.length === 1, `n=${reqFrames.length}`)
  check("确认卡金额＝0（这是确认交付物，不是扣费）", reqFrames[0]?.data.amount_coins === 0, String(reqFrames[0]?.data.amount_coins))
  check("确认卡文案带停点名", String(reqFrames[0]?.data.description ?? "").includes("剧本批准"), String(reqFrames[0]?.data.description))
  const gateNode = nodeIdOf(wfCollab, "script__gate")
  const gatePatch = named(sCollab, "canvas.node.updated").filter((f) => f.data.node_id === gateNode)
  const gateConfirm = (gatePatch[gatePatch.length - 1]?.data.patch as { gateConfirm?: Record<string, unknown> } | undefined)?.gateConfirm
  check("门禁卡被回写成可操作（gateConfirm pending＋request_id/session_id）", gateConfirm?.status === "pending" && typeof gateConfirm?.request_id === "string" && gateConfirm?.session_id === sCollab.sessionId, JSON.stringify(gateConfirm))
  check("回写落在该停点自己的门禁卡（剧本文档 gate，不是别张卡）", gatePatch.length >= 1 && gateNode.endsWith("script__gate-21"), `${gateNode} n=${gatePatch.length}`)
  check("停住＝资产节点一个都没跑（nodeStatus 仍 pending）", wfAfterPause.nodeStatus[castCardNode] === "pending", String(wfAfterPause.nodeStatus[castCardNode]))
  check("停住＝没有任何 canvas.node.generating 帧", named(sCollab, "canvas.node.generating").length === 0, `n=${named(sCollab, "canvas.node.generating").length}`)
  const gateRequestId = String([...sCollab.pendingConfirms.keys()][0])

  // ═══════════ ④ 驳回：停下等用户指定（不擅自重生成、不花钱）═══════════
  console.log("\n[4] 协作档・驳回＝停在该步（决策 4）")
  settleConfirm(sCollab, gateRequestId, "denied")
  check("驳回后 pendingConfirms 清空（不留死卡）", sCollab.pendingConfirms.size === 0, `size=${sCollab.pendingConfirms.size}`)
  check("驳回后 confirm.resolved 帧＝approved:false", named(sCollab, "confirm.resolved").some((f) => f.data.request_id === gateRequestId && f.data.approved === false))
  check("驳回不记批准（门禁仍待批准）", (workflowGateApprovals.get(wfCollab)?.get("script") ?? "") === "")
  check("驳回后 workflow 仍停著（不擅自续跑）", workflowService.get(wfCollab)!.status === "paused_awaiting_approval", String(workflowService.get(wfCollab)!.status))
  check("驳回后未消费任何节点（零花钱）", named(sCollab, "canvas.node.generating").length === 0)

  // ═══════════ ⑤ 重新 generate（用户改好后）→ 批准 → 真续跑 ═══════════
  console.log("\n[5] 协作档・批准 → 真续跑（后续节点状态前进）")
  const genPaused2 = await workflowService.generate(wfCollab)
  check("再次 generate 仍停在剧本批准（未批准不放行）", genPaused2.ok === false && genPaused2.status.includes("剧本批准"), JSON.stringify(genPaused2))
  const req2 = String([...sCollab.pendingConfirms.keys()][0])
  check("重新弹卡（新 request_id，不是死卡）", req2 !== gateRequestId && req2.startsWith("wfgate_"), req2)
  const beforeFrames = named(sCollab, "canvas.node.generating").length
  settleConfirm(sCollab, req2, "approved")
  check("批准后 pendingConfirms 清空", sCollab.pendingConfirms.size === 0, `size=${sCollab.pendingConfirms.size}`)
  check("批准记交付物指纹（不是布林：交付物换了指纹就失效）", (workflowGateApprovals.get(wfCollab)?.get("script") ?? "").length === 16, String(workflowGateApprovals.get(wfCollab)?.get("script")))
  check("续跑注册表已解（不留残留，否则之后永远弹不出卡）", wfGateContinuations.size === 0, `size=${wfGateContinuations.size}`)
  // 续跑是 fire-and-forget（runWfGenerate）；事件驱动地等 canvas.node.generating 出现。
  let started = false
  for (let i = 0; i < 60 && !started; i++) {
    await new Promise((r) => setTimeout(r, 100))
    started = named(sCollab, "canvas.node.generating").some((f) => f.data.node_id === castCardNode)
  }
  check("批准后资产节点真的开跑（generating 帧，状态前进）", started, `before=${beforeFrames} now=${named(sCollab, "canvas.node.generating").length}`)
  check("资产节点已离开 paused（workflow 重新 running）", workflowService.get(wfCollab)!.status !== "paused_awaiting_approval", String(workflowService.get(wfCollab)!.status))

  // ═══════════ ⑥ 回跳改上游 → 该停点重新待批准（决策 15 的闸侧语义）═══════════
  console.log("\n[6] 回跳改剧本 → 旧批准对新交付物失效（重新待批准）")
  const wfNow = workflowService.get(wfCollab)!
  check("已批准且交付物未变 → 不再挡（同一交付物只问一次）", gw.resolveCollaborateGate(wfNow as Parameters<typeof gw.resolveCollaborateGate>[0])?.role !== "script")
  workflowService.updateNode(wfCollab, scriptNode, { content: SCRIPT_TEXT_V2 })
  const afterEdit = gw.resolveCollaborateGate(workflowService.get(wfCollab)! as Parameters<typeof gw.resolveCollaborateGate>[0])
  check("改了剧本内容 → 剧本停点重新待批准（指纹变）", afterEdit?.role === "script", JSON.stringify(afterEdit))
  check("回跳同时作废下游（网关既有 BFS：资产节点被重置 pending）", workflowService.get(wfCollab)!.nodeStatus[castCardNode] === "pending", String(workflowService.get(wfCollab)!.nodeStatus[castCardNode]))

  // ═══════════ ⑦ 护城河回归：预设档不停、零新增阻塞 ═══════════
  console.log("\n[7] 全自动护城河・preset：不停、零 confirm、一路跑")
  writeMode(PRESET_KEY, "preset")
  const sPreset = makeState("ses_collab_preset", PRESET_KEY)
  sessions.set(sPreset.sessionId, sPreset)
  const wfPreset = startDrama(sPreset)
  workflowService.updateNode(wfPreset, nodeIdOf(wfPreset, "script"), { content: SCRIPT_TEXT })
  const presetRun = await workflowService.generate(wfPreset)
  check("preset 不被停点拦（回执不含停点字样）", !presetRun.status.includes("剧本批准") && !presetRun.status.includes("已暂停"), JSON.stringify(presetRun))
  check("preset 零 pendingConfirms 注册", sPreset.pendingConfirms.size === 0, `size=${sPreset.pendingConfirms.size}`)
  check("preset 零 confirm.request 帧（不新增任何阻塞）", named(sPreset, "confirm.request").length === 0, `n=${named(sPreset, "confirm.request").length}`)
  check("preset 资产节点照旧开跑（没有被闸挡住）", named(sPreset, "canvas.node.generating").some((f) => f.data.node_id === nodeIdOf(wfPreset, "cast_card")), `n=${named(sPreset, "canvas.node.generating").length}`)
  check("preset workflow 状态不是 paused_awaiting_approval", workflowService.get(wfPreset)!.status !== "paused_awaiting_approval", String(workflowService.get(wfPreset)!.status))

  // ═══════════ ⑧ 护城河回归：自动档同上 ═══════════
  console.log("\n[8] 全自动护城河・auto：不停、零 confirm、一路跑")
  writeMode(AUTO_KEY, "auto")
  const sAuto = makeState("ses_collab_auto", AUTO_KEY)
  sessions.set(sAuto.sessionId, sAuto)
  const wfAuto = startDrama(sAuto)
  workflowService.updateNode(wfAuto, nodeIdOf(wfAuto, "script"), { content: SCRIPT_TEXT })
  const autoRun = await workflowService.generate(wfAuto)
  check("auto 不被停点拦", !autoRun.status.includes("剧本批准") && !autoRun.status.includes("已暂停"), JSON.stringify(autoRun))
  check("auto 零 pendingConfirms 注册", sAuto.pendingConfirms.size === 0, `size=${sAuto.pendingConfirms.size}`)
  check("auto 零 confirm.request 帧", named(sAuto, "confirm.request").length === 0, `n=${named(sAuto, "confirm.request").length}`)
  check("auto 资产节点照旧开跑", named(sAuto, "canvas.node.generating").some((f) => f.data.node_id === nodeIdOf(wfAuto, "cast_card")), `n=${named(sAuto, "canvas.node.generating").length}`)

  // ═══════════ ⑨ watchdog 让路：停点挂起期间不误判死寂（真 timer）═══════════
  console.log("\n[9] watchdog 让路・停点挂起＝合法暂停（真 timer，周期降到 800ms）")
  const { armWatchdogTimer } = await import("./timers-gw.ts")
  const WATCHDOG_ALERT = "处理似乎卡住了"
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  // 正向对照（断言非空集）：没有 confirm 挂起的会话，同一支哨真的会咬。
  const sControl = makeState("ses_collab_watchdog_control", COLLAB_KEY)
  sessions.set(sControl.sessionId, sControl)
  armWatchdogTimer(sControl)
  await sleep(2500)
  const controlAlerts = named(sControl, "turn.status").filter((f) => String(f.data.text ?? "").includes(WATCHDOG_ALERT))
  check("正向对照：无 confirm 挂起 → watchdog 真的告警（证明这个断言不是空集）", controlAlerts.length >= 1, `alerts=${controlAlerts.length}`)
  // 负向（本题）：停点挂起的会话，同一窗口内零告警、confirm 仍在。
  const sWatch = makeState("ses_collab_watchdog_gate", COLLAB_KEY)
  sessions.set(sWatch.sessionId, sWatch)
  const wfWatch = startDrama(sWatch)
  workflowService.updateNode(wfWatch, nodeIdOf(wfWatch, "script"), { content: SCRIPT_TEXT })
  await workflowService.generate(wfWatch)
  check("前置条件：新会话真的停在停点（pendingConfirms=1）", sWatch.pendingConfirms.size === 1, `size=${sWatch.pendingConfirms.size}`)
  armWatchdogTimer(sWatch)
  await sleep(2500)
  const gateAlerts = named(sWatch, "turn.status").filter((f) => String(f.data.text ?? "").includes(WATCHDOG_ALERT))
  check("停点挂起期间 watchdog 零告警（让路，不诬陷后端、不造重复回合）", gateAlerts.length === 0, `alerts=${gateAlerts.length}`)
  check("窗口内 confirm 仍在（哨兵没有清掉任何待决卡）", sWatch.pendingConfirms.size === 1, `size=${sWatch.pendingConfirms.size}`)
  check("窗口内 workflow 仍停在 paused_awaiting_approval", workflowService.get(wfWatch)!.status === "paused_awaiting_approval", String(workflowService.get(wfWatch)!.status))

  // ═══════════ ⑩ 三个停点逐个真的会挡（script → cast_card → storyboard）═══════════
  // 判据链：真人话罪状是「连资产图都不让我们确认」——资产停点必须真的挡，不能只有剧本挡。
  console.log("\n[10] 三个停点逐一实锤：剧本 → 资产 → 分镜（同一条流程依序挡）")
  const sSeq = makeState("ses_collab_three_stops", COLLAB_KEY)
  sessions.set(sSeq.sessionId, sSeq)
  const wfSeq = startDrama(sSeq)
  const seqCast = nodeIdOf(wfSeq, "cast_card")
  const seqBoard = nodeIdOf(wfSeq, "storyboard")
  const roleNow = () => gw.resolveCollaborateGate(workflowService.get(wfSeq)! as Parameters<typeof gw.resolveCollaborateGate>[0])?.role ?? null
  // ① 剧本填好 → 剧本批准
  workflowService.updateNode(wfSeq, nodeIdOf(wfSeq, "script"), { content: SCRIPT_TEXT })
  check("① 剧本产出 → 挡在剧本批准", roleNow() === "script", String(roleNow()))
  // ② 资产图真的产出（走真 updateNode：image 节点带 content ＝ success＋nodeContent）
  workflowService.updateNode(wfSeq, seqCast, { content: "https://cdn.example.com/cast_card.png" })
  check("② 资产图产出（但剧本门禁仍未批准）→ 仍挡剧本批准，不越门", roleNow() === "script", String(roleNow()))
  const seqPause1 = await workflowService.generate(wfSeq)
  check("② generate 真的停在剧本批准（回执点名）", seqPause1.ok === false && seqPause1.status.includes("剧本批准"), JSON.stringify(seqPause1))
  settleConfirm(sSeq, String([...sSeq.pendingConfirms.keys()][0]), "approved")
  check("③ 剧本批准后 → 挡点前进到资产确认（判的是已产出的资产图）", roleNow() === "cast_card", String(roleNow()))
  await new Promise((r) => setTimeout(r, 300)) // 等续跑把那批跑完（本测环境必然失败，状态转终）
  const seqPause2 = await workflowService.generate(wfSeq)
  check("③ generate 停在资产确认（真人话罪状的那一关）", seqPause2.ok === false && seqPause2.status.includes("资产确认"), JSON.stringify(seqPause2))
  check("③ 资产确认卡的文案＝资产停点门禁原文", String(named(sSeq, "confirm.request").at(-1)?.data.description ?? "").includes("资产确认"), String(named(sSeq, "confirm.request").at(-1)?.data.description ?? ""))
  settleConfirm(sSeq, String([...sSeq.pendingConfirms.keys()][0]), "approved")
  await new Promise((r) => setTimeout(r, 300))
  // ④ 分镜填好（agent 的下一步产出）→ 分镜确认
  workflowService.updateNode(wfSeq, seqBoard, { content: "第1场 第1镜：近景／霍辞渊推门而入（2.5s）" })
  const seqPause3 = await workflowService.generate(wfSeq)
  check("④ 分镜产出 → 挡在分镜确认（三个停点全实锤）", seqPause3.ok === false && seqPause3.status.includes("分镜确认"), JSON.stringify(seqPause3))
  check("④ 分镜确认前零新生成（停住＝没往下花钱）", workflowService.get(wfSeq)!.nodeStatus[nodeIdOf(wfSeq, "keyframe")] !== "success", String(workflowService.get(wfSeq)!.nodeStatus[nodeIdOf(wfSeq, "keyframe")]))

  console.log(`\n${pass} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `FAIL: ${f}`).join("\n"))
  }
  // 续跑是 fire-and-forget（真网路重试计时器仍在排队）——测完即收，不等背景收尾。
  process.exit(failures.length ? 1 : 0)
}

if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  // 非 bun：tsx/node 载不动 bun:sqlite → 显式 skip（不是假通过，也不是假失败）。
  test("collaborate-gate（协作确认闸真行为）", { skip: "需 bun 执行：bun run deploy-staging/gateway/collaborate-gate.test.ts" }, () => {})
} else {
  // 不用 top-level await（tsx 走 cjs 转译会直接炸）——fire-and-forget + 自带收尾。
  void runGateChecks().catch((e: unknown) => {
    console.error("[collaborate-gate] 检查过程抛错:", e)
    process.exit(1)
  })
}
