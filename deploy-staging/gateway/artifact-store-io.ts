import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs"
import { isIP } from "node:net"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { Readable } from "node:stream"
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib"
import path from "node:path"
import { ARTIFACT_MAX_BYTES, ArtifactError, MAX_PROBE_REDIRECTS, MAX_SLUG_LENGTH, MAX_URL_LENGTH, PROBE_GET_TIMEOUT_MS, PROBE_HEAD_TIMEOUT_MS, artifactVerifyMaxBytes, type ArtifactVersionView } from "./artifact-store-types.ts"
import { assertUploadPathAllowed } from "./artifact-store-paths.ts"
export function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new ArtifactError(`invalid_${field}`, `${field} 必须是字符串`)
  const text = value.trim()
  if (!text) throw new ArtifactError(`invalid_${field}`, `${field} 不能为空`)
  if (text.length > max) throw new ArtifactError(`invalid_${field}`, `${field} 超过 ${max} 字符`)
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new ArtifactError(`invalid_${field}`, `${field} 含控制字符`)
  return text
}

export function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  return requiredText(value, field, max)
}

export function normalizeVersion(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isInteger(n) || n < 1) throw new ArtifactError("invalid_version", "version 必须是 ≥1 的整数")
  return n
}

/** P2-9：asset_id 必须是 ≥1 的整数；字符串/NaN 一律 400，绝不静默当成缺失。 */
export function normalizeAssetId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isInteger(n) || n < 1) throw new ArtifactError("invalid_asset_id", "asset_id 必须是 ≥1 的整数", 400)
  return n
}

export function normalizeExpectedVersion(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  // 约束（P2-7）：严格 number 校验——字符串数字、布尔、数组、NaN、Infinity 一律 400。
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new ArtifactError(
      "invalid_expected_version",
      "expectedVersion 必须是 ≥0 的有限整数（不接受字符串/布尔/数组/NaN/Infinity）",
    )
  }
  // 约束：expectedVersion=0 表示“预期尚未发布”。
  return value
}

export function slugFor(sessionId: string, name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  const digest = createHash("sha256").update(`${sessionId}\0${name}`).digest("hex").slice(0, 10)
  return `${base || "artifact"}-${digest}`.slice(0, MAX_SLUG_LENGTH)
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
}

export function contentTypeFor(filePath: string, provided?: string): string {
  if (provided) return provided.slice(0, 256)
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream"
}

/** 从 URL 的路径扩展名推出期望 MIME（用于 verify 的 content_type 一致性检查）。 */
export function expectedContentTypeForUrl(rawUrl: string): string | null {
  try {
    const ext = path.extname(new URL(rawUrl).pathname).toLowerCase()
    const expected = CONTENT_TYPES[ext]
    return expected ? expected.split(";")[0].trim().toLowerCase() : null
  } catch {
    return null
  }
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex")
}

interface ReadFileResult {
  absolutePath: string
  bytes: Buffer
  sha256: string
  size: number
}
export function readRegularFile(inputPath: string): ReadFileResult {
  const absolutePath = path.resolve(requiredText(inputPath, "path", MAX_URL_LENGTH))
  let before: ReturnType<typeof lstatSync>
  try {
    before = lstatSync(absolutePath)
  } catch {
    throw new ArtifactError("file_not_found", `文件不存在：${absolutePath}`, 400)
  }
  // 约束：只接受常规文件；符号链接、目录、设备、FIFO 一律拒绝。
  if (before.isSymbolicLink()) throw new ArtifactError("file_symlink", "拒绝符号链接", 400)
  if (!before.isFile()) throw new ArtifactError("file_not_regular", "只接受常规文件", 400)
  // 约束：硬链接会让同一 inode 从别处被改写；拒绝 nlink>1。
  if (before.nlink > 1) throw new ArtifactError("file_hardlink", "拒绝硬链接文件", 400)
  // 约束：路径必须落在允许的上传根（realpath 后包含检查，防 `..` 与中间层 symlink 逃逸）。
  assertUploadPathAllowed(absolutePath)
  if (before.size > ARTIFACT_MAX_BYTES) {
    throw new ArtifactError("file_too_large", `文件 ${before.size} 字节，超过 16MiB 上限`, 413)
  }
  let fd: number | undefined
  try {
    // 与计划文件同源的 fd 防线：不能在检查后重新按路径无界读取。
    // O_NONBLOCK 防换成 FIFO 阻塞；再检查实际打开的 inode 与真实根目录。
    fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new ArtifactError("file_changed_during_read", "打开期间文件发生变化，整笔拒绝", 409)
    }
    assertUploadPathAllowed(`/proc/self/fd/${fd}`)
    if (opened.size > ARTIFACT_MAX_BYTES) {
      throw new ArtifactError("file_too_large", `文件 ${opened.size} 字节，超过 16MiB 上限`, 413)
    }
    const buffer = Buffer.alloc(Math.min(opened.size + 1, ARTIFACT_MAX_BYTES + 1))
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length)
      if (count === 0) break
      length += count
    }
    const after = fstatSync(fd)
    const current = lstatSync(absolutePath)
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
        current.dev !== opened.dev || current.ino !== opened.ino || !current.isFile() || current.nlink !== 1) {
      throw new ArtifactError("file_changed_during_read", "读取期间文件发生变化，整笔拒绝", 409)
    }
    const bytes = buffer.subarray(0, length)
    return { absolutePath, bytes, sha256: sha256Hex(bytes), size: bytes.length }
  } catch (e) {
    if (e instanceof ArtifactError) throw e
    throw new ArtifactError("file_read_failed", `读取失败：${e instanceof Error ? e.message : String(e)}`, 400)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** 无外链的本地产物：交付前按既有安全读路径核对当前字节，不依赖 URL 探测状态。 */
export function artifactLocalEvidenceMatches(view: ArtifactVersionView): boolean {
  if (view.url || !view.path || !view.sha256) return false
  try {
    const file = readRegularFile(view.path)
    return file.sha256 === view.sha256 && file.size === view.bytes
  } catch {
    return false
  }
}
interface ProbeOutcome {
  status: number | null
  contentType: string | null
  bytes: number | null
  sha256: string | null
  partial: boolean
  method: string | null
  error: string | null
}

function parseLength(value: string | null): number | null {
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function contentRangeTotal(value: string | null): number | null {
  if (!value) return null
  const match = /\/(\d+)\s*$/.exec(value)
  return match ? Number(match[1]) : null
}

/** P1-5：流式读取并计算 sha256（不再把整个影音文件堆在内存里）。 */
async function readCappedHash(
  response: Response,
  cap: number,
): Promise<{ sha256: string; length: number; truncated: boolean }> {
  const hash = createHash("sha256")
  if (!response.body) {
    const raw = Buffer.from(await response.arrayBuffer())
    const sliced = raw.subarray(0, cap)
    hash.update(sliced)
    return { sha256: hash.digest("hex"), length: sliced.length, truncated: raw.length > cap }
  }
  const reader = response.body.getReader()
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.byteLength === 0) continue
    const room = cap - total
    if (value.byteLength > room) {
      hash.update(value.subarray(0, room))
      total = cap
      truncated = true
      try {
        await reader.cancel()
      } catch {
        // 取消失败不影响已取得的探测证据。
      }
      break
    }
    hash.update(value)
    total += value.byteLength
  }
  return { sha256: hash.digest("hex"), length: total, truncated }
}

// ── SSRF 防护（P0-1）────────────────────────────────────────────────────────
// 判据：scheme 只准 http/https；host 解析后校验实际 IP；每一跳 redirect 重新校验。
class BlockedUrlError extends Error {
  kind: string
  constructor(kind: string, message: string) {
    super(message)
    this.name = "BlockedUrlError"
    this.kind = kind
  }
}

function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase()
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)
  while (host.endsWith(".")) host = host.slice(0, -1)
  return host
}

function parseIpv4Part(part: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(part)) {
    const value = Number.parseInt(part.slice(2), 16)
    return Number.isFinite(value) ? value : null
  }
  // 八进制（前导 0，且后续全为 0-7）；"0" 本身按十进制 0 处理。
  if (/^0[0-7]+$/.test(part)) {
    const value = Number.parseInt(part.slice(1), 8)
    return Number.isFinite(value) ? value : null
  }
  if (/^(0|[1-9]\d*)$/.test(part)) {
    const value = Number(part)
    return Number.isFinite(value) ? value : null
  }
  return null
}

/** 解析十进制/十六进制/八进制/IPv4 简写（`2130706433`、`0x7f000001`、`0177.0.0.1`）。 */
function parseIpv4Literal(host: string): number | null {
  const parts = host.split(".")
  if (parts.length === 0 || parts.length > 4) return null
  const nums: number[] = []
  for (const part of parts) {
    const value = parseIpv4Part(part)
    if (value === null || value < 0) return null
    nums.push(value)
  }
  let value = 0
  for (let i = 0; i < nums.length - 1; i += 1) {
    if (nums[i] > 255) return null
    value = value * 256 + nums[i]
  }
  const last = nums[nums.length - 1]
  const limit = 256 ** (5 - nums.length)
  if (last >= limit) return null
  value = value * limit + last
  return value >>> 0
}

function isPrivateIpv4(value: number): boolean {
  const a = (value >>> 24) & 0xff
  const b = (value >>> 16) & 0xff
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // multicast / reserved / broadcast
  return value === 0xffffffff
}

/** 把 IPv6 文本展开成 8 个 16 位分组；无法解析回 null（调用方按 blocked 处理）。 */
function parseIpv6Groups(raw: string): number[] | null {
  let addr = raw.toLowerCase().split("%")[0]
  // 内嵌 IPv4（::ffff:127.0.0.1 / 64:ff9b::192.168.1.1）先换成两组十六进制。
  if (addr.includes(".")) {
    const idx = addr.lastIndexOf(":")
    if (idx < 0) return null
    const v4 = parseIpv4Literal(addr.slice(idx + 1))
    if (v4 === null) return null
    addr = `${addr.slice(0, idx)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  let head = addr
  let tail = ""
  const doubleColon = addr.indexOf("::")
  if (doubleColon >= 0) {
    head = addr.slice(0, doubleColon)
    tail = addr.slice(doubleColon + 2)
  }
  const headGroups = head ? head.split(":") : []
  const tailGroups = tail ? tail.split(":") : []
  const parse = (parts: string[]): number[] | null => {
    const out: number[] = []
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null
      out.push(Number.parseInt(part, 16))
    }
    return out
  }
  const hs = parse(headGroups)
  const ts = parse(tailGroups)
  if (!hs || !ts) return null
  if (doubleColon >= 0) {
    const missing = 8 - hs.length - ts.length
    if (missing < 0) return null
    return [...hs, ...new Array<number>(missing).fill(0), ...ts]
  }
  return hs.length === 8 ? hs : null
}

function isPrivateIpv6(raw: string): boolean {
  const g = parseIpv6Groups(raw)
  // 解析不了按私网处理（fail-closed）。
  if (!g) return true
  if (g.every((part) => part === 0)) return true // ::
  if (g.slice(0, 7).every((part) => part === 0) && g[7] === 1) return true // ::1
  // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfe80) return true
  // fc00::/7 unique local
  if ((g[0] & 0xfe00) === 0xfc00) return true
  // IPv4-mapped ::ffff:0:0/96 与 IPv4-compatible ::/96
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) {
    return isPrivateIpv4(((g[6] << 16) | g[7]) >>> 0)
  }
  // P2-14：NAT64 64:ff9b::/96 内嵌 IPv4。
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isPrivateIpv4(((g[6] << 16) | g[7]) >>> 0)
  }
  // P2-14：6to4 2002::/16 的第 2、3 组是内嵌 IPv4。
  if (g[0] === 0x2002) {
    return isPrivateIpv4(((g[1] << 16) | g[2]) >>> 0)
  }
  return false
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const value = parseIpv4Literal(address)
    return value === null ? true : isPrivateIpv4(value)
  }
  if (family === 6) return isPrivateIpv6(address)
  return false
}

function hostnameLooksBlocked(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  if (!host) return true
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host.endsWith(".local") || host.endsWith(".internal")) return true
  if (isIP(host) !== 0) return isPrivateAddress(host)
  // URL 未正规化的数字型 IP（十进制/十六进制/八进制）。
  const numeric = parseIpv4Literal(host)
  if (numeric !== null) return isPrivateIpv4(numeric)
  return false
}

/** 解析与校验只做一次；传输层必须用返回的地址钉住实际连接，不能再次解析。 */
export async function resolvePublicHost(hostname: string, signal?: AbortSignal): Promise<Array<{ address: string; family: number }>> {
  signal?.throwIfAborted()
  const host = normalizeHostname(hostname)
  if (hostnameLooksBlocked(host)) {
    throw new BlockedUrlError("private_address", `拒绝内网/本机地址：${hostname}`)
  }
  const family = isIP(host)
  if (family !== 0) return [{ address: host, family }]
  let records: Array<{ address: string; family: number }>
  let abort: (() => void) | undefined
  try {
    const pending = lookup(host, { all: true, verbatim: true })
    records = signal ? await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new Error("probe_timeout"))
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      }),
    ]) : await pending
  } catch (e) {
    if (signal?.aborted) throw e
    throw new BlockedUrlError(
      "dns_resolution_failed",
      `DNS 解析失败：${hostname}（${e instanceof Error ? e.message : String(e)}）`,
    )
  } finally {
    if (abort) signal?.removeEventListener("abort", abort)
  }
  if (records.length === 0) throw new BlockedUrlError("dns_resolution_failed", `DNS 无记录：${hostname}`)
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new BlockedUrlError("private_address", `${hostname} 解析到内网地址 ${record.address}`)
    }
  }
  return records
}

export async function assertPublicHost(hostname: string): Promise<void> {
  await resolvePublicHost(hostname)
}

/** 复用 runtime/lib/sandbox.safeFetch 的 Node request/lookup 钉 IP 传输机制。 */
async function fetchPinnedResponse(target: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const records = await resolvePublicHost(target.hostname, signal)
  signal.throwIfAborted()
  return new Promise<Response>((resolve, reject) => {
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      agent: false,
      signal,
      lookup: (_hostname, options, callback) => (options as { all?: boolean }).all
        ? (callback as Function)(null, records)
        : (callback as Function)(null, records[0].address, records[0].family),
    }, (incoming) => {
      try {
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item)
          else if (value !== undefined) headers.set(name, value)
        }
        const status = incoming.statusCode ?? 502
        const empty = [204, 205, 304].includes(status) || (init.method ?? "GET").toUpperCase() === "HEAD"
        const coding = headers.get("content-encoding")?.toLowerCase()
        const decode = !empty && (coding === "gzip" ? createGunzip() : coding === "deflate" ? createInflate() : coding === "br" ? createBrotliDecompress() : null)
        const stream = decode ? incoming.pipe(decode) : incoming
        if (decode) {
          headers.delete("content-encoding")
          headers.delete("content-length")
          incoming.on("error", (error) => decode.destroy(error))
          decode.on("close", () => incoming.destroy())
        }
        resolve(new Response(empty ? null : Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers }))
        if (empty) incoming.resume()
      } catch (error) {
        incoming.destroy()
        reject(error)
      }
    })
    request.on("error", reject)
    request.end()
  })
}

async function fetchManualRedirects(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let current = url
  const deadline = Date.now() + timeoutMs
  for (let hop = 0; hop <= MAX_PROBE_REDIRECTS; hop += 1) {
    let parsed: URL
    try {
      parsed = new URL(current)
    } catch {
      throw new BlockedUrlError("unsupported_url_scheme", `URL 无法解析：${current}`)
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BlockedUrlError("unsupported_url_scheme", `只允许 http/https：${parsed.protocol}`)
    }
    // 约束：每一跳都校验 host（含 302 → 169.254/127.0.0.1 等跳转型 SSRF）。
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("probe_timeout")
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining)
    const response = await fetchPinnedResponse(parsed, init, signal)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (!location) return response
      try {
        await response.body?.cancel()
      } catch {
        // 丢弃 redirect body 失败不影响后续校验。
      }
      current = new URL(location, current).toString()
      continue
    }
    return response
  }
  throw new BlockedUrlError("too_many_redirects", `redirect 超过 ${MAX_PROBE_REDIRECTS} 跳`)
}

function blockedProbe(error: string): ProbeOutcome {
  return { status: null, contentType: null, bytes: null, sha256: null, partial: false, method: null, error }
}

export async function probeUrl(url: string): Promise<ProbeOutcome> {
  // 约束：只探测 http(s)；其他 scheme 没有可记录的 HTTP 证据。
  if (!/^https?:\/\//i.test(url)) return blockedProbe("unsupported_url_scheme")
  const cap = artifactVerifyMaxBytes()
  let headStatus: number | null = null
  let headType: string | null = null
  let headLength: number | null = null
  let headError: string | null = null
  try {
    const head = await fetchManualRedirects(url, { method: "HEAD" }, PROBE_HEAD_TIMEOUT_MS)
    headStatus = head.status
    headType = head.headers.get("content-type")
    headLength = parseLength(head.headers.get("content-length"))
    try {
      await head.body?.cancel()
    } catch {
      // HEAD body 通常为空。
    }
  } catch (e) {
    if (e instanceof BlockedUrlError) return blockedProbe(e.kind)
    headError = e instanceof Error ? e.message : String(e)
  }

  let getStatus: number | null = null
  let getType: string | null = null
  let getTotal: number | null = null
  let observedSha: string | null = null
  let observedLength: number | null = null
  let getTruncated = false
  let getError: string | null = null
  let getRan = false

  const runGet = async (headers: Record<string, string>): Promise<void> => {
    const get = await fetchManualRedirects(url, { method: "GET", headers }, PROBE_GET_TIMEOUT_MS)
    getStatus = get.status
    getType = get.headers.get("content-type")
    getTotal = contentRangeTotal(get.headers.get("content-range")) ?? parseLength(get.headers.get("content-length"))
    const read = await readCappedHash(get, cap)
    observedSha = read.sha256
    observedLength = read.length
    getTruncated = read.truncated
  }

  // 约束：HEAD 2xx 仍要 GET Range 才能记录 sha256；HEAD 405/501 或抛错时也必须 GET。
  const needGet = headStatus === null || (headStatus >= 200 && headStatus < 300) || headStatus === 405 || headStatus === 501
  if (needGet) {
    getRan = true
    try {
      await runGet({ Range: `bytes=0-${cap - 1}` })
      // P1-4：416 = 服务端不支持/拒绝该 Range；回退无 Range GET 再比对 sha，不得误判 blocked。
      if (getStatus === 416) {
        getStatus = null
        getType = null
        getTotal = null
        observedSha = null
        observedLength = null
        getTruncated = false
        await runGet({})
      }
    } catch (e) {
      if (e instanceof BlockedUrlError) return blockedProbe(e.kind)
      getError = e instanceof Error ? e.message : String(e)
    }
  }

  const status = getStatus ?? headStatus
  const contentType = getType ?? headType
  const sha = observedSha
  const bytes = getTruncated ? cap : getTotal ?? observedLength ?? headLength
  const partial =
    getTruncated ||
    (getTotal !== null && observedLength !== null && getTotal > observedLength) ||
    (getRan && getStatus === 206 && getTotal !== null && observedLength !== null && observedLength < getTotal)
  const error = getError ?? headError
  const method = getRan ? (headStatus !== null ? "HEAD+GET" : "GET") : headStatus !== null ? "HEAD" : null
  return { status, contentType, bytes, sha256: sha, partial, method, error }
}
