// quota-ledger.ts —— 自 index.ts 第二阶段 Wave3 无损抽取（2026-09-19）：额度——
// extractBalance/quotaUnavailableLogged/fetchBalance/quotaPayload/handleQuota/emitQuotaChanged（原 index.ts 5602–5669 行；
// spec 原写 5602–5676，现场 emitQuotaChanged 收于 5669，5670–5677 为 opencodeErrorMessage 的文档注释，未带）
// ＋记帐——internal handlers banner/LedgerEntry/appendLedger/appendLedgerFor（原 index.ts 6370–6405 行；
// 6407 起的 isLoopback 已归 auth-gw.ts，未带）。逐行原样搬运。
import { appendFile } from "node:fs/promises"
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs"
import type { SessionState } from "./types-gateway.ts"
import { LEDGER_PATH, QUOTA_URL } from "./constants-gateway.ts"
import { emitToSession } from "./sse-core.ts"
import { hashKey } from "./auth-gw.ts"
export function extractBalance(data: unknown): number | null {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>
    for (const k of ["balance_coins", "balance", "coins", "credit"]) {
      if (typeof obj[k] === "number") return obj[k]
    }
    if (obj.data && typeof obj.data === "object") return extractBalance(obj.data)
  }
  return null
}

// The platform exposes no balance endpoint yet (/v1/quota, /v1/balance,
// /v1/credits, /v1/me, /v1/usage, /v1/account all 404 with an HTML body as of
// 2026-08-07 — it is PRD part 1 work). Returning 0 here would be a lie that
// renders in the UI as "you have no coins" and would block the purchase flow.
// So: null means "unknown", and `available:false` tells the frontend to hide the
// balance chip rather than render a zero. When the platform ships the endpoint,
// set QUOTA_URL and this starts returning real numbers with no other change.
export let quotaUnavailableLogged = false

export async function fetchBalance(key: string): Promise<number | null> {
  try {
    const res = await fetch(QUOTA_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      if (!quotaUnavailableLogged) {
        console.warn(`[gateway] balance endpoint unavailable (${QUOTA_URL} -> ${res.status}); reporting balance as unknown`)
        quotaUnavailableLogged = true
      }
      return null
    }
    const ct = res.headers.get("content-type") ?? ""
    if (!ct.includes("json")) {
      if (!quotaUnavailableLogged) {
        console.warn(`[gateway] balance endpoint returned ${ct || "unknown content-type"}, not json; reporting balance as unknown`)
        quotaUnavailableLogged = true
      }
      return null
    }
    return extractBalance(await res.json())
  } catch {
    return null
  }
}

// R9-A（2026-09-30）：available 语义＝「余额数据可得」（前端据此显示/隐藏余额 chip，
// agent-chat-types.ts / agent-chat-client.ts 只读 available===true），不是「可消费」。
// spendable＝余额 >0 才可发起付费生成；负债 -3.01 币时 available:true 但 spendable:false。
export function quotaPayload(balance: number | null): Record<string, unknown> {
  return balance === null
    ? { balance_coins: null, currency: "coins", available: false, spendable: null, reason: "platform_balance_endpoint_missing" }
    : { balance_coins: balance, currency: "coins", available: true, spendable: balance > 0 }
}

export async function handleQuota(key: string): Promise<Response> {
  return Response.json(quotaPayload(await fetchBalance(key)))
}

export async function emitQuotaChanged(state: SessionState): Promise<void> {
  try {
    const balance = await fetchBalance(state.apiKey)
    // Don't fire a quota.changed carrying "unknown" — a frontend that renders it
    // would flash the balance chip to blank on every image. Stay silent instead.
    if (balance === null) return
    emitToSession(state, "quota.changed", quotaPayload(balance))
  } catch (e) {
    console.error(`[gateway] quota.changed emit failed: ${e}`)
  }
}

// ---- internal handlers (loopback only) ----

export interface LedgerEntry {
  ts: string
  user_id: string
  session_id: string
  opencode_session_id: string
  task_id?: string
  model?: string
  cost_coins?: number
  result_url?: string
  kind?: string
  event?: string
  // H20（2026-11-04）：confirm/approved 的关联键。request_id＝工具层提交平台时的 Idempotency-Key
  //（generation_job.idempotency_key），对账据此逐笔连到 job；旧行无此键＝未关联，不崩。
  request_id?: string
  workflow_id?: string
  // H22（2026-11-04）：失败/退款行的来源标注。refund_source="platform_job"＝该 task 的持久回执终态
  // 来自平台 generation_job.status='refunded'（平台仅在全额 refund operation applied 后才置此态）；
  // refund_claim="caller"＋refund_status="unconfirmed"＝调用方声称已退、平台账未证实，行记 failed 不记 refunded。
  refund_source?: string
  refund_claim?: string
  refund_status?: string
}

export async function appendLedger(entry: LedgerEntry): Promise<void> {
  try {
    await appendFile(LEDGER_PATH, JSON.stringify(entry) + "\n", "utf-8")
  } catch (e) {
    console.error(`[gateway] ledger append failed: ${e}`)
  }
}

// H22（2026-11-04）：done 每个 task 的每个成品只记一行（幂等）。旧去重只在单会话内按「原始 url」——同一 task
// 经工具回执（相对 /v1/images/<id>/result）与 drain 投递（公开 URL）两路到达、或重启后重放时各记一行，
// 对账把 cost_coins 加两次（生产 10867 行实测：两行都带费的同 task done 47 个，45 个同一 result_url）。
// 键＝task_id＋最终 result_url：同 task 同成品只记一次；工作流节点重跑（同 node.id、新成品、新扣费）照旧各记。
// 唯一放行重复：先到的那行没带费、后到的带费——补记带费行，避免把真实扣费漏出 ledger。
// 只管 ledger 写入：SSE/画布/扣费路径一律不动。进程级表首用时从现有 ledger 尾部种子，跨重启也不重记。
const LEDGER_DONE_CAP = 20000
const LEDGER_SEED_BYTES = 8 * 1024 * 1024
let ledgerDone: Map<string, boolean> | undefined
const doneKey = (task_id: string, url: string) => `${task_id}\u0000${url}`
function costed(cost: unknown): boolean { return typeof cost === "number" && cost > 0 }
function doneMap(): Map<string, boolean> {
  if (ledgerDone) return ledgerDone
  const seen = new Map<string, boolean>()
  try {
    if (existsSync(LEDGER_PATH)) {
      const fd = openSync(LEDGER_PATH, "r")
      try {
        const size = fstatSync(fd).size
        const len = Math.min(size, LEDGER_SEED_BYTES)
        const buf = Buffer.alloc(len)
        readSync(fd, buf, 0, len, size - len)
        const lines = buf.toString("utf-8").split("\n")
        if (size > len) lines.shift() // 截断的首行
        for (const line of lines) {
          if (!line.includes('"done"')) continue
          try {
            const o = JSON.parse(line)
            if (o?.event !== "done" || typeof o.task_id !== "string" || !o.task_id || typeof o.result_url !== "string") continue
            const k = doneKey(o.task_id, o.result_url)
            seen.set(k, seen.get(k) === true || costed(o.cost_coins))
          } catch {}
        }
      } finally { closeSync(fd) }
    }
  } catch (e) {
    console.error(`[gateway] ledger done-seed failed: ${e}`)
  }
  while (seen.size > LEDGER_DONE_CAP) seen.delete(seen.keys().next().value as string)
  ledgerDone = seen
  return seen
}
// true＝本次应写 done 行（同步占位，防两路并发同写）；无 task_id 或无 url 的行不去重（照旧写）。
export function claimLedgerDone(task_id: string | undefined, result_url: string | undefined, cost_coins: unknown): boolean {
  if (!task_id || !result_url) return true
  const map = doneMap()
  const k = doneKey(task_id, result_url)
  const prev = map.get(k)
  if (prev === true || (prev === false && !costed(cost_coins))) return false
  map.delete(k)
  map.set(k, costed(cost_coins))
  if (map.size > LEDGER_DONE_CAP) map.delete(map.keys().next().value as string)
  return true
}

export async function appendLedgerFor(state: SessionState, overrides: Partial<LedgerEntry>): Promise<void> {
  try {
    await appendLedger({
      ts: new Date().toISOString(),
      user_id: await hashKey(state.apiKey),
      session_id: state.sessionId,
      opencode_session_id: state.opencodeSessionId,
      ...overrides,
    })
  } catch (e) {
    console.error(`[gateway] ledger append failed: ${e}`)
  }
}
