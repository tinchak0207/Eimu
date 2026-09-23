// steer-ledger-db.test.ts —— REQ-D2b（持久命令身份＋uncertain＋tombstone）的真實行為驗收。
//
// 為什麼是 bun 而不是 tsx：本檔要載真 SQLite（bun:sqlite）與真受理端——tsx/node 載不動
// bun:sqlite（實測 MODULE_NOT_FOUND），只能讀原始碼做守門件。而守門件不算「已驗證」
// （AGENTS.md 09-23 TG-02），所以這條鏈路在 bun 下用**真 DB + 真 Request/Response** 打。
//
// 每一步都是真輸入 → 真輸出；關鍵判據用獨立 oracle：
//   * payload_hash 對照 GNU coreutils 的 sha256sum（不是拿本專案函數跟自己比）；
//   * 「沒有重複投遞」的判據是**投遞器被呼叫的次數**（真副作用計數）與
//     **上游 question 回覆被呼叫的次數**，不是源碼字串。
//
// 跑法（必帶超時）：
//   timeout 240 bun run deploy-staging/gateway/steer-ledger-db.test.ts
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionState } from "./types-gateway.ts"

// ── 0. 先定 DB 路徑再 import（persistence 在載入時就 initPersistence 並讀這個環境變數）──
const dir = mkdtempSync(join(tmpdir(), "d2b-steer-"))
process.env.SESSIONS_DB_PATH = join(dir, "sessions.db")

const persistence = await import("./persistence.ts")
const { createSteerLedger, freezeSteerPayload } = await import("./steer-identity.ts")
const { steerLedger, recoverSteerCommandsOnRevive } = await import("./steer-ledger-gw.ts")
const { handleSteer, setSteerTurnDeliverer, flushPendingSteers } = await import("./steer-gw.ts")
const { sessions, hydrateFromDb } = await import("./sessions-core.ts")

// ── 斷言器（逐條印出，失敗不中斷後續檢查；結尾以 exit code 表態）──
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
function sha256(text: string): string {
  return execFileSync("sha256sum", { input: text, encoding: "utf8" }).split(/\s+/)[0]
}
const KEY = "sk-d2b-test"

/** 最小可用會話狀態（欄位齊全到 emitToSession / handleSteer 跑得動）。 */
function makeState(id: string, turnGen = 1): SessionState {
  return {
    sessionId: id,
    apiKey: KEY,
    opencodeSessionId: `oc_${id}`,
    clients: new Set(),
    pendingConfirms: new Map(),
    pendingQuestions: new Map(),
    resolvedConfirms: new Map(),
    eventCounter: 0,
    replayBuffer: [],
    lastActivityAt: Date.now(),
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
    lastTurnActiveAt: Date.now(), // 回合在跑（steer 受理閘的前提）
    turnGen,
  } as unknown as SessionState
}

function steerReq(sessionId: string, body: Record<string, unknown>): Request {
  return new Request(`http://gateway.local/agent/v1/sessions/${sessionId}/steer`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

/** 讀回端：另開一個 ledger 實例（同一條持久通道），證明「落地」不是記憶體幻覺。 */
const reader = createSteerLedger(persistence.steerCommandStore)

const delivered: string[] = []
setSteerTurnDeliverer(async (_state, text) => {
  delivered.push(text)
  return true
})

// ═══════════ ① 身份持久化：投遞前落地、可讀回、hash 可被獨立工具複算 ═══════════
console.log("\n[1] 身份持久化（投遞之前落地 → 讀回 → 獨立複算 hash）")
const sid = "ses_d2b_1"
const state = makeState(sid)
sessions.set(sid, state)
persistence.saveSession(state)

const res1 = await handleSteer(KEY, sid, steerReq(sid, { content: "  先改成   冷色调 ", steer_id: "steer-d2b-1" }))
const body1 = (await res1.json()) as Record<string, unknown>
check("受理回 200 且 status=queued", res1.status === 200 && body1.status === "queued", `status=${res1.status} body=${JSON.stringify(body1)}`)

const row1 = reader.get("steer-d2b-1")
check("投遞之前身份已落地且可被另一實例讀回", row1 !== null && row1.state === "queued")
check("排隊階段尚未投遞（dispatched_at 空）", row1?.dispatchedAt === undefined)
check("尚未產生任何投遞", delivered.length === 0, `delivered=${delivered.length}`)
// 獨立 oracle：DB 裡凍結的 canonical payload 用 sha256sum 複算，必須等於存的 hash。
const externalHash = sha256(row1?.payload ?? "")
check("payload_hash 等於獨立 sha256sum(凍結 payload)", row1?.payloadHash === externalHash, `${row1?.payloadHash} vs ${externalHash}`)
const frozen = JSON.parse(row1?.payload ?? "{}") as Record<string, unknown>
check("凍結 payload 含 content（已歸一化）", frozen.content === "先改成 冷色调", String(frozen.content))
check("凍結 payload 含 session 標識", frozen.session_id === sid)
check("凍結 payload 含 turn 標識", frozen.turn_gen === 1)
check(
  "hash 與純核心對同輸入的結果一致",
  row1?.payloadHash === freezeSteerPayload({ steerId: "steer-d2b-1", sessionId: sid, opencodeSessionId: `oc_${sid}`, turnGen: 1, content: "先改成 冷色调" }).payloadHash,
)
check("隊列裡確有這條（受理與身份同一條）", (state.pendingSteers ?? []).map((s) => s.id).join(",") === "steer-d2b-1")

// ═══════════ ② 確認到達：dispatched → applied（終態 tombstone）═══════════
console.log("\n[2] 隊列腿投遞：確認到達 → applied 終態")
await flushPendingSteers(state)
check("回合收尾投遞一次", delivered.length === 1, `delivered=${delivered.length}`)
check("投遞內容帶來歷標頭（模型不會重新開場）", delivered[0]?.includes("回合中追加指引") === true)
const row1b = reader.get("steer-d2b-1")
check("確認後落終態 applied", row1b?.state === "applied", `state=${row1b?.state}`)
check("終態有落地時刻", typeof row1b?.settledAt === "number")

// ═══════════ ③ 投遞後未確認 → 進程重啟 → 不得重送、狀態 uncertain ═══════════
console.log("\n[3] 投遞後未確認 → 進程重啟 → 不得重送 + uncertain")
const res2 = await handleSteer(KEY, sid, steerReq(sid, { content: "再把节奏放慢一点", steer_id: "steer-d2b-2" }))
const body2 = (await res2.json()) as Record<string, unknown>
check("第二條受理 queued", res2.status === 200 && body2.status === "queued")
// 投遞那一格：投遞已發出、還沒等到確認（flushPendingSteers 內同一格）。
steerLedger.markDispatched("steer-d2b-2", Date.now())
check("投遞已發出（dispatched_at 落地）", reader.get("steer-d2b-2")?.state === "dispatched")
const deliveriesBeforeRestart = delivered.length

// ── 重啟：內存全清 + DB 交回最後一次防抖落盤（真實 SIGTERM 行為）＋ 重新開啟連線 ──
sessions.clear()
persistence.saveSession({ ...state, lastTurnActiveAt: 0, pendingSteers: [] } as SessionState)
persistence.initPersistence() // 新進程＝新連線（同一個 sessions.db 檔）

const revived = hydrateFromDb(sid) // 前端下一次請求／上游事件 fan-out 走的就是這條
check("會話從 DB 恢復成功", revived !== null)
const row2 = reader.get("steer-d2b-2")
check("恢復後狀態 = uncertain（不得是 applied/queued）", row2?.state === "uncertain", `state=${row2?.state}`)
check("uncertain 的原因 = restart_unconfirmed", row2?.reason === "restart_unconfirmed")
check("重啟沒有造成任何重送", delivered.length === deliveriesBeforeRestart, `${delivered.length} vs ${deliveriesBeforeRestart}`)
check("volatile 隊列沒有復活（不替不存在的回合重開一輪）", (revived?.pendingSteers ?? []).length === 0)
const replayedFrames = (revived?.replayBuffer ?? []).map((f) => new TextDecoder().decode(f.frame))
check(
  "恢復上報誠實狀態幀（UI 顯示「未確認·未重送」的來源）",
  replayedFrames.some((s) => s.includes("steer.status") && s.includes("steer-d2b-2") && s.includes('"status":"uncertain"')),
  replayedFrames.filter((s) => s.includes("steer.status")).join(" | ").slice(0, 300),
)

// ── 重連後同一 id 重放：可辨識拒絕 + 真副作用零增量 ──
const res3 = await handleSteer(KEY, sid, steerReq(sid, { content: "再把节奏放慢一点", steer_id: "steer-d2b-2" }))
const body3 = (await res3.json()) as { error?: { code?: string }; status?: string }
check("同 id 重放被拒（HTTP 409，不得靜默接受成第二次投遞）", res3.status === 409, `status=${res3.status}`)
check("拒絕可辨識：code=steer_replay_settled", body3.error?.code === "steer_replay_settled", JSON.stringify(body3))
check("拒絕回體帶既有命令真實狀態 uncertain", body3.status === "uncertain", String(body3.status))
check("重放沒有造成第二次投遞（真投遞器計數不變）", delivered.length === deliveriesBeforeRestart)
check("uncertain 未被重放改寫", reader.get("steer-d2b-2")?.state === "uncertain")

// ═══════════ ④ 終態凍結：遲到幀改不動 uncertain ═══════════
console.log("\n[4] 終態凍結（uncertain 不得被遲到幀改寫）")
const lateSettle = steerLedger.settle("steer-d2b-2", "applied", Date.now())
check("對 uncertain 補 applied 被拒", lateSettle.kind === "refused" && (lateSettle as { reason?: string }).reason === "terminal")
check("DB 仍是 uncertain", reader.get("steer-d2b-2")?.state === "uncertain")
const lateReplay = steerLedger.begin({ steerId: "steer-d2b-2", sessionId: sid, ownerKey: KEY, content: "再把节奏放慢一点", opencodeSessionId: `oc_${sid}`, turnGen: 1, now: Date.now() })
check("重放不得把 uncertain 打回 queued", lateReplay.kind === "rejected")
check("DB 仍是 uncertain（重放後）", reader.get("steer-d2b-2")?.state === "uncertain")

// ═══════════ ⑤ tombstone 不隨 clear / 重啟刪除 ═══════════
console.log("\n[5] tombstone 不隨 clear / 重啟刪除")
persistence.deleteSessionRow(sid) // clear / 刪會話
persistence.sweepStaleRows(0) // 陳舊清掃（maxIdleMs=0 → 掃光所有 row）
check("clear 之後 tombstone 仍在", reader.get("steer-d2b-2")?.state === "uncertain")
check("clear 之後已終態的 applied 記錄仍在", reader.get("steer-d2b-1")?.state === "applied")
// 會話重建（同 id）——tombstone 不得因此失效。
const resurrected = makeState(sid)
sessions.set(sid, resurrected)
persistence.saveSession({ ...resurrected, lastTurnActiveAt: 0 } as SessionState)
const res4 = await handleSteer(KEY, sid, steerReq(sid, { content: "再把节奏放慢一点", steer_id: "steer-d2b-2" }))
const body4 = (await res4.json()) as { error?: { code?: string } }
check("clear + 重建會話後同一 id 仍被拒", res4.status === 409 && body4.error?.code === "steer_replay_settled", JSON.stringify(body4))
const res4b = await handleSteer(KEY, sid, steerReq(sid, { content: "先改成 冷色调", steer_id: "steer-d2b-1" }))
const body4b = (await res4b.json()) as { error?: { code?: string }; status?: string }
check("已 applied 的 id 重放也被拒且回報 applied", res4b.status === 409 && body4b.error?.code === "steer_replay_settled" && body4b.status === "applied", JSON.stringify(body4b))

// ═══════════ ⑥ 第二條投遞腿（question 斷點注入）同樣帶身份與 tombstone ═══════════
console.log("\n[6] question 斷點注入腿：身份 + tombstone 同樣生效（含重連後不得重放）")
const sid2 = "ses_d2b_q"
const qstate = makeState(sid2)
qstate.pendingQuestions.set("que_1", { requestId: "que_1", callId: "call_1", questions: [{ question: "要继续吗", options: [] }] })
sessions.set(sid2, qstate)
persistence.saveSession({ ...qstate, lastTurnActiveAt: 0 } as SessionState)

let questionReplies = 0
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown) => {
  if (String(input).includes("/reply")) questionReplies += 1
  return new Response("{}", { status: 200 })
}) as unknown as typeof fetch

const resQ = await handleSteer(KEY, sid2, steerReq(sid2, { content: "先改成冷色调", steer_id: "steer-d2b-q1" }))
const bodyQ = (await resQ.json()) as Record<string, unknown>
check("注入腿回 200 injected", resQ.status === 200 && bodyQ.status === "injected", `status=${resQ.status} body=${JSON.stringify(bodyQ)}`)
check("注入＝往上游回灌一次答覆", questionReplies === 1, `replies=${questionReplies}`)
check("注入腿的身份同樣先落地並落終態 injected", reader.get("steer-d2b-q1")?.state === "injected")
check("注入腿也記了 dispatched 時刻（投遞發生過的證據）", typeof reader.get("steer-d2b-q1")?.dispatchedAt === "number")

// 重連／重啟後同一 id 重放：不得再注入一次（否則模型收到兩次而 View 只顯示一次）。
sessions.clear()
persistence.initPersistence()
const qstate2 = makeState(sid2)
qstate2.pendingQuestions.set("que_2", { requestId: "que_2", callId: "call_2", questions: [{ question: "要继续吗", options: [] }] })
sessions.set(sid2, qstate2)
const resQ2 = await handleSteer(KEY, sid2, steerReq(sid2, { content: "先改成冷色调", steer_id: "steer-d2b-q1" }))
const bodyQ2 = (await resQ2.json()) as { error?: { code?: string }; status?: string }
check("重放被拒（不再注入第二次）", resQ2.status === 409 && bodyQ2.error?.code === "steer_replay_settled", JSON.stringify(bodyQ2))
check("重放拒絕回報既有終態 injected", bodyQ2.status === "injected", String(bodyQ2.status))
check("上游只被回灌過一次（真副作用計數＝模型不會收到兩次）", questionReplies === 1, `replies=${questionReplies}`)
check("斷點仍在（注入腿確實有可用斷點，不是空跑）", qstate2.pendingQuestions.size === 1)
globalThis.fetch = realFetch

// ═══════════ ⑦ 迴歸保護：無 steer 的會話零動作 ═══════════
console.log("\n[7] 迴歸：沒有 steer 記錄的會話零動作")
const sid3 = "ses_d2b_clean"
const clean = makeState(sid3)
sessions.set(sid3, clean)
const framesForClean = recoverSteerCommandsOnRevive(clean)
check("無記錄 → 恢復掃描零幀", framesForClean.length === 0)
check("無記錄 → 隊列仍空（零動作）", (clean.pendingSteers ?? []).length === 0)

// ═══════════ ⑧ D-6：系統中止窗口（空轉斷路器）照常受理，且不得說假話 ═══════════
//
// 真輸入（真 Request）→ 真輸出（真 Response + 真 SQLite + 真排隊腿 + 真投遞器副作用）。
// 判據：*回應狀態與語義*（不是源碼字串）、上游 /reply 是否被誤打、投遞器是否真的收到這條。
console.log("\n[8] D-6 系統中止窗口：照常受理（不得回「已中止、不會生效」的假話）")
const sid4 = "ses_d6_system"
const sysState = makeState(sid4)
sysState.turnAborted = true
sysState.turnAbortSource = "system" // 空轉斷路器：同輪續跑，指引刻意保留
// 中止輪殘留的 question 卡（D2-1a 的實錘場景：此刻注入＝把引導語當答覆灌進已中止的輪）。
sysState.pendingQuestions.set("que_stale", { requestId: "que_stale", callId: "call_stale", questions: [{ question: "要继续吗", options: [] }] })
sessions.set(sid4, sysState)

let staleReplies = 0
const fetchBeforeD6 = globalThis.fetch
globalThis.fetch = (async (input: unknown) => {
  if (String(input).includes("/reply")) staleReplies += 1
  return new Response("{}", { status: 200 })
}) as unknown as typeof fetch

const deliveredBeforeD6 = delivered.length
const resSys = await handleSteer(KEY, sid4, steerReq(sid4, { content: "把结尾改成暖色", steer_id: "steer-d6-1" }))
const bodySys = (await resSys.json()) as Record<string, unknown>
check(
  "系統中止窗口內 steer：不再回「已中止、不會生效」（200 而非 409 turn_aborted）",
  resSys.status === 200 && bodySys.status === "queued",
  `status=${resSys.status} body=${JSON.stringify(bodySys)}`,
)
check("回應語義誠實：不宣稱本回合內生效（applied_in_turn=false）", bodySys.applied_in_turn === false)
check("指引確實進了隊列（受理＝保留，不是丟掉）", (sysState.pendingSteers ?? []).map((s) => s.id).join(",") === "steer-d6-1")
check("身份已落地（受理就一定有身份，重放防護不因窗口而鬆）", reader.get("steer-d6-1")?.state === "queued")
check("中止輪殘留的 question 卡沒被當成答覆灌回去（/reply 零次）", staleReplies === 0, `replies=${staleReplies}`)
check("殘留斷點沒有被本請求消耗", sysState.pendingQuestions.size === 1)
globalThis.fetch = fetchBeforeD6

// 語義閉環：系統中止不是用戶停止 → 收尾照常投遞（這條指引不會消失）。
await flushPendingSteers(sysState)
check("營運閉環：系統中止後收尾照常投遞這條指引", delivered.length === deliveredBeforeD6 + 1, `delivered=${delivered.length}`)
check("投遞內容就是用戶那句話", delivered[delivered.length - 1]?.includes("把结尾改成暖色") === true)
check("投遞後落終態 applied", reader.get("steer-d6-1")?.state === "applied", String(reader.get("steer-d6-1")?.state))

// 對照組（不得放寬）：用戶停止窗口仍然一律拒，且不落地任何身份、不進隊列。
console.log("\n[8b] 用戶停止窗口：仍然一律拒（D2-1a 保護不得被放寬）")
const sid5 = "ses_d6_user"
const userState = makeState(sid5)
userState.turnAborted = true
userState.turnAbortSource = "user"
sessions.set(sid5, userState)
const resUser = await handleSteer(KEY, sid5, steerReq(sid5, { content: "把结尾改成暖色", steer_id: "steer-d6-2" }))
const bodyUser = (await resUser.json()) as { error?: { message?: string; code?: string } }
check("用戶停止窗口：回 409", resUser.status === 409, `status=${resUser.status}`)
check("拒絕碼可辨識 = turn_aborted", bodyUser.error?.code === "turn_aborted", JSON.stringify(bodyUser))
check(
  "文案講的是用戶停止（不是系統中止的假話）",
  bodyUser.error?.message?.includes("用户停止") === true && bodyUser.error?.message?.includes("不会再生效") === true,
  String(bodyUser.error?.message),
)
check("用戶停止窗口零落地（不留身份、不進隊列）", reader.get("steer-d6-2") === null && (userState.pendingSteers ?? []).length === 0)

// ═══════════ ⑨ D-7：缺 steer_id 一律 fail-closed（網關不自鑄身份）═══════════
console.log("\n[9] D-7 fail-closed：缺 id 不得自鑄；同 content 無 id 不得長出兩顆獨立命令")
const sid6 = "ses_d7_noid"
const noIdState = makeState(sid6)
sessions.set(sid6, noIdState)
const deliveredBeforeD7 = delivered.length

const resNoId = await handleSteer(KEY, sid6, steerReq(sid6, { content: "没有带 id 的指引" }))
const bodyNoId = (await resNoId.json()) as { error?: { code?: string; message?: string } }
check("缺 steer_id：可辨識錯誤（HTTP 400）", resNoId.status === 400, `status=${resNoId.status}`)
check("錯誤碼 = steer_id_required", bodyNoId.error?.code === "steer_id_required", JSON.stringify(bodyNoId))

const resBadId = await handleSteer(KEY, sid6, steerReq(sid6, { content: "非法 id 的指引", steer_id: "steer/../x" }))
const bodyBadId = (await resBadId.json()) as { error?: { code?: string } }
check("非法 steer_id：可辨識錯誤（不靜默改鑄）", resBadId.status === 400 && bodyBadId.error?.code === "steer_id_invalid", JSON.stringify(bodyBadId))

const resNumId = await handleSteer(KEY, sid6, steerReq(sid6, { content: "数字 id 的指引", steer_id: 42 }))
check("型別錯誤的 steer_id 同樣被拒（42 → steer_id_invalid）", resNumId.status === 400)

// 關鍵不變量：同 content 無 id 連送兩次，不得產生兩顆（此處：一顆都不產生＝沒有任何身份被自鑄）。
const resNoId2 = await handleSteer(KEY, sid6, steerReq(sid6, { content: "没有带 id 的指引" }))
const rowsD7 = persistence.loadSteerCommandsForSession(sid6)
check("同 content 無 id 第二次也被拒（不是「第二條新命令」）", resNoId2.status === 400, `status=${resNoId2.status}`)
check("兩次無 id 請求：持久層零命令（網關沒有自鑄任何身份）", rowsD7.length === 0, `rows=${rowsD7.length}`)
check("兩次無 id 請求：隊列仍空、零投遞", (noIdState.pendingSteers ?? []).length === 0 && delivered.length === deliveredBeforeD7)
// 對照組：帶了 id 的正常請求照常受理（fail-closed 沒有誤傷合法客戶端）。
const resOkId = await handleSteer(KEY, sid6, steerReq(sid6, { content: "带了 id 的指引", steer_id: "steer-d7-ok" }))
check("帶合法 id 照常受理（fail-closed 不誤傷）", resOkId.status === 200 && reader.get("steer-d7-ok")?.state === "queued")

// ═══════════ ⑩ D-7b：別名查詢精確比對（含 `_` 的 id 不得誤命中他人）═══════════
console.log("\n[10] D-7b 別名精確比對：id 含 `_`（LIKE 單字元通配）不得誤命中他人")
const sid7 = "ses_d7b_alias"
const aliasState = makeState(sid7)
sessions.set(sid7, aliasState)
// 甲：主 id 在底線位置上是**別的**字元（X）。
const resA = await handleSteer(KEY, sid7, steerReq(sid7, { content: "甲的第一条指引", steer_id: "steer-alias-pXq" }))
check("甲受理 queued", resA.status === 200, `status=${resA.status}`)

// 乙：查 "steer-alias-p_q"——舊版 LIKE 會把 `_` 當通配符命中甲的 "steer-alias-pXq"。
check(
  "查詢含 `_` 的他人 id：不得命中甲的記錄（LIKE 通配會在這裡給出假命中）",
  reader.get("steer-alias-p_q") === null,
  `hit=${JSON.stringify(reader.get("steer-alias-p_q"))}`,
)
const resB = await handleSteer(KEY, sid7, steerReq(sid7, { content: "乙的另一条指引", steer_id: "steer-alias-p_q" }))
const bodyB = (await resB.json()) as { error?: { code?: string }; status?: string }
check(
  "乙帶自己的 id 送達：必須被受理（舊版會冒出一顆與乙無關的假 409）",
  resB.status === 200 && bodyB.status === "queued",
  `status=${resB.status} body=${JSON.stringify(bodyB)}`,
)
check("乙在持久層是獨立的一條（沒有被併到甲身上）", reader.get("steer-alias-p_q")?.steerId === "steer-alias-p_q")

// 正向對照：真正的別名仍然查得到（精確比對不能把別名功能也一起砍掉）。
steerLedger.addAlias("steer-alias-pXq", "steer-alias-z_9")
check("真別名仍命中（精確比對沒有誤傷別名功能）", reader.get("steer-alias-z_9")?.steerId === "steer-alias-pXq")
check("別名位置的單字元變體不得命中（zX9 ≠ z_9）", reader.get("steer-alias-zX9") === null)

// ── 收尾 ──
console.log(`\n結果：${pass} 通過 / ${failures.length} 失敗`)
for (const f of failures) console.log(`  失敗：${f}`)
console.log(`DB 位置：${process.env.SESSIONS_DB_PATH}`)
process.exit(failures.length === 0 ? 0 : 1)
