// steer-ledger-db.test.ts —— REQ-D2b（持久命令身份＋uncertain＋tombstone）的真实行为验收。
//
// 为什么是 bun 而不是 tsx：本档要载真 SQLite（bun:sqlite）与真受理端——tsx/node 载不动
// bun:sqlite（实测 MODULE_NOT_FOUND），只能读原始码做守门件。而守门件不算「已验证」
// （AGENTS.md 09-23 TG-02），所以这条链路在 bun 下用**真 DB + 真 Request/Response** 打。
//
// 每一步都是真输入 → 真输出；关键判据用独立 oracle：
//   * payload_hash 对照 GNU coreutils 的 sha256sum（不是拿本专案函数跟自己比）；
//   * 「没有重复投递」的判据是**投递器被呼叫的次数**（真副作用计数）与
//     **上游 question 回覆被呼叫的次数**，不是源码字串。
//
// 跑法（必带超时）：
//   timeout 240 bun run deploy-staging/gateway/steer-ledger-db.test.ts
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionState } from "./types-gateway.ts"

// ── 0. 先定 DB 路径再 import（persistence 在载入时就 initPersistence 并读这个环境变数）──
const dir = mkdtempSync(join(tmpdir(), "d2b-steer-"))
process.env.SESSIONS_DB_PATH = join(dir, "sessions.db")

const persistence = await import("./persistence.ts")
const { createSteerLedger, freezeSteerPayload } = await import("./steer-identity.ts")
const { steerLedger, recoverSteerCommandsOnRevive } = await import("./steer-ledger-gw.ts")
const { handleSteer, setSteerTurnDeliverer, flushPendingSteers } = await import("./steer-gw.ts")
const { sessions, hydrateFromDb } = await import("./sessions-core.ts")

// ── 断言器（逐条印出，失败不中断后续检查；结尾以 exit code 表态）──
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

/** 最小可用会话状态（栏位齐全到 emitToSession / handleSteer 跑得动）。 */
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
    lastTurnActiveAt: Date.now(), // 回合在跑（steer 受理闸的前提）
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

/** 读回端：另开一个 ledger 实例（同一条持久通道），证明「落地」不是记忆体幻觉。 */
const reader = createSteerLedger(persistence.steerCommandStore)

const delivered: string[] = []
setSteerTurnDeliverer(async (_state, text) => {
  delivered.push(text)
  return true
})

// ═══════════ ① 身份持久化：投递前落地、可读回、hash 可被独立工具复算 ═══════════
console.log("\n[1] 身份持久化（投递之前落地 → 读回 → 独立复算 hash）")
const sid = "ses_d2b_1"
const state = makeState(sid)
sessions.set(sid, state)
persistence.saveSession(state)

const res1 = await handleSteer(KEY, sid, steerReq(sid, { content: "  先改成   冷色调 ", steer_id: "steer-d2b-1" }))
const body1 = (await res1.json()) as Record<string, unknown>
check("受理回 200 且 status=queued", res1.status === 200 && body1.status === "queued", `status=${res1.status} body=${JSON.stringify(body1)}`)

const row1 = reader.get("steer-d2b-1")
check("投递之前身份已落地且可被另一实例读回", row1 !== null && row1.state === "queued")
check("排队阶段尚未投递（dispatched_at 空）", row1?.dispatchedAt === undefined)
check("尚未产生任何投递", delivered.length === 0, `delivered=${delivered.length}`)
// 独立 oracle：DB 里冻结的 canonical payload 用 sha256sum 复算，必须等于存的 hash。
const externalHash = sha256(row1?.payload ?? "")
check("payload_hash 等于独立 sha256sum(冻结 payload)", row1?.payloadHash === externalHash, `${row1?.payloadHash} vs ${externalHash}`)
const frozen = JSON.parse(row1?.payload ?? "{}") as Record<string, unknown>
check("冻结 payload 含 content（已归一化）", frozen.content === "先改成 冷色调", String(frozen.content))
check("冻结 payload 含 session 标识", frozen.session_id === sid)
check("冻结 payload 含 turn 标识", frozen.turn_gen === 1)
check(
  "hash 与纯核心对同输入的结果一致",
  row1?.payloadHash === freezeSteerPayload({ steerId: "steer-d2b-1", sessionId: sid, opencodeSessionId: `oc_${sid}`, turnGen: 1, content: "先改成 冷色调" }).payloadHash,
)
check("队列里确有这条（受理与身份同一条）", (state.pendingSteers ?? []).map((s) => s.id).join(",") === "steer-d2b-1")

// ═══════════ ② 确认到达：dispatched → applied（终态 tombstone）═══════════
console.log("\n[2] 队列腿投递：确认到达 → applied 终态")
await flushPendingSteers(state)
check("回合收尾投递一次", delivered.length === 1, `delivered=${delivered.length}`)
check("投递内容带来历标头（模型不会重新开场）", delivered[0]?.includes("回合中追加指引") === true)
const row1b = reader.get("steer-d2b-1")
check("确认后落终态 applied", row1b?.state === "applied", `state=${row1b?.state}`)
check("终态有落地时刻", typeof row1b?.settledAt === "number")

// ═══════════ ③ 投递后未确认 → 进程重启 → 不得重送、状态 uncertain ═══════════
console.log("\n[3] 投递后未确认 → 进程重启 → 不得重送 + uncertain")
const res2 = await handleSteer(KEY, sid, steerReq(sid, { content: "再把节奏放慢一点", steer_id: "steer-d2b-2" }))
const body2 = (await res2.json()) as Record<string, unknown>
check("第二条受理 queued", res2.status === 200 && body2.status === "queued")
// 投递那一格：投递已发出、还没等到确认（flushPendingSteers 内同一格）。
steerLedger.markDispatched("steer-d2b-2", Date.now())
check("投递已发出（dispatched_at 落地）", reader.get("steer-d2b-2")?.state === "dispatched")
const deliveriesBeforeRestart = delivered.length

// ── 重启：内存全清 + DB 交回最后一次防抖落盘（真实 SIGTERM 行为）＋ 重新开启连线 ──
sessions.clear()
persistence.saveSession({ ...state, lastTurnActiveAt: 0, pendingSteers: [] } as SessionState)
persistence.initPersistence() // 新进程＝新连线（同一个 sessions.db 档）

const revived = hydrateFromDb(sid) // 前端下一次请求／上游事件 fan-out 走的就是这条
check("会话从 DB 恢复成功", revived !== null)
const row2 = reader.get("steer-d2b-2")
check("恢复后状态 = uncertain（不得是 applied/queued）", row2?.state === "uncertain", `state=${row2?.state}`)
check("uncertain 的原因 = restart_unconfirmed", row2?.reason === "restart_unconfirmed")
check("重启没有造成任何重送", delivered.length === deliveriesBeforeRestart, `${delivered.length} vs ${deliveriesBeforeRestart}`)
check("volatile 队列没有复活（不替不存在的回合重开一轮）", (revived?.pendingSteers ?? []).length === 0)
const replayedFrames = (revived?.replayBuffer ?? []).map((f) => new TextDecoder().decode(f.frame))
check(
  "恢复上报诚实状态帧（UI 显示「未确认·未重送」的来源）",
  replayedFrames.some((s) => s.includes("steer.status") && s.includes("steer-d2b-2") && s.includes('"status":"uncertain"')),
  replayedFrames.filter((s) => s.includes("steer.status")).join(" | ").slice(0, 300),
)

// ── 重连后同一 id 重放：可辨识拒绝 + 真副作用零增量 ──
const res3 = await handleSteer(KEY, sid, steerReq(sid, { content: "再把节奏放慢一点", steer_id: "steer-d2b-2" }))
const body3 = (await res3.json()) as { error?: { code?: string }; status?: string }
check("同 id 重放被拒（HTTP 409，不得静默接受成第二次投递）", res3.status === 409, `status=${res3.status}`)
check("拒绝可辨识：code=steer_replay_settled", body3.error?.code === "steer_replay_settled", JSON.stringify(body3))
check("拒绝回体带既有命令真实状态 uncertain", body3.status === "uncertain", String(body3.status))
check("重放没有造成第二次投递（真投递器计数不变）", delivered.length === deliveriesBeforeRestart)
check("uncertain 未被重放改写", reader.get("steer-d2b-2")?.state === "uncertain")

// ═══════════ ④ 终态冻结：迟到帧改不动 uncertain ═══════════
console.log("\n[4] 终态冻结（uncertain 不得被迟到帧改写）")
const lateSettle = steerLedger.settle("steer-d2b-2", "applied", Date.now())
check("对 uncertain 补 applied 被拒", lateSettle.kind === "refused" && (lateSettle as { reason?: string }).reason === "terminal")
check("DB 仍是 uncertain", reader.get("steer-d2b-2")?.state === "uncertain")
const lateReplay = steerLedger.begin({ steerId: "steer-d2b-2", sessionId: sid, ownerKey: KEY, content: "再把节奏放慢一点", opencodeSessionId: `oc_${sid}`, turnGen: 1, now: Date.now() })
check("重放不得把 uncertain 打回 queued", lateReplay.kind === "rejected")
check("DB 仍是 uncertain（重放后）", reader.get("steer-d2b-2")?.state === "uncertain")

// ═══════════ ⑤ tombstone 不随 clear / 重启删除 ═══════════
console.log("\n[5] tombstone 不随 clear / 重启删除")
persistence.deleteSessionRow(sid) // clear / 删会话
persistence.sweepStaleRows(0) // 陈旧清扫（maxIdleMs=0 → 扫光所有 row）
check("clear 之后 tombstone 仍在", reader.get("steer-d2b-2")?.state === "uncertain")
check("clear 之后已终态的 applied 记录仍在", reader.get("steer-d2b-1")?.state === "applied")
// 会话重建（同 id）——tombstone 不得因此失效。
const resurrected = makeState(sid)
sessions.set(sid, resurrected)
persistence.saveSession({ ...resurrected, lastTurnActiveAt: 0 } as SessionState)
const res4 = await handleSteer(KEY, sid, steerReq(sid, { content: "再把节奏放慢一点", steer_id: "steer-d2b-2" }))
const body4 = (await res4.json()) as { error?: { code?: string } }
check("clear + 重建会话后同一 id 仍被拒", res4.status === 409 && body4.error?.code === "steer_replay_settled", JSON.stringify(body4))
const res4b = await handleSteer(KEY, sid, steerReq(sid, { content: "先改成 冷色调", steer_id: "steer-d2b-1" }))
const body4b = (await res4b.json()) as { error?: { code?: string }; status?: string }
check("已 applied 的 id 重放也被拒且回报 applied", res4b.status === 409 && body4b.error?.code === "steer_replay_settled" && body4b.status === "applied", JSON.stringify(body4b))

// ═══════════ ⑥ 第二条投递腿（question 断点注入）同样带身份与 tombstone ═══════════
console.log("\n[6] question 断点注入腿：身份 + tombstone 同样生效（含重连后不得重放）")
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
check("注入腿的身份同样先落地并落终态 injected", reader.get("steer-d2b-q1")?.state === "injected")
check("注入腿也记了 dispatched 时刻（投递发生过的证据）", typeof reader.get("steer-d2b-q1")?.dispatchedAt === "number")

// 重连／重启后同一 id 重放：不得再注入一次（否则模型收到两次而 View 只显示一次）。
sessions.clear()
persistence.initPersistence()
const qstate2 = makeState(sid2)
qstate2.pendingQuestions.set("que_2", { requestId: "que_2", callId: "call_2", questions: [{ question: "要继续吗", options: [] }] })
sessions.set(sid2, qstate2)
const resQ2 = await handleSteer(KEY, sid2, steerReq(sid2, { content: "先改成冷色调", steer_id: "steer-d2b-q1" }))
const bodyQ2 = (await resQ2.json()) as { error?: { code?: string }; status?: string }
check("重放被拒（不再注入第二次）", resQ2.status === 409 && bodyQ2.error?.code === "steer_replay_settled", JSON.stringify(bodyQ2))
check("重放拒绝回报既有终态 injected", bodyQ2.status === "injected", String(bodyQ2.status))
check("上游只被回灌过一次（真副作用计数＝模型不会收到两次）", questionReplies === 1, `replies=${questionReplies}`)
check("断点仍在（注入腿确实有可用断点，不是空跑）", qstate2.pendingQuestions.size === 1)
globalThis.fetch = realFetch

// ═══════════ ⑦ 回归保护：无 steer 的会话零动作 ═══════════
console.log("\n[7] 回归：没有 steer 记录的会话零动作")
const sid3 = "ses_d2b_clean"
const clean = makeState(sid3)
sessions.set(sid3, clean)
const framesForClean = recoverSteerCommandsOnRevive(clean)
check("无记录 → 恢复扫描零帧", framesForClean.length === 0)
check("无记录 → 队列仍空（零动作）", (clean.pendingSteers ?? []).length === 0)

// ═══════════ ⑧ D-6：系统中止窗口（空转断路器）照常受理，且不得说假话 ═══════════
//
// 真输入（真 Request）→ 真输出（真 Response + 真 SQLite + 真排队腿 + 真投递器副作用）。
// 判据：*回应状态与语义*（不是源码字串）、上游 /reply 是否被误打、投递器是否真的收到这条。
console.log("\n[8] D-6 系统中止窗口：照常受理（不得回「已中止、不会生效」的假话）")
const sid4 = "ses_d6_system"
const sysState = makeState(sid4)
sysState.turnAborted = true
sysState.turnAbortSource = "system" // 空转断路器：同轮续跑，指引刻意保留
// 中止轮残留的 question 卡（D2-1a 的实锤场景：此刻注入＝把引导语当答覆灌进已中止的轮）。
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
  "系统中止窗口内 steer：不再回「已中止、不会生效」（200 而非 409 turn_aborted）",
  resSys.status === 200 && bodySys.status === "queued",
  `status=${resSys.status} body=${JSON.stringify(bodySys)}`,
)
check("回应语义诚实：不宣称本回合内生效（applied_in_turn=false）", bodySys.applied_in_turn === false)
check("指引确实进了队列（受理＝保留，不是丢掉）", (sysState.pendingSteers ?? []).map((s) => s.id).join(",") === "steer-d6-1")
check("身份已落地（受理就一定有身份，重放防护不因窗口而松）", reader.get("steer-d6-1")?.state === "queued")
check("中止轮残留的 question 卡没被当成答覆灌回去（/reply 零次）", staleReplies === 0, `replies=${staleReplies}`)
check("残留断点没有被本请求消耗", sysState.pendingQuestions.size === 1)
globalThis.fetch = fetchBeforeD6

// 语义闭环：系统中止不是用户停止 → 收尾照常投递（这条指引不会消失）。
await flushPendingSteers(sysState)
check("营运闭环：系统中止后收尾照常投递这条指引", delivered.length === deliveredBeforeD6 + 1, `delivered=${delivered.length}`)
check("投递内容就是用户那句话", delivered[delivered.length - 1]?.includes("把结尾改成暖色") === true)
check("投递后落终态 applied", reader.get("steer-d6-1")?.state === "applied", String(reader.get("steer-d6-1")?.state))

// 对照组（不得放宽）：用户停止窗口仍然一律拒，且不落地任何身份、不进队列。
console.log("\n[8b] 用户停止窗口：仍然一律拒（D2-1a 保护不得被放宽）")
const sid5 = "ses_d6_user"
const userState = makeState(sid5)
userState.turnAborted = true
userState.turnAbortSource = "user"
sessions.set(sid5, userState)
const resUser = await handleSteer(KEY, sid5, steerReq(sid5, { content: "把结尾改成暖色", steer_id: "steer-d6-2" }))
const bodyUser = (await resUser.json()) as { error?: { message?: string; code?: string } }
check("用户停止窗口：回 409", resUser.status === 409, `status=${resUser.status}`)
check("拒绝码可辨识 = turn_aborted", bodyUser.error?.code === "turn_aborted", JSON.stringify(bodyUser))
check(
  "文案讲的是用户停止（不是系统中止的假话）",
  bodyUser.error?.message?.includes("用户停止") === true && bodyUser.error?.message?.includes("不会再生效") === true,
  String(bodyUser.error?.message),
)
check("用户停止窗口零落地（不留身份、不进队列）", reader.get("steer-d6-2") === null && (userState.pendingSteers ?? []).length === 0)

// ═══════════ ⑨ D-7：缺 steer_id 一律 fail-closed（网关不自铸身份）═══════════
console.log("\n[9] D-7 fail-closed：缺 id 不得自铸；同 content 无 id 不得长出两颗独立命令")
const sid6 = "ses_d7_noid"
const noIdState = makeState(sid6)
sessions.set(sid6, noIdState)
const deliveredBeforeD7 = delivered.length

const resNoId = await handleSteer(KEY, sid6, steerReq(sid6, { content: "没有带 id 的指引" }))
const bodyNoId = (await resNoId.json()) as { error?: { code?: string; message?: string } }
check("缺 steer_id：可辨识错误（HTTP 400）", resNoId.status === 400, `status=${resNoId.status}`)
check("错误码 = steer_id_required", bodyNoId.error?.code === "steer_id_required", JSON.stringify(bodyNoId))

const resBadId = await handleSteer(KEY, sid6, steerReq(sid6, { content: "非法 id 的指引", steer_id: "steer/../x" }))
const bodyBadId = (await resBadId.json()) as { error?: { code?: string } }
check("非法 steer_id：可辨识错误（不静默改铸）", resBadId.status === 400 && bodyBadId.error?.code === "steer_id_invalid", JSON.stringify(bodyBadId))

const resNumId = await handleSteer(KEY, sid6, steerReq(sid6, { content: "数字 id 的指引", steer_id: 42 }))
check("型别错误的 steer_id 同样被拒（42 → steer_id_invalid）", resNumId.status === 400)

// 关键不变量：同 content 无 id 连送两次，不得产生两颗（此处：一颗都不产生＝没有任何身份被自铸）。
const resNoId2 = await handleSteer(KEY, sid6, steerReq(sid6, { content: "没有带 id 的指引" }))
const rowsD7 = persistence.loadSteerCommandsForSession(sid6)
check("同 content 无 id 第二次也被拒（不是「第二条新命令」）", resNoId2.status === 400, `status=${resNoId2.status}`)
check("两次无 id 请求：持久层零命令（网关没有自铸任何身份）", rowsD7.length === 0, `rows=${rowsD7.length}`)
check("两次无 id 请求：队列仍空、零投递", (noIdState.pendingSteers ?? []).length === 0 && delivered.length === deliveredBeforeD7)
// 对照组：带了 id 的正常请求照常受理（fail-closed 没有误伤合法客户端）。
const resOkId = await handleSteer(KEY, sid6, steerReq(sid6, { content: "带了 id 的指引", steer_id: "steer-d7-ok" }))
check("带合法 id 照常受理（fail-closed 不误伤）", resOkId.status === 200 && reader.get("steer-d7-ok")?.state === "queued")

// ═══════════ ⑩ D-7b：别名查询精确比对（含 `_` 的 id 不得误命中他人）═══════════
console.log("\n[10] D-7b 别名精确比对：id 含 `_`（LIKE 单字元通配）不得误命中他人")
const sid7 = "ses_d7b_alias"
const aliasState = makeState(sid7)
sessions.set(sid7, aliasState)
// 甲：主 id 在底线位置上是**别的**字元（X）。
const resA = await handleSteer(KEY, sid7, steerReq(sid7, { content: "甲的第一条指引", steer_id: "steer-alias-pXq" }))
check("甲受理 queued", resA.status === 200, `status=${resA.status}`)

// 乙：查 "steer-alias-p_q"——旧版 LIKE 会把 `_` 当通配符命中甲的 "steer-alias-pXq"。
check(
  "查询含 `_` 的他人 id：不得命中甲的记录（LIKE 通配会在这里给出假命中）",
  reader.get("steer-alias-p_q") === null,
  `hit=${JSON.stringify(reader.get("steer-alias-p_q"))}`,
)
const resB = await handleSteer(KEY, sid7, steerReq(sid7, { content: "乙的另一条指引", steer_id: "steer-alias-p_q" }))
const bodyB = (await resB.json()) as { error?: { code?: string }; status?: string }
check(
  "乙带自己的 id 送达：必须被受理（旧版会冒出一颗与乙无关的假 409）",
  resB.status === 200 && bodyB.status === "queued",
  `status=${resB.status} body=${JSON.stringify(bodyB)}`,
)
check("乙在持久层是独立的一条（没有被并到甲身上）", reader.get("steer-alias-p_q")?.steerId === "steer-alias-p_q")

// 正向对照：真正的别名仍然查得到（精确比对不能把别名功能也一起砍掉）。
steerLedger.addAlias("steer-alias-pXq", "steer-alias-z_9")
check("真别名仍命中（精确比对没有误伤别名功能）", reader.get("steer-alias-z_9")?.steerId === "steer-alias-pXq")
check("别名位置的单字元变体不得命中（zX9 ≠ z_9）", reader.get("steer-alias-zX9") === null)

// ── 收尾 ──
console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`)
for (const f of failures) console.log(`  失败：${f}`)
console.log(`DB 位置：${process.env.SESSIONS_DB_PATH}`)
process.exit(failures.length === 0 ? 0 : 1)
