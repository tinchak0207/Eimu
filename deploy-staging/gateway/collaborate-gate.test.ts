// collaborate-gate.test.ts —— 2026-09-24 協作確認閘（劇本批准／資產確認／分鏡確認）
// 的真行為驗收。為什麼是 bun 而不是 tsx：本檔要載真 session DB（bun:sqlite）、真
// settings、真 workflowService 與真 settleConfirm——tsx/node 載不動 bun:sqlite。
//
// 守門件不是 oracle（AGENTS.md 09-23 TG-02）：本檔每條斷言都走**真輸入→真輸出**——
//   * 真模板展開（shortdrama_visual）→ 真 generate 迴圈 → 真 pendingConfirms 註冊
//     → 真 settleConfirm 裁決 → 真續跑（節點狀態真的從 pending 前進）；
//   * 「全自動不停」是護城河回歸斷言：preset/auto 兩檔跑同一支工作流，斷言
//     **零 pendingConfirms、零 confirm.request 幀**，且節點照舊開跑；
//   * 判據用真實副作用：SSE 幀（confirm.request / canvas.node.generating /
//     confirm.resolved）＋ workflow 節點狀態＋DB 裡的 settings 回讀。
//
// 跑法（必帶超時）：timeout 180 bun run deploy-staging/gateway/collaborate-gate.test.ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { SessionState } from "./types-gateway.ts"

// ── 0. 先定環境再 import：DB 路徑 + 平台位址指向不可達埠 ──────────────────
// PLATFORM_BASE 指 127.0.0.1:1：真執行路徑（submitWorkflowNode）必然連線失敗，
// 測試永不對生產平台發生成請求（零扣費、零上游副作用），但 generate 迴圈照常推進
// （canvas.node.generating 幀照發）——這正是「續跑真的動了」的可觀測證據。
const dir = mkdtempSync(join(tmpdir(), "collab-gate-"))
process.env.SESSIONS_DB_PATH = join(dir, "sessions.db")
process.env.PLATFORM_BASE = "http://127.0.0.1:1"
process.env.QUOTA_URL = "http://127.0.0.1:1/v1/quota"
process.env.OPENCODE_URL = "http://127.0.0.1:1"
// 看門狗週期降到 800ms：讓「停點掛起期間 watchdog 讓路」變成可等可斷言的真行為。
process.env.TURN_WATCHDOG_MS = "800"

// ── 執行入口：本檔需 bun（真 session DB = bun:sqlite，tsx/node 載不動，同
// steer-ledger-db.test.ts 的既有處境）。非 bun 環境下註冊一條顯式 skip，讓
// `npx tsx --test deploy-staging/gateway/*.test.ts` 不會多出一條假失敗。
async function runGateChecks(): Promise<void> {
  const persistence = await import("./persistence.ts")
  const { sessions } = await import("./sessions-core.ts")
  const gw = await import("./workflow-gw.ts")
  const { templatePlaceholderContent } = await import("./workflow-templates")
  const { settleConfirm } = await import("./media-internal-routes.ts")

  const { workflowService, workflowGateApprovals, wfGateContinuations, COLLABORATE_GATE_ROLES } = gw

  // ── 斷言器（逐條印出；失敗不中斷，結尾以 exit code 表態）──────────────────
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
  /** 真 SSE 幀讀回（replayBuffer 是 emitToSession 的唯一出口，前端靠它續傳）。 */
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

  const SCRIPT_TEXT = "第1場 夜／咖啡馆：林晚推門，看见霍辞渊。台词：『你来晚了。』"
  const SCRIPT_TEXT_V2 = "第1場 夜／咖啡馆（改）：林晚推門，霍辞渊已经不在。"

  /** 起一條真模板工作流（骨架＋佔位內容，與生產 startFast 同路徑）。 */
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

  // ═══════════ ① 停點定義（決策第 1 條：三個，其餘環節自動）═══════════
  console.log("\n[1] 停點定義：三個停點，成片驗收/投放物料不在內")
  check("停點＝剧本文档三環（script/cast_card/storyboard）", COLLABORATE_GATE_ROLES.join(",") === "script,cast_card,storyboard", COLLABORATE_GATE_ROLES.join(","))
  check("final_cut（成片验收）不是停點", !COLLABORATE_GATE_ROLES.includes("final_cut"))
  check("promo 不是停點", !COLLABORATE_GATE_ROLES.includes("promo"))

  // ═══════════ ② 協作檔：交付物未產出時不擋（門禁不是無條件硬閘）═══════════
  console.log("\n[2] 協作檔・佔位文案不算交付物（不拿「（待填：…）」當可確認的資產）")
  writeMode(COLLAB_KEY, "collaborate")
  const sCollab = makeState("ses_collab_1", COLLAB_KEY)
  sessions.set(sCollab.sessionId, sCollab)
  const wfCollab = startDrama(sCollab)
  {
    const wf = workflowService.get(wfCollab)!
    const gate = gw.resolveCollaborateGate(wf as Parameters<typeof gw.resolveCollaborateGate>[0])
    check("劇本節點還是佔位文案 → 不上門禁（沒東西可確認）", gate === null, JSON.stringify(gate))
  }

  // ═══════════ ③ 協作檔・資產圖出完前先停（真停住）═══════════
  console.log("\n[3] 協作檔・劇本填好後：真停住（pendingConfirms 真有註冊，且一節點未跑）")
  const scriptNode = nodeIdOf(wfCollab, "script")
  const castCardNode = nodeIdOf(wfCollab, "cast_card")
  workflowService.updateNode(wfCollab, scriptNode, { content: SCRIPT_TEXT })
  const genPaused = await workflowService.generate(wfCollab)
  const wfAfterPause = workflowService.get(wfCollab)!
  check("generate 回非 ok（暫停不是成功）", genPaused.ok === false, JSON.stringify(genPaused))
  check("暫停回執是人話且點名停點", genPaused.status.includes("剧本批准") && genPaused.status.includes("已暂停"), genPaused.status)
  check("workflow 狀態＝paused_awaiting_approval", wfAfterPause.status === "paused_awaiting_approval", String(wfAfterPause.status))
  check("pendingConfirms 真的有註冊（watchdog 讓路的唯一判據）", sCollab.pendingConfirms.size === 1, `size=${sCollab.pendingConfirms.size}`)
  const reqFrames = named(sCollab, "confirm.request")
  check("confirm.request 幀真的發了（前端確認卡靠它）", reqFrames.length === 1, `n=${reqFrames.length}`)
  check("確認卡金額＝0（這是確認交付物，不是扣費）", reqFrames[0]?.data.amount_coins === 0, String(reqFrames[0]?.data.amount_coins))
  check("確認卡文案帶停點名", String(reqFrames[0]?.data.description ?? "").includes("剧本批准"), String(reqFrames[0]?.data.description))
  const gateNode = nodeIdOf(wfCollab, "script__gate")
  const gatePatch = named(sCollab, "canvas.node.updated").filter((f) => f.data.node_id === gateNode)
  const gateConfirm = (gatePatch[gatePatch.length - 1]?.data.patch as { gateConfirm?: Record<string, unknown> } | undefined)?.gateConfirm
  check("門禁卡被回寫成可操作（gateConfirm pending＋request_id/session_id）", gateConfirm?.status === "pending" && typeof gateConfirm?.request_id === "string" && gateConfirm?.session_id === sCollab.sessionId, JSON.stringify(gateConfirm))
  check("回寫落在該停點自己的門禁卡（剧本文档 gate，不是別張卡）", gatePatch.length >= 1 && gateNode.endsWith("script__gate-21"), `${gateNode} n=${gatePatch.length}`)
  check("停住＝資產節點一個都沒跑（nodeStatus 仍 pending）", wfAfterPause.nodeStatus[castCardNode] === "pending", String(wfAfterPause.nodeStatus[castCardNode]))
  check("停住＝沒有任何 canvas.node.generating 幀", named(sCollab, "canvas.node.generating").length === 0, `n=${named(sCollab, "canvas.node.generating").length}`)
  const gateRequestId = String([...sCollab.pendingConfirms.keys()][0])

  // ═══════════ ④ 駁回：停下等用戶指定（不擅自重生成、不花錢）═══════════
  console.log("\n[4] 協作檔・駁回＝停在該步（決策 4）")
  settleConfirm(sCollab, gateRequestId, "denied")
  check("駁回後 pendingConfirms 清空（不留死卡）", sCollab.pendingConfirms.size === 0, `size=${sCollab.pendingConfirms.size}`)
  check("駁回後 confirm.resolved 幀＝approved:false", named(sCollab, "confirm.resolved").some((f) => f.data.request_id === gateRequestId && f.data.approved === false))
  check("駁回不記批准（門禁仍待批准）", (workflowGateApprovals.get(wfCollab)?.get("script") ?? "") === "")
  check("駁回後 workflow 仍停著（不擅自續跑）", workflowService.get(wfCollab)!.status === "paused_awaiting_approval", String(workflowService.get(wfCollab)!.status))
  check("駁回後未消費任何節點（零花錢）", named(sCollab, "canvas.node.generating").length === 0)

  // ═══════════ ⑤ 重新 generate（用戶改好後）→ 批准 → 真續跑 ═══════════
  console.log("\n[5] 協作檔・批准 → 真續跑（後續節點狀態前進）")
  const genPaused2 = await workflowService.generate(wfCollab)
  check("再次 generate 仍停在劇本批准（未批准不放行）", genPaused2.ok === false && genPaused2.status.includes("剧本批准"), JSON.stringify(genPaused2))
  const req2 = String([...sCollab.pendingConfirms.keys()][0])
  check("重新彈卡（新 request_id，不是死卡）", req2 !== gateRequestId && req2.startsWith("wfgate_"), req2)
  const beforeFrames = named(sCollab, "canvas.node.generating").length
  settleConfirm(sCollab, req2, "approved")
  check("批准後 pendingConfirms 清空", sCollab.pendingConfirms.size === 0, `size=${sCollab.pendingConfirms.size}`)
  check("批准記交付物指紋（不是布林：交付物換了指紋就失效）", (workflowGateApprovals.get(wfCollab)?.get("script") ?? "").length === 16, String(workflowGateApprovals.get(wfCollab)?.get("script")))
  check("續跑註冊表已解（不留殘留，否則之後永遠彈不出卡）", wfGateContinuations.size === 0, `size=${wfGateContinuations.size}`)
  // 續跑是 fire-and-forget（runWfGenerate）；事件驅動地等 canvas.node.generating 出現。
  let started = false
  for (let i = 0; i < 60 && !started; i++) {
    await new Promise((r) => setTimeout(r, 100))
    started = named(sCollab, "canvas.node.generating").some((f) => f.data.node_id === castCardNode)
  }
  check("批准後資產節點真的開跑（generating 幀，狀態前進）", started, `before=${beforeFrames} now=${named(sCollab, "canvas.node.generating").length}`)
  check("資產節點已離開 paused（workflow 重新 running）", workflowService.get(wfCollab)!.status !== "paused_awaiting_approval", String(workflowService.get(wfCollab)!.status))

  // ═══════════ ⑥ 回跳改上游 → 該停點重新待批准（決策 15 的閘側語義）═══════════
  console.log("\n[6] 回跳改劇本 → 舊批准對新交付物失效（重新待批准）")
  const wfNow = workflowService.get(wfCollab)!
  check("已批准且交付物未變 → 不再擋（同一交付物只問一次）", gw.resolveCollaborateGate(wfNow as Parameters<typeof gw.resolveCollaborateGate>[0])?.role !== "script")
  workflowService.updateNode(wfCollab, scriptNode, { content: SCRIPT_TEXT_V2 })
  const afterEdit = gw.resolveCollaborateGate(workflowService.get(wfCollab)! as Parameters<typeof gw.resolveCollaborateGate>[0])
  check("改了剧本内容 → 劇本停點重新待批准（指紋變）", afterEdit?.role === "script", JSON.stringify(afterEdit))
  check("回跳同時作廢下游（網關既有 BFS：資產節點被重置 pending）", workflowService.get(wfCollab)!.nodeStatus[castCardNode] === "pending", String(workflowService.get(wfCollab)!.nodeStatus[castCardNode]))

  // ═══════════ ⑦ 護城河回歸：預設檔不停、零新增阻塞 ═══════════
  console.log("\n[7] 全自動護城河・preset：不停、零 confirm、一路跑")
  writeMode(PRESET_KEY, "preset")
  const sPreset = makeState("ses_collab_preset", PRESET_KEY)
  sessions.set(sPreset.sessionId, sPreset)
  const wfPreset = startDrama(sPreset)
  workflowService.updateNode(wfPreset, nodeIdOf(wfPreset, "script"), { content: SCRIPT_TEXT })
  const presetRun = await workflowService.generate(wfPreset)
  check("preset 不被停點攔（回執不含停點字樣）", !presetRun.status.includes("剧本批准") && !presetRun.status.includes("已暂停"), JSON.stringify(presetRun))
  check("preset 零 pendingConfirms 註冊", sPreset.pendingConfirms.size === 0, `size=${sPreset.pendingConfirms.size}`)
  check("preset 零 confirm.request 幀（不新增任何阻塞）", named(sPreset, "confirm.request").length === 0, `n=${named(sPreset, "confirm.request").length}`)
  check("preset 資產節點照舊開跑（沒有被閘擋住）", named(sPreset, "canvas.node.generating").some((f) => f.data.node_id === nodeIdOf(wfPreset, "cast_card")), `n=${named(sPreset, "canvas.node.generating").length}`)
  check("preset workflow 狀態不是 paused_awaiting_approval", workflowService.get(wfPreset)!.status !== "paused_awaiting_approval", String(workflowService.get(wfPreset)!.status))

  // ═══════════ ⑧ 護城河回歸：自動檔同上 ═══════════
  console.log("\n[8] 全自動護城河・auto：不停、零 confirm、一路跑")
  writeMode(AUTO_KEY, "auto")
  const sAuto = makeState("ses_collab_auto", AUTO_KEY)
  sessions.set(sAuto.sessionId, sAuto)
  const wfAuto = startDrama(sAuto)
  workflowService.updateNode(wfAuto, nodeIdOf(wfAuto, "script"), { content: SCRIPT_TEXT })
  const autoRun = await workflowService.generate(wfAuto)
  check("auto 不被停點攔", !autoRun.status.includes("剧本批准") && !autoRun.status.includes("已暂停"), JSON.stringify(autoRun))
  check("auto 零 pendingConfirms 註冊", sAuto.pendingConfirms.size === 0, `size=${sAuto.pendingConfirms.size}`)
  check("auto 零 confirm.request 幀", named(sAuto, "confirm.request").length === 0, `n=${named(sAuto, "confirm.request").length}`)
  check("auto 資產節點照舊開跑", named(sAuto, "canvas.node.generating").some((f) => f.data.node_id === nodeIdOf(wfAuto, "cast_card")), `n=${named(sAuto, "canvas.node.generating").length}`)

  // ═══════════ ⑨ watchdog 讓路：停點掛起期間不誤判死寂（真 timer）═══════════
  console.log("\n[9] watchdog 讓路・停點掛起＝合法暫停（真 timer，周期降到 800ms）")
  const { armWatchdogTimer } = await import("./timers-gw.ts")
  const WATCHDOG_ALERT = "处理似乎卡住了"
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  // 正向對照（斷言非空集）：沒有 confirm 掛起的會話，同一支哨真的會咬。
  const sControl = makeState("ses_collab_watchdog_control", COLLAB_KEY)
  sessions.set(sControl.sessionId, sControl)
  armWatchdogTimer(sControl)
  await sleep(2500)
  const controlAlerts = named(sControl, "turn.status").filter((f) => String(f.data.text ?? "").includes(WATCHDOG_ALERT))
  check("正向對照：無 confirm 掛起 → watchdog 真的告警（證明這個斷言不是空集）", controlAlerts.length >= 1, `alerts=${controlAlerts.length}`)
  // 負向（本題）：停點掛起的會話，同一窗口內零告警、confirm 仍在。
  const sWatch = makeState("ses_collab_watchdog_gate", COLLAB_KEY)
  sessions.set(sWatch.sessionId, sWatch)
  const wfWatch = startDrama(sWatch)
  workflowService.updateNode(wfWatch, nodeIdOf(wfWatch, "script"), { content: SCRIPT_TEXT })
  await workflowService.generate(wfWatch)
  check("前置條件：新會話真的停在停點（pendingConfirms=1）", sWatch.pendingConfirms.size === 1, `size=${sWatch.pendingConfirms.size}`)
  armWatchdogTimer(sWatch)
  await sleep(2500)
  const gateAlerts = named(sWatch, "turn.status").filter((f) => String(f.data.text ?? "").includes(WATCHDOG_ALERT))
  check("停點掛起期間 watchdog 零告警（讓路，不誣陷後端、不造重複回合）", gateAlerts.length === 0, `alerts=${gateAlerts.length}`)
  check("窗口內 confirm 仍在（哨兵沒有清掉任何待決卡）", sWatch.pendingConfirms.size === 1, `size=${sWatch.pendingConfirms.size}`)
  check("窗口內 workflow 仍停在 paused_awaiting_approval", workflowService.get(wfWatch)!.status === "paused_awaiting_approval", String(workflowService.get(wfWatch)!.status))

  // ═══════════ ⑩ 三個停點逐個真的會擋（script → cast_card → storyboard）═══════════
  // 判據鏈：真人話罪狀是「連資產圖都不讓我們確認」——資產停點必須真的擋，不能只有劇本擋。
  console.log("\n[10] 三個停點逐一實錘：劇本 → 資產 → 分鏡（同一條流程依序擋）")
  const sSeq = makeState("ses_collab_three_stops", COLLAB_KEY)
  sessions.set(sSeq.sessionId, sSeq)
  const wfSeq = startDrama(sSeq)
  const seqCast = nodeIdOf(wfSeq, "cast_card")
  const seqBoard = nodeIdOf(wfSeq, "storyboard")
  const roleNow = () => gw.resolveCollaborateGate(workflowService.get(wfSeq)! as Parameters<typeof gw.resolveCollaborateGate>[0])?.role ?? null
  // ① 劇本填好 → 劇本批准
  workflowService.updateNode(wfSeq, nodeIdOf(wfSeq, "script"), { content: SCRIPT_TEXT })
  check("① 劇本產出 → 擋在劇本批准", roleNow() === "script", String(roleNow()))
  // ② 資產圖真的產出（走真 updateNode：image 節點帶 content ＝ success＋nodeContent）
  workflowService.updateNode(wfSeq, seqCast, { content: "https://cdn.example.com/cast_card.png" })
  check("② 資產圖產出（但劇本門禁仍未批准）→ 仍擋劇本批准，不越門", roleNow() === "script", String(roleNow()))
  const seqPause1 = await workflowService.generate(wfSeq)
  check("② generate 真的停在劇本批准（回執點名）", seqPause1.ok === false && seqPause1.status.includes("剧本批准"), JSON.stringify(seqPause1))
  settleConfirm(sSeq, String([...sSeq.pendingConfirms.keys()][0]), "approved")
  check("③ 劇本批准後 → 擋點前進到資產確認（判的是已產出的資產圖）", roleNow() === "cast_card", String(roleNow()))
  await new Promise((r) => setTimeout(r, 300)) // 等續跑把那批跑完（本測環境必然失敗，狀態轉終）
  const seqPause2 = await workflowService.generate(wfSeq)
  check("③ generate 停在資產確認（真人話罪狀的那一關）", seqPause2.ok === false && seqPause2.status.includes("资产确认"), JSON.stringify(seqPause2))
  check("③ 資產確認卡的文案＝資產停點門禁原文", String(named(sSeq, "confirm.request").at(-1)?.data.description ?? "").includes("资产确认"), String(named(sSeq, "confirm.request").at(-1)?.data.description ?? ""))
  settleConfirm(sSeq, String([...sSeq.pendingConfirms.keys()][0]), "approved")
  await new Promise((r) => setTimeout(r, 300))
  // ④ 分鏡填好（agent 的下一步產出）→ 分鏡確認
  workflowService.updateNode(wfSeq, seqBoard, { content: "第1場 第1鏡：近景／霍辞渊推門而入（2.5s）" })
  const seqPause3 = await workflowService.generate(wfSeq)
  check("④ 分鏡產出 → 擋在分鏡確認（三個停點全實錘）", seqPause3.ok === false && seqPause3.status.includes("分镜确认"), JSON.stringify(seqPause3))
  check("④ 分鏡確認前零新生成（停住＝沒往下花錢）", workflowService.get(wfSeq)!.nodeStatus[nodeIdOf(wfSeq, "keyframe")] !== "success", String(workflowService.get(wfSeq)!.nodeStatus[nodeIdOf(wfSeq, "keyframe")]))

  console.log(`\n${pass} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `FAIL: ${f}`).join("\n"))
  }
  // 續跑是 fire-and-forget（真網路重試計時器仍在排隊）——測完即收，不等背景收尾。
  process.exit(failures.length ? 1 : 0)
}

if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  // 非 bun：tsx/node 載不動 bun:sqlite → 顯式 skip（不是假通過，也不是假失敗）。
  test("collaborate-gate（協作確認閘真行為）", { skip: "需 bun 執行：bun run deploy-staging/gateway/collaborate-gate.test.ts" }, () => {})
} else {
  // 不用 top-level await（tsx 走 cjs 轉譯會直接炸）——fire-and-forget + 自帶收尾。
  void runGateChecks().catch((e: unknown) => {
    console.error("[collaborate-gate] 檢查過程拋錯:", e)
    process.exit(1)
  })
}
