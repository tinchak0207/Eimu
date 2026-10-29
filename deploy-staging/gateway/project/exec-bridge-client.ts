// 网关侧 exec-bridge 客户端（S12，设计文档 §3.6）。实现契约 types.ts 的 ExecBridgeClient。
//
// 鉴权：X-Internal-Token = 环境变量 HARNESS_INTERNAL_TOKEN（每次调用时读，不落盘、不进日志）。
// 地址：EXEC_BRIDGE_URL，缺省 http://127.0.0.1:8767。
// 超时语义：桥内硬超时 music 240s / blender_render 1200s；网关客户端超时 = 桥超时 + 15s（见 defaultClientTimeoutMs），
// 调用方把它传进 opts.timeoutMs。HTTP 层超时/断线＝请求可能已到达桥并在执行 ⇒ 返回 code:"submit_unknown"
// （绝不盲重投；调用方置 inflight.submitUnknown=true，之后用 result(idemKey) 确认）。
// 只有确认请求没有送达（连接被拒）才返回可重试的 bridge_unavailable。

import type { ExecBridgeClient, ExecErrorCode } from "./types"

type CallBody = Parameters<ExecBridgeClient["call"]>[1]
type ContractCallResult = Awaited<ReturnType<ExecBridgeClient["call"]>>
/** 契约 ok 回执 + 桥额外透出的 chargeError（music 扣费未确认时在场，此时 costCoins=0 且无 chargeRef）。 */
export type ExecBridgeOk = Extract<ContractCallResult, { ok: true }> & { chargeError?: string }
export type CallResult = ExecBridgeOk | Extract<ContractCallResult, { ok: false }>
type ResultOut = Awaited<ReturnType<ExecBridgeClient["result"]>>

export const EXEC_BRIDGE_TIMEOUT_MS = { music_gen: 240_000, blender_render: 1_200_000 } as const
export const EXEC_BRIDGE_CLIENT_GRACE_MS = 15_000
/** 网关客户端超时 = 桥内硬超时 + 15 秒。 */
export const defaultClientTimeoutMs = (route: "music_gen" | "blender_render") =>
  EXEC_BRIDGE_TIMEOUT_MS[route] + EXEC_BRIDGE_CLIENT_GRACE_MS

export interface ExecBridgeClientOptions {
  baseUrl?: string
  /** 缺省读 process.env.HARNESS_INTERNAL_TOKEN */
  token?: () => string | undefined
  fetchImpl?: typeof fetch
}

const NEVER_SENT = /ConnectionRefused|ECONNREFUSED|ENOTFOUND|FailedToOpenSocket|EHOSTUNREACH/i

function errText(e: unknown): string {
  const any = e as { code?: string; name?: string; message?: string; cause?: { code?: string } } | undefined
  return `${any?.code ?? ""} ${any?.cause?.code ?? ""} ${any?.name ?? ""} ${any?.message ?? ""}`
}

const ERROR_CODES: readonly ExecErrorCode[] = [
  "provider_error", "platform_fault", "safety_blocked", "timeout", "submit_unknown", "price_unknown", "bad_input", "bridge_unavailable", "qc_failed", "cancelled",
]

export function createExecBridgeClient(opts: ExecBridgeClientOptions = {}): Omit<ExecBridgeClient, "call"> & { call(...a: Parameters<ExecBridgeClient["call"]>): Promise<CallResult> } {
  const baseUrl = () => (opts.baseUrl ?? process.env.EXEC_BRIDGE_URL ?? "http://127.0.0.1:8767").replace(/\/+$/, "")
  const token = () => (opts.token ? opts.token() : process.env.HARNESS_INTERNAL_TOKEN) ?? ""
  const doFetch = opts.fetchImpl ?? fetch

  async function call(route: "music_gen" | "blender_render", body: CallBody, o: { timeoutMs: number; signal: AbortSignal }): Promise<CallResult> {
    if (!token()) return { ok: false, code: "bridge_unavailable", message: "HARNESS_INTERNAL_TOKEN 未配置，不能调用 exec-bridge", retryable: false }
    const timeout = AbortSignal.timeout(o.timeoutMs)
    const signal = AbortSignal.any([o.signal, timeout])
    let res: Response
    try {
      res = await doFetch(`${baseUrl()}/v1/exec/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": token() },
        body: JSON.stringify(body),
        signal,
        // Bun 的 fetch 默认有总时长上限，blender 长任务需关掉，超时一律由上面的 AbortSignal 决定。
        ...({ timeout: false } as object),
      })
    } catch (e) {
      const text = errText(e)
      if (NEVER_SENT.test(text)) return { ok: false, code: "bridge_unavailable", message: "exec-bridge 连接被拒（请求未送达，可重试）", retryable: true }
      // 超时/断线/用户中止：请求可能已被桥受理并在执行 ⇒ 未知，不盲重投
      const why = timeout.aborted ? `客户端超时 ${o.timeoutMs}ms` : o.signal.aborted ? "调用被中止" : "连接中断"
      return { ok: false, code: "submit_unknown", message: `${why}：桥可能已受理，用 result(${body.idemKey}) 确认`, retryable: false }
    }
    if (res.status === 403) return { ok: false, code: "bridge_unavailable", message: "exec-bridge 拒绝 token（403）", retryable: false }
    if (res.status === 400 || res.status === 409 || res.status === 413) {
      const m = await res.json().catch(() => ({}) as { message?: string })
      return { ok: false, code: "bad_input", message: String((m as { message?: string }).message ?? `桥拒绝请求 HTTP ${res.status}`).slice(0, 300), retryable: false }
    }
    if (!res.ok) return { ok: false, code: "submit_unknown", message: `exec-bridge HTTP ${res.status}，执行状态未知`, retryable: false }
    let data: any
    try { data = await res.json() } catch {
      return { ok: false, code: "submit_unknown", message: "exec-bridge 响应不是合法 JSON，执行状态未知", retryable: false }
    }
    if (data?.ok === true && Array.isArray(data.files)) {
      return {
        ok: true, files: data.files, costCoins: typeof data.costCoins === "number" ? data.costCoins : 0,
        ...(typeof data.chargeRef === "string" ? { chargeRef: data.chargeRef } : {}),
        ...(typeof data.provider === "string" ? { provider: data.provider } : {}),
        ...(typeof data.chargeError === "string" ? { chargeError: data.chargeError } : {}),
      }
    }
    if (data?.ok === false) {
      const code: ExecErrorCode = ERROR_CODES.includes(data.code) ? data.code : "provider_error"
      return { ok: false, code, message: String(data.message ?? "").slice(0, 500), retryable: data.retryable === true, ...(data.recoverable === true ? { recoverable: true } : {}) }
    }
    return { ok: false, code: "submit_unknown", message: "exec-bridge 响应形状不符，执行状态未知", retryable: false }
  }

  async function result(idemKey: string, identity?: Parameters<ExecBridgeClient["result"]>[1]): Promise<ResultOut> {
    try {
      const query = identity ? `?${new URLSearchParams(identity).toString()}` : ""
      const res = await doFetch(`${baseUrl()}/v1/exec/result/${encodeURIComponent(idemKey)}${query}`, {
        headers: { "x-internal-token": token() },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return { state: "unknown" }
      const d = (await res.json()) as { state?: string; files?: ResultOut["files"]; costCoins?: number; chargeRef?: string }
      if (d.state !== "running" && d.state !== "done" && d.state !== "failed") return { state: "unknown" }
      return {
        state: d.state,
        ...(Array.isArray(d.files) ? { files: d.files } : {}),
        ...(typeof d.costCoins === "number" ? { costCoins: d.costCoins } : {}),
        ...(typeof d.chargeRef === "string" ? { chargeRef: d.chargeRef } : {}),
      }
    } catch {
      return { state: "unknown" }
    }
  }

  async function ingested(identity: Parameters<NonNullable<ExecBridgeClient["ingested"]>>[0]): Promise<{ ok: boolean }> {
    try {
      const response = await doFetch(`${baseUrl()}/v1/exec/ingested`, { method: "POST", headers: { "content-type": "application/json", "x-internal-token": token() }, body: JSON.stringify(identity), signal: AbortSignal.timeout(10_000) })
      const receipt = await response.json() as { ok?: boolean }
      return { ok: response.ok && receipt.ok === true }
    } catch { return { ok: false } }
  }
  return { call, result, ingested }
}
