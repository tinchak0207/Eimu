// quota-ledger.ts —— 自 index.ts 第二階段 Wave3 無損抽取（2026-09-19）：額度——
// extractBalance/quotaUnavailableLogged/fetchBalance/quotaPayload/handleQuota/emitQuotaChanged（原 index.ts 5602–5669 行；
// spec 原寫 5602–5676，現場 emitQuotaChanged 收於 5669，5670–5677 為 opencodeErrorMessage 的文檔註釋，未帶）
// ＋記帳——internal handlers banner/LedgerEntry/appendLedger/appendLedgerFor（原 index.ts 6370–6405 行；
// 6407 起的 isLoopback 已歸 auth-gw.ts，未帶）。逐行原樣搬運。
import { appendFile } from "node:fs/promises"
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

// R9-A（2026-09-30）：available 語義＝「餘額數據可得」（前端據此顯示/隱藏餘額 chip，
// agent-chat-types.ts / agent-chat-client.ts 只讀 available===true），不是「可消費」。
// spendable＝餘額 >0 才可發起付費生成；負債 -3.01 幣時 available:true 但 spendable:false。
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
}

export async function appendLedger(entry: LedgerEntry): Promise<void> {
  try {
    await appendFile(LEDGER_PATH, JSON.stringify(entry) + "\n", "utf-8")
  } catch (e) {
    console.error(`[gateway] ledger append failed: ${e}`)
  }
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
