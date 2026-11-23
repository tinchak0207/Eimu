import * as fsp from "node:fs/promises"
import * as nodePath from "node:path"
import { createCipheriv, createHash, randomBytes } from "node:crypto"

const DEFAULT_LINKII_BASE_URL = "https://www.linkii.tech/api/admin"
const DEFAULT_LINKII_MEDIA_BASE_URL = "https://res.linkii.tech/"
const DEFAULT_LINKII_TOKEN_CACHE_FILE = "/tmp/linkii-harness-token-cache.json"
const LINKII_CLIENT_ID = "195da9fcce574852b850068771cde035"
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000
const AUTH_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_POLL_TIMEOUT_MS = 12 * 60 * 1000
const DEFAULT_POLL_INTERVAL_MS = 5_000

const SUCCESS_CODES = new Set<string | number>([200, "200", 0, "0", "0000", "00000", "OK", "ok", "SUCCESS", "success"])

export class LinkiiClientError extends Error {
  code: string
  status?: number
  upstreamCode?: string
  constructor(code: string, message: string, status?: number, upstreamCode?: string) {
    super(message)
    this.name = "LinkiiClientError"
    this.code = code
    this.status = status
    this.upstreamCode = upstreamCode
  }
}

interface TokenCacheRecord {
  credHash: string
  token?: string
  expiresAtMs?: number | null
  rateLimitedUntilMs?: number
  updatedAt: string
}

let memTokenCache: { credHash: string; token: string; expiresAtMs: number | null } | null = null
let memRateLimitedUntilByCred = new Map<string, number>()
let invalidatedEnvToken: string | null = null
let inflightLogin: { credHash: string; promise: Promise<string> } | null = null

export function linkiiBaseUrl(): string {
  const raw = (process.env.LINKII_BASE_URL ?? "").trim()
  return (raw || DEFAULT_LINKII_BASE_URL).replace(/\/+$/, "")
}

export function linkiiMediaBaseUrl(): string {
  const raw = (process.env.LINKII_MEDIA_BASE_URL ?? "").trim() || DEFAULT_LINKII_MEDIA_BASE_URL
  return `${raw.replace(/\/+$/, "")}/`
}

export function resolveLinkiiMediaUrl(raw: string): string {
  const s = (raw ?? "").trim()
  if (!s) return ""
  if (/^https?:\/\//i.test(s)) return s
  return `${linkiiMediaBaseUrl()}${s.replace(/^\/+/, "")}`
}

function linkiiCredentials(): { username: string; password: string; envToken: string } {
  return {
    username: (process.env.LINKII_USERNAME ?? "").trim(),
    password: process.env.LINKII_PASSWORD ?? "",
    envToken: (process.env.LINKII_AUTH_TOKEN ?? "").trim(),
  }
}

export function isLinkiiConfigured(): boolean {
  const { username, password, envToken } = linkiiCredentials()
  return Boolean(envToken || (username && password))
}

function tokenCacheFilePath(): string {
  const raw = (process.env.LINKII_TOKEN_CACHE_FILE ?? "").trim()
  return raw || DEFAULT_LINKII_TOKEN_CACHE_FILE
}

function currentCredHash(): string {
  const { username } = linkiiCredentials()
  return createHash("sha256").update(`${linkiiBaseUrl()}\n${username}`).digest("hex")
}

function parseJwtExpMs(token: string): number | null {
  try {
    const parts = token.split(".")
    if (parts.length < 2) return null
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4))
    const payload = JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8")) as { exp?: unknown }
    return typeof payload?.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

function isTokenFresh(expiresAtMs: number | null | undefined): boolean {
  if (expiresAtMs === null || expiresAtMs === undefined) return true
  return expiresAtMs - Date.now() > TOKEN_REFRESH_SKEW_MS
}

async function readDiskCache(credHash: string): Promise<TokenCacheRecord | null> {
  try {
    const raw = await fsp.readFile(tokenCacheFilePath(), "utf8")
    const parsed = JSON.parse(raw) as Partial<TokenCacheRecord>
    if (!parsed || parsed.credHash !== credHash) return null
    return {
      credHash,
      token: typeof parsed.token === "string" && parsed.token ? parsed.token : undefined,
      expiresAtMs: typeof parsed.expiresAtMs === "number" ? parsed.expiresAtMs : null,
      rateLimitedUntilMs: typeof parsed.rateLimitedUntilMs === "number" ? parsed.rateLimitedUntilMs : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    }
  } catch {
    return null
  }
}

async function writeDiskCache(record: TokenCacheRecord): Promise<void> {
  try {
    const target = tokenCacheFilePath()
    await fsp.mkdir(nodePath.dirname(target), { recursive: true })
    await fsp.writeFile(target, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 })
    await fsp.chmod(target, 0o600).catch(() => {})
  } catch {
    // best-effort 缓存落盘失败不影响请求
  }
}

async function setAuthRateLimitCooldown(credHash: string): Promise<number> {
  const until = Date.now() + AUTH_RATE_LIMIT_COOLDOWN_MS
  memRateLimitedUntilByCred.set(credHash, until)
  await writeDiskCache({
    credHash,
    rateLimitedUntilMs: until,
    updatedAt: new Date().toISOString(),
  })
  return until
}

export async function isLinkiiAuthRateLimited(): Promise<{ limited: boolean; remainingMs: number }> {
  const credHash = currentCredHash()
  let until = memRateLimitedUntilByCred.get(credHash) ?? 0
  if (until <= Date.now()) {
    const disk = await readDiskCache(credHash)
    if (disk?.rateLimitedUntilMs && disk.rateLimitedUntilMs > until) {
      until = disk.rateLimitedUntilMs
      memRateLimitedUntilByCred.set(credHash, until)
    }
  }
  const remainingMs = Math.max(0, until - Date.now())
  return { limited: remainingMs > 0, remainingMs }
}

export async function hasLinkiiCachedToken(): Promise<boolean> {
  const credHash = currentCredHash()
  if (memTokenCache && memTokenCache.credHash === credHash && isTokenFresh(memTokenCache.expiresAtMs)) {
    return true
  }
  const disk = await readDiskCache(credHash)
  if (disk?.token && isTokenFresh(disk.expiresAtMs)) return true
  const { envToken } = linkiiCredentials()
  if (envToken && envToken !== invalidatedEnvToken && isTokenFresh(parseJwtExpMs(envToken))) {
    return true
  }
  return false
}

async function clearCachedToken(credHash: string): Promise<void> {
  if (memTokenCache?.credHash === credHash) memTokenCache = null
  const { envToken } = linkiiCredentials()
  if (envToken) invalidatedEnvToken = envToken
  const existingRateLimit = memRateLimitedUntilByCred.get(credHash)
  await writeDiskCache({
    credHash,
    ...(existingRateLimit && existingRateLimit > Date.now() ? { rateLimitedUntilMs: existingRateLimit } : {}),
    updatedAt: new Date().toISOString(),
  })
}

function combineSignals(signal?: AbortSignal, timeoutMs?: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const onAbort = () => {
    controller.abort(signal?.reason ?? new Error("aborted"))
  }
  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason ?? new Error("aborted"))
    } else {
      signal.addEventListener("abort", onAbort, { once: true })
    }
  }
  if (typeof timeoutMs === "number" && timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort(new DOMException(`请求超时（${timeoutMs}ms）`, "TimeoutError"))
    }, timeoutMs)
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    },
  }
}

function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("请求已取消"))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("请求已取消"))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener("abort", onAbort)
        reject(err)
      },
    )
  })
}

function extractErrorMessage(body: unknown, fallbackText: string): string {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>
    for (const key of ["msg", "message", "errorMsg", "errorMessage", "detail", "error"]) {
      const val = obj[key]
      if (typeof val === "string" && val.trim()) return val.trim().slice(0, 500)
    }
  }
  const clean = fallbackText.replace(/\s+/g, " ").trim()
  return clean ? clean.slice(0, 500) : "未知错误"
}

function isSuccessCode(code: unknown): boolean {
  if (code === undefined || code === null || code === "") return true
  return SUCCESS_CODES.has(code as string | number)
}

function unwrapPayload<T>(body: unknown): T {
  if (body && typeof body === "object" && !Array.isArray(body) && "data" in body) {
    const data = (body as Record<string, unknown>).data
    if (data !== undefined) return data as T
  }
  return body as T
}

async function performLogin(credHash: string): Promise<string> {
  const rate = await isLinkiiAuthRateLimited()
  if (rate.limited) {
    const remainSec = Math.ceil(rate.remainingMs / 1000)
    throw new LinkiiClientError(
      "linkii_auth_rate_limited",
      `Linkii 登录挑战触发频控（C1015），5 分钟冷却中（剩余约 ${remainSec} 秒）。`,
      429,
      "C1015",
    )
  }

  const { username, password } = linkiiCredentials()
  if (!username || !password) {
    throw new LinkiiClientError(
      "linkii_not_configured",
      "Linkii 账号密码未配置（需要 LINKII_USERNAME 与 LINKII_PASSWORD）。",
    )
  }

  const base = linkiiBaseUrl()
  // 1. 获取挑战
  const challengeComb = combineSignals(undefined, 15_000)
  let challengeBody: Record<string, unknown> | null = null
  let challengeText = ""
  let challengeStatus = 0
  try {
    const resp = await fetch(`${base}/web/auth/challenge`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: challengeComb.signal,
    })
    challengeStatus = resp.status
    challengeText = await resp.text().catch(() => "")
    try {
      challengeBody = JSON.parse(challengeText) as Record<string, unknown>
    } catch {
      challengeBody = null
    }
  } catch (e) {
    throw new LinkiiClientError(
      "linkii_auth_unreachable",
      `Linkii 登录挑战请求失败：${(e as Error)?.message ?? String(e)}`,
    )
  } finally {
    challengeComb.cleanup()
  }

  if (String(challengeBody?.code ?? "") === "C1015") {
    await setAuthRateLimitCooldown(credHash)
    throw new LinkiiClientError(
      "linkii_auth_rate_limited",
      `Linkii 获取登录挑战触发频控（C1015），已进入 5 分钟冷却：${extractErrorMessage(challengeBody, challengeText)}`,
      challengeStatus || 429,
      "C1015",
    )
  }
  if (challengeStatus < 200 || challengeStatus >= 300 || !challengeBody || !isSuccessCode(challengeBody.code)) {
    throw new LinkiiClientError(
      "linkii_auth_challenge_failed",
      `Linkii 获取登录挑战失败（HTTP ${challengeStatus}）：${extractErrorMessage(challengeBody, challengeText)}`,
      challengeStatus,
      challengeBody?.code !== undefined ? String(challengeBody.code) : undefined,
    )
  }

  const challengeData = unwrapPayload<Record<string, unknown>>(challengeBody) ?? {}
  const requestId = typeof challengeData.requestId === "string" ? challengeData.requestId.trim() : ""
  const secretKey = typeof challengeData.secretKey === "string" ? challengeData.secretKey : ""
  if (!requestId || !secretKey) {
    throw new LinkiiClientError(
      "linkii_auth_challenge_invalid",
      "Linkii 登录挑战响应缺少 requestId 或 secretKey。",
    )
  }

  const keyBuf = Buffer.from(secretKey, "utf8")
  if (keyBuf.length !== 16) {
    throw new LinkiiClientError(
      "linkii_auth_challenge_invalid",
      `Linkii 登录挑战 secretKey 字节长度异常（期望 16，实际 ${keyBuf.length}）。`,
    )
  }

  // 2. AES-128-GCM 加密密码
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-128-gcm", keyBuf, iv)
  const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  const enc = Buffer.concat([encrypted, tag]).toString("base64")
  const ivB64 = iv.toString("base64")

  // 3. 提交登录
  const loginComb = combineSignals(undefined, 20_000)
  let loginBody: Record<string, unknown> | null = null
  let loginText = ""
  let loginStatus = 0
  try {
    const resp = await fetch(`${base}/web/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        username,
        password: enc,
        requestId,
        iv: ivB64,
        clientId: LINKII_CLIENT_ID,
        grantType: "webPassword",
      }),
      signal: loginComb.signal,
    })
    loginStatus = resp.status
    loginText = await resp.text().catch(() => "")
    try {
      loginBody = JSON.parse(loginText) as Record<string, unknown>
    } catch {
      loginBody = null
    }
  } catch (e) {
    throw new LinkiiClientError(
      "linkii_auth_unreachable",
      `Linkii 登录请求失败：${(e as Error)?.message ?? String(e)}`,
    )
  } finally {
    loginComb.cleanup()
  }

  if (String(loginBody?.code ?? "") === "C1015") {
    await setAuthRateLimitCooldown(credHash)
    throw new LinkiiClientError(
      "linkii_auth_rate_limited",
      `Linkii 登录触发频控（C1015），已进入 5 分钟冷却：${extractErrorMessage(loginBody, loginText)}`,
      loginStatus || 429,
      "C1015",
    )
  }
  if (loginStatus < 200 || loginStatus >= 300 || !loginBody || !isSuccessCode(loginBody.code)) {
    throw new LinkiiClientError(
      "linkii_auth_failed",
      `Linkii 登录失败（HTTP ${loginStatus}）：${extractErrorMessage(loginBody, loginText)}`,
      loginStatus,
      loginBody?.code !== undefined ? String(loginBody.code) : undefined,
    )
  }

  const loginData = unwrapPayload<Record<string, unknown>>(loginBody) ?? {}
  const accessToken =
    (typeof loginData.accessToken === "string" && loginData.accessToken.trim()) ||
    (typeof loginData.token === "string" && loginData.token.trim()) ||
    (typeof loginBody.accessToken === "string" && loginBody.accessToken.trim()) ||
    (typeof loginBody.token === "string" && loginBody.token.trim()) ||
    ""
  if (!accessToken) {
    throw new LinkiiClientError("linkii_auth_failed", "Linkii 登录成功响应中缺少 accessToken/token。")
  }

  const expiresAtMs = parseJwtExpMs(accessToken)
  memTokenCache = { credHash, token: accessToken, expiresAtMs }
  memRateLimitedUntilByCred.delete(credHash)
  await writeDiskCache({
    credHash,
    token: accessToken,
    expiresAtMs,
    updatedAt: new Date().toISOString(),
  })
  return accessToken
}

export async function getLinkiiToken(signal?: AbortSignal, forceRefresh?: boolean): Promise<string> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("请求已取消")
  }
  const credHash = currentCredHash()

  if (!forceRefresh) {
    if (memTokenCache && memTokenCache.credHash === credHash && isTokenFresh(memTokenCache.expiresAtMs)) {
      return memTokenCache.token
    }
    const disk = await readDiskCache(credHash)
    if (disk?.token && isTokenFresh(disk.expiresAtMs)) {
      memTokenCache = { credHash, token: disk.token, expiresAtMs: disk.expiresAtMs ?? null }
      return disk.token
    }
    const { envToken } = linkiiCredentials()
    if (envToken && envToken !== invalidatedEnvToken && isTokenFresh(parseJwtExpMs(envToken))) {
      return envToken
    }
  } else {
    await clearCachedToken(credHash)
  }

  if (inflightLogin && inflightLogin.credHash === credHash) {
    return raceWithSignal(inflightLogin.promise, signal)
  }

  const promise = performLogin(credHash).finally(() => {
    if (inflightLogin?.promise === promise) inflightLogin = null
  })
  inflightLogin = { credHash, promise }
  return raceWithSignal(promise, signal)
}

function buildLinkiiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const normalized = path.startsWith("/") ? path : `/${path}`
  return `${linkiiBaseUrl()}${normalized}`
}

async function requestWithAuthRetry<T>(
  path: string,
  buildInit: (token: string) => RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const url = buildLinkiiUrl(path)
  const credHash = currentCredHash()

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getLinkiiToken(signal, attempt > 0)
    const comb = combineSignals(signal, timeoutMs)
    let resp: Response
    let rawText = ""
    try {
      resp = await fetch(url, { ...buildInit(token), signal: comb.signal })
      rawText = await resp.text().catch(() => "")
    } catch (e) {
      comb.cleanup()
      if (signal?.aborted) {
        throw e instanceof Error ? e : new Error(String(e))
      }
      throw new LinkiiClientError(
        "linkii_network_error",
        `Linkii 请求 ${path} 网络异常：${(e as Error)?.message ?? String(e)}`,
      )
    } finally {
      comb.cleanup()
    }

    let body: Record<string, unknown> | null = null
    if (rawText.trim()) {
      try {
        body = JSON.parse(rawText) as Record<string, unknown>
      } catch {
        body = null
      }
    }

    const upstreamCode = body?.code !== undefined && body?.code !== null ? String(body.code) : undefined
    if (upstreamCode === "C1015") {
      await setAuthRateLimitCooldown(credHash)
      throw new LinkiiClientError(
        "linkii_auth_rate_limited",
        `Linkii 接口触发频控（C1015）：${extractErrorMessage(body, rawText)}`,
        resp.status,
        "C1015",
      )
    }

    if (resp.status === 401 || upstreamCode === "C105") {
      await clearCachedToken(credHash)
      const { username, password } = linkiiCredentials()
      if (attempt === 0 && username && password) {
        continue
      }
      throw new LinkiiClientError(
        "linkii_auth_expired",
        `Linkii 鉴权失效（${upstreamCode || `HTTP ${resp.status}`}）：${extractErrorMessage(body, rawText)}`,
        resp.status,
        upstreamCode,
      )
    }

    if (!resp.ok) {
      throw new LinkiiClientError(
        "linkii_http_error",
        `Linkii 请求 ${path} 返回 HTTP ${resp.status}：${extractErrorMessage(body, rawText)}`,
        resp.status,
        upstreamCode,
      )
    }

    if (body === null) {
      throw new LinkiiClientError(
        "linkii_bad_json",
        `Linkii 接口 ${path} 返回非 JSON 响应：${rawText.slice(0, 300) || "(空)"}`,
        resp.status,
      )
    }

    if (!isSuccessCode(body.code) || body.success === false) {
      throw new LinkiiClientError(
        "linkii_api_error",
        `Linkii 接口 ${path} 返回业务错误（code=${upstreamCode ?? "unknown"}）：${extractErrorMessage(body, rawText)}`,
        resp.status,
        upstreamCode,
      )
    }

    return unwrapPayload<T>(body)
  }

  throw new LinkiiClientError("linkii_auth_expired", `Linkii 请求 ${path} 重登后仍鉴权失败。`)
}

export async function linkiiJson<T = any>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
  signal?: AbortSignal,
): Promise<T> {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...reqInit } = init ?? {}
  const effectiveSignal = signal ?? (reqInit.signal ?? undefined)

  return requestWithAuthRetry<T>(
    path,
    (token) => {
      const headers = new Headers(reqInit.headers ?? {})
      headers.delete("Authorization")
      headers.set("X-SXKJ-AIGC-Token", `Bearer ${token}`)
      if (!headers.has("X-Locale")) headers.set("X-Locale", "zh-MO")
      if (!headers.has("Accept")) headers.set("Accept", "application/json")
      if (reqInit.body !== undefined && typeof reqInit.body === "string" && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json")
      }
      return {
        ...reqInit,
        headers,
      }
    },
    timeoutMs,
    effectiveSignal,
  )
}

export async function linkiiUpload(
  path: string,
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  signal?: AbortSignal,
): Promise<any> {
  const copied = new Uint8Array(bytes.byteLength)
  copied.set(bytes)
  return requestWithAuthRetry<any>(
    path,
    (token) => {
      const form = new FormData()
      const blob = new Blob([copied], { type: mimeType || "application/octet-stream" })
      form.append("file", blob, filename || "upload.bin")
      return {
        method: "POST",
        headers: {
          "X-SXKJ-AIGC-Token": `Bearer ${token}`,
          "X-Locale": "zh-MO",
          Accept: "application/json",
        },
        body: form,
      }
    },
    60_000,
    signal,
  )
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("轮询已取消"))
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error("轮询已取消"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export async function pollLinkiiTaskAndWork(
  taskId: string | number,
  creationId: string | number,
  opts?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal },
): Promise<{ task: any; work: any }> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_INTERVAL_MS
  const signal = opts?.signal
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("任务轮询已取消")
    }
    const task = await linkiiJson<any>(
      `/web/ai/task/${encodeURIComponent(String(taskId))}`,
      { method: "GET", timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
      signal,
    )
    const status = String(task?.status ?? "").toLowerCase()
    if (status === "completed" || status === "success" || status === "succeeded") {
      const work = await linkiiJson<any>(
        `/web/works/${encodeURIComponent(String(creationId))}`,
        { method: "GET", timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
        signal,
      )
      return { task, work }
    }
    if (status === "failed" || status === "abandoned" || status === "error" || status === "canceled" || status === "cancelled") {
      const reason =
        (typeof task?.errorMsg === "string" && task.errorMsg.trim()) ||
        (typeof task?.errorMessage === "string" && task.errorMessage.trim()) ||
        (typeof task?.failReason === "string" && task.failReason.trim()) ||
        (typeof task?.message === "string" && task.message.trim()) ||
        `任务状态=${String(task?.status ?? "failed")}`
      throw new LinkiiClientError(
        "linkii_task_failed",
        `Linkii 任务失败（taskId=${taskId}, status=${String(task?.status)}）：${reason}`,
      )
    }

    const remain = deadline - Date.now()
    if (remain <= 0) {
      throw new LinkiiClientError(
        "linkii_task_timeout",
        `Linkii 任务轮询超时（>${Math.round(timeoutMs / 1000)}s，taskId=${taskId}, 最后状态=${String(task?.status ?? "unknown")}）。`,
      )
    }
    await sleepWithAbort(Math.min(pollMs, remain), signal)
  }
}
