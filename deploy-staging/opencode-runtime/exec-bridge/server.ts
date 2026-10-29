// exec-bridge（S12，设计文档 §3.6）：让网关调用只能活在 opencode 进程树里的 music_gen / blender_render。
//
// 为什么存在：music_gen（约 6000 行，直接对上游 fetch、扣费走 platformFetch）和 blender_*（桥 127.0.0.1:8765）
// 只能在 opencode runtime 里被调用，网关没有等价函数。把它们拷进网关＝第三份音乐实现。这里起一个独立 Bun 进程，
// import 既有工具的 execute，对外只开两条回环 HTTP 路由，网关经 project/exec-bridge-client.ts 调它。
//
// 调用路径（与模型直接调工具逐行同一）：
//  - music_gen  → tools/music_gen.ts 的 default export（wrapMusicTool + runMusicOperation + 站点 tag 展开 + 出曲入库）。
//                 context.callID=idemKey ⇒ runMusicOperation 的 operation=idemKey ⇒ musicChargeRef=`music:<sid>:<idemKey>`，
//                 同 key 平台只扣一次；同 key 二次调用桥直接回缓存，根本不再进工具。
//  - blender_render → lib/blender-tools-adapter 导出的 blenderRenderTool.execute（wrapBlenderTool 委托的同一函数）。
//                 不走 wrapper 的 publishArtifacts：工程图经 ctx.ingest 入库，再公网发布一次是重复产物。
//
// 鉴权：X-Internal-Token 必须等于 HARNESS_INTERNAL_TOKEN；与网关不同，token 缺失时拒绝启动（fail-closed）。
// 文件交接：产物落 $WORKSPACE_DIR/projects/<sid>/tmp/<idemKey>/，响应只回路径；结果索引落
// $WORKSPACE_DIR/exec-bridge/results/<idemKey>.json，保留 24 小时。写盘只在 workspace 内
// （runtime 以 agentsvc 运行，ReadWritePaths 只有 workspace，见记忆 2026-10-15-runtime-write-root-agentsvc-sqlite-cantopen）。

import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { createReadStream } from "node:fs"
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

export type ExecRoute = "music_gen" | "blender_render"
type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export interface ExecTool {
  execute(args: Record<string, unknown>, context: any): Promise<{ title?: string; output: string }>
}
export interface BridgeFile { path: string; mime: string; bytes: number; durationSec?: number; sha256?: string }
type Outcome =
  | { ok: true; files: BridgeFile[]; costCoins: number; chargeRef?: string; provider?: string; chargeError?: string }
  | { ok: false; code: string; message: string; retryable: boolean; recoverable?: boolean }
interface ExecRecord {
  idemKey: string; sessionId: string; route: ExecRoute; startedAt: number; finishedAt?: number
  state: "running" | "done" | "failed" | "recoverable"
  projectId?: string; nodeId?: string; signature?: string; requestHash?: string
  musicReceipt?: Record<string, any>
  submitted?: boolean
  runId?: string
  ingested?: { at: number; artifacts: { sha256: string; path: string }[] }
  expired?: boolean
  files?: BridgeFile[]; costCoins?: number; chargeRef?: string; provider?: string
  chargeError?: string
  error?: { code: string; message: string; retryable: boolean }
}

export const BRIDGE_PORT = 8767
export const BRIDGE_TIMEOUT_MS: Record<ExecRoute, number> = { music_gen: 240_000, blender_render: 1_200_000 }
export const BRIDGE_CONCURRENCY: Record<ExecRoute, number> = { music_gen: 2, blender_render: 1 }
export const RESULT_RETENTION_MS = 24 * 3600_000
const MAX_BODY_BYTES = 1024 * 1024
const MAX_FILE_BYTES = 200 * 1024 * 1024
const MAX_FILES = 200
// 取回产物用独立超时：工具迟到成功（不理会 abort）时，产物已经花钱，取回不能被已触发的超时信号连坐。
const DOWNLOAD_TIMEOUT_MS = 300_000

export interface BridgeDeps {
  token: string
  workspaceDir: string
  tools: { music_gen: ExecTool; blender_render: ExecTool; blender_exec?: ExecTool }
  timeoutMs?: Partial<Record<ExecRoute, number>>
  concurrency?: Partial<Record<ExecRoute, number>>
  retentionMs?: number
  fetchImpl?: typeof fetch
  artifactHeaders?: () => Record<string, string>
  now?: () => number
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/
const MIME_EXT: Record<string, string> = {
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/wave": "wav", "audio/flac": "flac", "audio/ogg": "ogg", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
  "video/mp4": "mp4", "video/webm": "webm", "model/gltf-binary": "glb", "application/x-blender": "blend",
}
const EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", webm: "video/webm",
  glb: "model/gltf-binary", blend: "application/x-blender", gltf: "model/gltf+json",
}

class Semaphore {
  private active = 0
  private waiters: { go: () => void; dead: boolean }[] = []
  constructor(private readonly limit: number) {}
  /** 排队拿槽；队列里被 abort 则抛出且不占槽。 */
  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new Error("aborted_before_start")
    if (this.active < this.limit) { this.active++; return () => this.release() }
    await new Promise<void>((resolve, reject) => {
      const w = { dead: false, go: () => { signal.removeEventListener("abort", onAbort); resolve() } }
      const onAbort = () => { w.dead = true; reject(new Error("aborted_before_start")) }
      signal.addEventListener("abort", onAbort, { once: true })
      this.waiters.push(w)
    })
    return () => this.release()
  }
  private release() {
    this.active--
    while (this.waiters.length) {
      const w = this.waiters.shift()!
      if (w.dead) continue
      this.active++
      w.go()
      return
    }
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function tokenOk(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function parseToolOutput(r: { output: string } | undefined): Record<string, any> | null {
  try {
    const v = JSON.parse(r?.output ?? "")
    return v && typeof v === "object" ? v : null
  } catch { return null }
}

/** 工具失败回执（两种形状：{error:{code,hint}} 与 runMusicOperation 的 {code,message}）→ 桥错误码。 */
function mapToolFailure(parsed: Record<string, any> | null, fallback: string): Extract<Outcome, { ok: false }> {
  const code = String(parsed?.error?.code ?? parsed?.code ?? "tool_error")
  const message = String(parsed?.error?.hint ?? parsed?.message ?? parsed?.error?.message ?? fallback).slice(0, 500)
  if (/\b(EACCES|EPERM|ENOSPC|EDQUOT|EROFS|ENOTDIR)\b/.test(`${code} ${message}`)) return { ok: false, code: "platform_fault", message: `${code}: ${message}`, retryable: false }
  const table: [RegExp, string, boolean][] = [
    [/price_unknown/, "price_unknown", false],
    [/invalid_args|path_denied/, "bad_input", false],
    [/cancel|spend_not_authorized/, "cancelled", false],
    [/safety|blocked|moderation/, "safety_blocked", false],
    [/timeout/, "timeout", false],
    [/bridge|unreachable|yue2_busy/, "provider_error", true],
    [/identity_missing/, "bad_input", false],
  ]
  for (const [re, mapped, retryable] of table) if (re.test(code)) return { ok: false, code: mapped, message: `${code}: ${message}`, retryable }
  return { ok: false, code: "provider_error", message: `${code}: ${message}`, retryable: false }
}

export function createExecBridge(deps: BridgeDeps) {
  if (!deps.token) throw new Error("exec-bridge: HARNESS_INTERNAL_TOKEN 缺失，拒绝启动")
  const now = deps.now ?? Date.now
  const doFetch = deps.fetchImpl ?? fetch
  const retention = deps.retentionMs ?? RESULT_RETENTION_MS
  const timeouts = { ...BRIDGE_TIMEOUT_MS, ...deps.timeoutMs }
  const sems: Record<ExecRoute, Semaphore> = {
    music_gen: new Semaphore(deps.concurrency?.music_gen ?? BRIDGE_CONCURRENCY.music_gen),
    blender_render: new Semaphore(deps.concurrency?.blender_render ?? BRIDGE_CONCURRENCY.blender_render),
  }
  const inflight = new Map<string, Promise<Response>>()
  const identities = new Map<string, string>()
  const live = new Set<string>() // 本进程里正在跑的 key；磁盘 running 且不在此集合＝上次崩溃遗留
  const resultsDir = path.join(deps.workspaceDir, "exec-bridge", "results")
  const recordPath = (key: string) => path.join(resultsDir, `${key}.json`)
  const tmpDirOf = (sid: string, key: string) => path.join(deps.workspaceDir, "projects", sid, "tmp", key)

  async function saveRecord(rec: ExecRecord) {
    await mkdir(resultsDir, { recursive: true, mode: 0o700 })
    const tmp = `${recordPath(rec.idemKey)}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(rec), { mode: 0o600 })
    await rename(tmp, recordPath(rec.idemKey))
  }
  async function loadRecord(key: string): Promise<ExecRecord | null> {
    try {
      const rec = JSON.parse(await readFile(recordPath(key), "utf8")) as ExecRecord
      return rec
    } catch (e) { if (e.code === "ENOENT") return null; throw e }
  }

  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])])) : value
  const identityOf = (route: ExecRoute, body: Body) => createHash("sha256").update(JSON.stringify(canonical({ route, ...body }))).digest("hex")
  const expired = (rec: ExecRecord) => rec.expired || (!rec.musicReceipt && now() - (rec.finishedAt ?? rec.startedAt) > retention)
  const localFailure = (e: any) => /^(EACCES|EPERM|ENOSPC|EDQUOT|EROFS|ENOENT|ENOTDIR|EEXIST|ELOOP)$/.test(e?.code ?? "")
  async function hashFile(file: string): Promise<string> {
    const hash = createHash("sha256")
    for await (const part of createReadStream(file)) hash.update(part)
    return hash.digest("hex")
  }
  async function filesIntact(rec: ExecRecord): Promise<boolean> {
    if (!rec.files?.length) return false
    try {
      for (const file of rec.files) {
        const info = await stat(file.path)
        if (!info.isFile() || info.size !== file.bytes || (file.sha256 && await hashFile(file.path) !== file.sha256)) return false
        if (rec.route === "music_gen" && !file.sha256) return false
      }
      return true
    } catch { return false }
  }

  async function prepareScratch(outDir: string): Promise<void> {
    // mkdir递归前检查已存在的受控祖先，拒绝跟随符号链接后在用户目录造文件。
    for (const candidate of [path.dirname(path.dirname(outDir)), path.dirname(outDir), outDir]) {
      try { if ((await lstat(candidate)).isSymbolicLink()) throw Object.assign(new Error("项目scratch含符号链接"), { code: "EACCES" }) }
      catch (e) { if (e.code !== "ENOENT") throw e }
    }
    await mkdir(outDir, { recursive: true, mode: 0o2770 })
    // 只改本次桥操作自建目录；项目根/tmp由gateway所有者准备共享组权限。
    const info = await lstat(outDir)
    const workspace = await realpath(deps.workspaceDir)
    const resolved = await realpath(outDir)
    if (!info.isDirectory() || info.isSymbolicLink() || !resolved.startsWith(`${workspace}${path.sep}projects${path.sep}`)) throw Object.assign(new Error("桥scratch含符号链接或越界"), { code: "EACCES" })
    for (const parent of [path.dirname(outDir), path.dirname(path.dirname(outDir))]) if ((await lstat(parent)).isSymbolicLink()) throw Object.assign(new Error("项目scratch祖先含符号链接"), { code: "EACCES" })
    if ((info.mode & 0o2770) !== 0o2770) await chmod(outDir, 0o2770)
    const check = path.join(outDir, `.write-check-${process.pid}`)
    const file = await open(check, "wx", 0o640)
    await file.close()
    await rm(check)
  }

  /** 流式落盘（不整份进内存），返回写入字节数。 */
  async function download(url: string, dest: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ bytes: number; contentType: string }> {
    if (!/^https?:\/\//i.test(url)) throw new Error(`不支持的产物地址：${url.slice(0, 80)}`)
    const res = await doFetch(url, { headers, signal })
    if (!res.ok) { await res.body?.cancel(); throw new Error(`取回产物 HTTP ${res.status}`) }
    const reader = res.body?.getReader()
    if (!reader) throw new Error("产物响应缺少内容")
    const fh = await open(dest, "w", 0o644)
    let bytes = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_FILE_BYTES) { await reader.cancel(); throw new Error("产物超过 200MiB 上限") }
        await fh.write(chunk.value)
      }
    } finally { await fh.close() }
    if (bytes === 0) throw new Error("产物为空")
    return { bytes, contentType: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() }
  }

  async function runMusic(body: Body, signal: AbortSignal, outDir: string, record: ExecRecord): Promise<Outcome> {
    if (body.params.probe === true || body.params.probe === "true") return { ok: false, code: "bad_input", message: "probe 不经 exec-bridge", retryable: false }
    const result = await deps.tools.music_gen.execute(body.params, { sessionID: body.sessionId, callID: body.idemKey, abort: signal })
    const parsed = parseToolOutput(result)
    if (!parsed || parsed.ok !== true) return mapToolFailure(parsed, "music_gen 未返回有效回执")
    // 先保存真实出曲回执，再下载/改名。后续权限或磁盘失败只恢复原回执，不重出曲。
    record.musicReceipt = Object.fromEntries(["audios", "url", "audio_base64", "mime_type", "duration_seconds", "cost_coins", "channel", "charge_error"].filter((key) => parsed[key] !== undefined).map((key) => [key, parsed[key]]))
    await saveRecord(record)
    return materializeMusic(body, outDir, record.musicReceipt)
  }

  async function materializeMusic(body: Body, outDir: string, parsed: Record<string, any>): Promise<Outcome> {
    const cands: { url?: string; duration?: number }[] = Array.isArray(parsed.audios) && parsed.audios.length
      ? parsed.audios.map((a: any) => ({ url: a?.url, duration: a?.duration_seconds }))
      : [{ url: parsed.url, duration: parsed.duration_seconds }]
    const files: BridgeFile[] = []
    const seen = new Set<string>()
    await prepareScratch(outDir)
    let i = 0
    const inlineB64: string | undefined = typeof parsed.audio_base64 === "string" ? parsed.audio_base64 : undefined
    const mimeHint = String(parsed.mime_type ?? "audio/mpeg")
    for (const c of cands) {
      if (typeof c.url !== "string" || !c.url || seen.has(c.url)) continue
      seen.add(c.url)
      const tmpName = path.join(outDir, `music-${i}.part`)
      const got = await download(c.url, tmpName, {}, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS))
      const mime = got.contentType.startsWith("audio/") ? got.contentType : mimeHint
      const dest = path.join(outDir, `music-${i}.${MIME_EXT[mime] ?? "mp3"}`)
      await rename(tmpName, dest)
      files.push({ path: dest, mime, bytes: got.bytes, sha256: await hashFile(dest), ...(typeof c.duration === "number" ? { durationSec: c.duration } : {}) })
      i++
    }
    if (!files.length && inlineB64) {
      const buf = Buffer.from(inlineB64, "base64")
      const dest = path.join(outDir, `music-0.${MIME_EXT[mimeHint] ?? "mp3"}`)
      await writeFile(dest, buf, { mode: 0o644 })
      files.push({ path: dest, mime: mimeHint, bytes: buf.length, sha256: await hashFile(dest), ...(typeof parsed.duration_seconds === "number" ? { durationSec: parsed.duration_seconds } : {}) })
    }
    if (!files.length) return { ok: false, code: "platform_fault", message: "music_gen已返回成功但没有可回收音频，保留原操作核对", retryable: false, recoverable: true }
    const cost = typeof parsed.cost_coins === "number" ? parsed.cost_coins : null
    return {
      ok: true, files, costCoins: cost ?? 0,
      ...(cost !== null ? { chargeRef: `music:${body.sessionId}:${body.idemKey}` } : {}),
      ...(typeof parsed.channel === "string" ? { provider: parsed.channel } : {}),
      ...(cost === null ? { chargeError: String(parsed.charge_error ?? "费用未确认") } : {}),
    }
  }

  async function runBlender(body: Body, signal: AbortSignal, outDir: string): Promise<Outcome> {
    const { script, engine, ...rest } = body.params as Record<string, unknown>
    const ctx = { abort: signal }
    if (typeof script === "string" && script.trim()) {
      if (!deps.tools.blender_exec) return { ok: false, code: "bad_input", message: "本桥未接入 blender_exec，不能先执行 script", retryable: false }
      const built = parseToolOutput(await deps.tools.blender_exec.execute({ script }, ctx))
      if (!built || built.ok !== true) return mapToolFailure(built, "blender_exec 失败")
    }
    const args: Record<string, unknown> = { ...rest }
    if (engine !== undefined && args.render_engine === undefined) args.render_engine = engine
    const parsed = parseToolOutput(await deps.tools.blender_render.execute(args, ctx))
    if (!parsed || parsed.ok !== true) return mapToolFailure(parsed, "blender_render 未返回有效回执")
    const base = typeof parsed.artifact_base_url === "string" ? parsed.artifact_base_url : ""
    let arts: { path: string; bytes?: number }[] = (Array.isArray(parsed.artifacts) ? parsed.artifacts : [])
      .filter((a: any) => typeof a?.path === "string" && EXT_MIME[a.path.split(".").pop()!.toLowerCase()])
    if (arts.some((a) => /\.(mp4|webm)$/i.test(a.path))) arts = arts.filter((a) => !/\.(png|jpe?g|webp)$/i.test(a.path)) // 有成片就不搬中间帧
    arts = arts.slice(0, MAX_FILES)
    if (!arts.length || !base) return { ok: false, code: "provider_error", message: "blender_render 成功回执里没有可取回的产物", retryable: false }
    await mkdir(outDir, { recursive: true, mode: 0o755 })
    const headers = deps.artifactHeaders ? deps.artifactHeaders() : process.env.BLENDER_BRIDGE_TOKEN ? { Authorization: `Bearer ${process.env.BLENDER_BRIDGE_TOKEN}` } : {}
    const files: BridgeFile[] = []
    let n = 0
    for (const a of arts) {
      const ext = a.path.split(".").pop()!.toLowerCase()
      const dest = path.join(outDir, `${String(n++).padStart(4, "0")}-${path.basename(a.path).replace(/[^A-Za-z0-9._-]/g, "_")}`)
      const got = await download(`${base}?path=${encodeURIComponent(a.path)}`, dest, headers, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS))
      files.push({ path: dest, mime: EXT_MIME[ext], bytes: got.bytes })
    }
    return { ok: true, files, costCoins: 0, provider: "blender" }
  }

  interface Body { sessionId: string; projectId: string; nodeId: string; signature: string; idemKey: string; runId?: string; params: Record<string, unknown> }

  function validate(raw: any): Body | string {
    if (!raw || typeof raw !== "object") return "body 必须是 JSON 对象"
    for (const k of ["sessionId", "projectId", "nodeId", "signature", "idemKey"]) {
      if (typeof raw[k] !== "string" || !raw[k]) return `缺少字符串字段 ${k}`
    }
    if (!SAFE_ID.test(raw.idemKey)) return "idemKey 含非法字符"
    if (!SAFE_ID.test(raw.sessionId)) return "sessionId 含非法字符"
    if (!raw.params || typeof raw.params !== "object" || Array.isArray(raw.params)) return "params 必须是对象"
    return raw as Body
  }

  async function execute(route: ExecRoute, body: Body): Promise<Response> {
    const rec: ExecRecord = { idemKey: body.idemKey, sessionId: body.sessionId, projectId: body.projectId, nodeId: body.nodeId, signature: body.signature, runId: body.runId, requestHash: identityOf(route, body), route, startedAt: now(), state: "running" }
    try { await saveRecord(rec) } catch (e: any) { return json(200, { ok: false, code: "platform_fault", message: `桥操作登记失败，未调用上游：${String(e?.message ?? e).slice(0, 300)}`, retryable: false }) }
    live.add(body.idemKey)
    const ac = new AbortController()
    const timeoutMs = timeouts[route]
    let started = false
    const outDir = tmpDirOf(body.sessionId, body.idemKey)
    const work: Promise<Outcome> = (async () => {
      let release: (() => void) | undefined
      try {
        release = await sems[route].acquire(ac.signal)
        started = true
        await prepareScratch(outDir)
        rec.submitted = true
        await saveRecord(rec)
        return route === "music_gen" ? await runMusic(body, ac.signal, outDir, rec) : await runBlender(body, ac.signal, outDir)
      } catch (e: any) {
        if (!started) return { ok: false, code: "timeout", message: "排队超时，未开始执行", retryable: true } as Outcome
        return { ok: false, code: localFailure(e) ? "platform_fault" : ac.signal.aborted ? "timeout" : "provider_error", message: String(e?.message ?? e).slice(0, 500), retryable: false, ...(rec.musicReceipt ? { recoverable: true } : {}) } as Outcome
      } finally { release?.() }
    })()
    const TIMED_OUT = Symbol("timeout")
    let timer: ReturnType<typeof setTimeout> | undefined
    const first = await Promise.race([work, new Promise<typeof TIMED_OUT>((r) => { timer = setTimeout(() => r(TIMED_OUT), timeoutMs) })])
    clearTimeout(timer)
    const finish = async (o: Outcome, late = false) => {
      rec.finishedAt = now()
      if (o.ok) { Object.assign(rec, { state: "done", files: o.files, costCoins: o.costCoins, chargeRef: o.chargeRef, provider: o.provider, chargeError: o.chargeError }); delete rec.error }
      else Object.assign(rec, { state: o.recoverable ? "recoverable" : "failed", error: { code: o.code, message: o.message, retryable: o.retryable } })
      if (!late && !(o.ok === false && o.code === "timeout" && started)) live.delete(body.idemKey)
      try { await saveRecord(rec) } catch (error) {
        if (!rec.musicReceipt) throw error
        // 先前落盘的上游回执仍可恢复，不能因终态落盘失败另出一曲。
      }
    }
    if (first === TIMED_OUT) {
      ac.abort()
      const o: Outcome = { ok: false, code: "timeout", message: `${route} 超过 ${timeoutMs}ms`, retryable: !started }
      if (!started) { live.delete(body.idemKey); await rm(recordPath(body.idemKey), { force: true }) } // 从未开始＝没发生过，同 key 可重来
      else await finish(o)
      // 工具若不理会 abort 而是迟到成功：产物已花钱，升级记录供 result 取回；迟到失败不覆盖超时记录。
      work.then(async (late) => { if (late.ok && started) await finish(late, true) }).catch(() => {}).finally(() => live.delete(body.idemKey))
      return json(200, o)
    }
    await finish(first)
    return json(200, first)
  }

  async function recoverReceipt(rec: ExecRecord): Promise<Response> {
    const existing = inflight.get(rec.idemKey)
    if (existing) return (await existing).clone()
    const body: Body = { sessionId: rec.sessionId, projectId: rec.projectId!, nodeId: rec.nodeId!, signature: rec.signature!, idemKey: rec.idemKey, params: {} }
    const work = (async () => {
      try {
        const outcome = await materializeMusic(body, tmpDirOf(rec.sessionId, rec.idemKey), rec.musicReceipt!)
        if (outcome.ok === true) { Object.assign(rec, { state: "done", files: outcome.files, costCoins: outcome.costCoins, chargeRef: outcome.chargeRef, provider: outcome.provider, chargeError: outcome.chargeError, finishedAt: now(), expired: false }); delete rec.error }
        else Object.assign(rec, { state: "recoverable", error: { code: outcome.code, message: outcome.message, retryable: false } })
        await saveRecord(rec)
        return json(200, outcome)
      } catch (e: any) {
        rec.state = "recoverable"
        rec.error = { code: "platform_fault", message: `原音乐回收失败，未重新生成：${String(e?.message ?? e).slice(0, 300)}`, retryable: false }
        await saveRecord(rec).catch(() => {})
        return json(200, { ok: false, ...rec.error, recoverable: true })
      }
    })()
    inflight.set(rec.idemKey, work)
    identities.set(rec.idemKey, rec.requestHash!)
    try { return (await work).clone() } finally { inflight.delete(rec.idemKey); identities.delete(rec.idemKey) }
  }

  async function handlePost(req: Request, route: ExecRoute): Promise<Response> {
    const len = Number(req.headers.get("content-length") ?? 0)
    if (len > MAX_BODY_BYTES) return json(413, { error: "body_too_large" })
    const text = await req.text()
    if (text.length > MAX_BODY_BYTES) return json(413, { error: "body_too_large" })
    let raw: unknown
    try { raw = JSON.parse(text) } catch { return json(400, { error: "bad_json" }) }
    const body = validate(raw)
    if (typeof body === "string") return json(400, { error: "bad_request", message: body })

    const requestHash = identityOf(route, body)
    if (identities.has(body.idemKey) && identities.get(body.idemKey) !== requestHash) return json(409, { error: "operation_identity_conflict", message: "同一操作身份绑定了不同会话、项目、节点或参数，拒绝复用" })
    const joined = inflight.get(body.idemKey)
    if (joined) return (await joined).clone()
    const cached = await loadRecord(body.idemKey)
    if (cached) {
      if (!cached.requestHash) return json(200, { ok: false, code: "submit_unknown", message: "旧操作缺少可核验归属，保留回执等待核对，未重投", retryable: false })
      if (cached.requestHash !== requestHash) return json(409, { error: "operation_identity_conflict", message: "同一操作身份的归属或输入不匹配，拒绝返回缓存" })
      if (expired(cached)) return cached.musicReceipt ? recoverReceipt(cached) : json(200, { ok: false, code: "submit_unknown", message: "原操作回收期已过，仍保留身份；不重新生成", retryable: false })
      if (cached.musicReceipt && cached.state !== "done" && !live.has(body.idemKey)) return recoverReceipt(cached)
      if (cached.state === "done") {
        if (await filesIntact(cached)) return json(200, { ok: true, files: cached.files, costCoins: cached.costCoins ?? 0, chargeRef: cached.chargeRef, provider: cached.provider, chargeError: cached.chargeError, cached: true })
        if (cached.musicReceipt) return recoverReceipt(cached)
        return json(200, { ok: false, code: "platform_fault", message: "原操作文件已丢失或指纹变化，没有可安全回收的回执；未重新执行", retryable: false, recoverable: true })
      }
      if (cached.state === "failed" && !(cached.error?.code === "platform_fault" && !cached.submitted)) return json(200, { ok: false, ...cached.error, cached: true })
      if (cached.state === "running" && !live.has(body.idemKey)) // 上次进程崩溃遗留：不重投，诚实报未知
        return json(200, { ok: false, code: "submit_unknown", message: "桥重启前该操作已开始执行，结果未知，只按原操作查询，不换键重投", retryable: false })
    }
    const raced = inflight.get(body.idemKey) // loadRecord 期间可能已有同 key 请求开跑
    if (raced) {
      if (identities.get(body.idemKey) !== requestHash) return json(409, { error: "operation_identity_conflict", message: "并发操作归属或输入冲突" })
      return (await raced).clone()
    }
    const p = execute(route, body)
    inflight.set(body.idemKey, p)
    identities.set(body.idemKey, requestHash)
    try { return (await p).clone() } finally { inflight.delete(body.idemKey); identities.delete(body.idemKey) }
  }

  async function handleResult(key: string, scope: URLSearchParams): Promise<Response> {
    if (!SAFE_ID.test(key)) return json(400, { error: "bad_key" })
    const rec = await loadRecord(key)
    if (!rec) return json(200, { state: "unknown" })
    if (!rec.requestHash) return json(200, { state: "unknown" })
    if (["sessionId", "projectId", "nodeId", "signature"].some((field) => scope.get(field) !== rec[field])) return json(403, { state: "unknown", error: "operation_owner_mismatch" })
    if (rec.state === "done" && !await filesIntact(rec)) rec.state = "recoverable"
    if (expired(rec) && !rec.musicReceipt) return json(200, { state: "unknown" })
    if (rec.musicReceipt && (rec.state !== "done" || expired(rec)) && !live.has(key)) {
      const recovered = await (await recoverReceipt(rec)).json() as Outcome
      if (recovered.ok === true) return json(200, { state: "done", files: recovered.files, costCoins: recovered.costCoins, chargeRef: recovered.chargeRef })
      return json(200, { state: "unknown", error: recovered })
    }
    if (rec.state === "running") return json(200, { state: live.has(key) ? "running" : "unknown" })
    if (rec.state === "done") return json(200, { state: "done", files: rec.files, costCoins: rec.costCoins ?? 0, chargeRef: rec.chargeRef })
    return json(200, { state: "failed", error: rec.error })
  }

  /** 清理超过保留期的结果索引与其产物目录。 */
  async function sweep(): Promise<number> {
    let removed = 0
    for (const name of await readdir(resultsDir).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue
      const key = name.slice(0, -5)
      let rec: ExecRecord
      try { rec = JSON.parse(await readFile(path.join(resultsDir, name), "utf8")) } catch { continue }
      if (rec.expired) continue
      // 桥尚无gateway耐久消费ACK；TTL不是交付证明。付费音乐的原文件/回执先保全。
      if (rec.musicReceipt && !rec.ingested) continue
      if (now() - (rec.finishedAt ?? rec.startedAt) <= retention || live.has(key)) continue
      await rm(tmpDirOf(rec.sessionId, key), { recursive: true, force: true })
      // 清媒体不清操作身份；同key过期后不能再次花钱。
      delete rec.files
      if (rec.ingested) delete rec.musicReceipt
      rec.expired = true
      await saveRecord(rec)
      removed++
    }
    return removed
  }

  async function handleIngested(req: Request): Promise<Response> {
    const input = await req.json().catch(() => null) as any
    if (!input || !SAFE_ID.test(input.idemKey ?? "")) return json(400, { ok: false })
    const rec = await loadRecord(input.idemKey)
    if (!rec || !rec.runId || !rec.requestHash || ["sessionId", "projectId", "nodeId", "signature", "runId"].some((field) => input[field] !== rec[field])) return json(409, { ok: false, error: "operation_identity_conflict" })
    if (!Array.isArray(input.artifacts) || !input.artifacts.length || input.artifacts.length > MAX_FILES) return json(400, { ok: false })
    if (rec.ingested) return json(200, { ok: JSON.stringify(canonical(rec.ingested.artifacts)) === JSON.stringify(canonical(input.artifacts)), stage: "ingested", already: true })
    if (rec.state !== "done" || !rec.files?.length || rec.files.some((file) => !file.sha256 || !input.artifacts.some((artifact: any) => artifact.sha256 === file.sha256))) return json(409, { ok: false, error: "artifact_identity_mismatch" })
    const destination = path.join(await realpath(deps.workspaceDir), "projects", rec.sessionId, "artifacts")
    for (const artifact of input.artifacts) {
      if (typeof artifact.path !== "string" || !rec.files.some((file) => file.sha256 === artifact.sha256)) return json(409, { ok: false })
      try {
        const resolved = await realpath(artifact.path)
        if (path.dirname(resolved) !== destination || await hashFile(resolved) !== artifact.sha256) return json(409, { ok: false, error: "durable_artifact_not_proven" })
      } catch { return json(409, { ok: false, error: "durable_artifact_unreadable" }) }
    }
    rec.ingested = { at: now(), artifacts: input.artifacts.map(({ sha256, path }: any) => ({ sha256, path })) }
    await saveRecord(rec)
    return json(200, { ok: true, stage: "ingested" })
  }

  async function handle(req: Request, hooks?: { noTimeout?: () => void }): Promise<Response> {
    const supplied = req.headers.get("x-internal-token") ?? ""
    if (!tokenOk(supplied, deps.token)) return json(403, { error: "forbidden", code: "internal_token_required" })
    const url = new URL(req.url)
    if (req.method === "POST" && url.pathname === "/v1/exec/ingested") return handleIngested(req)
    if (req.method === "POST" && (url.pathname === "/v1/exec/music_gen" || url.pathname === "/v1/exec/blender_render")) {
      hooks?.noTimeout?.() // Bun.serve idleTimeout 上限 255s，blender 1200s 必须关掉
      return handlePost(req, url.pathname.endsWith("music_gen") ? "music_gen" : "blender_render")
    }
    const m = url.pathname.match(/^\/v1\/exec\/result\/([^/]+)$/)
    if (req.method === "GET" && m) return handleResult(decodeURIComponent(m[1]), url.searchParams)
    return json(404, { error: "not_found" })
  }

  return { handle, sweep }
}

async function loadRealTools(): Promise<BridgeDeps["tools"]> {
  const music = (await import("../tools/music_gen")).default as ExecTool
  const blender = await import("../lib/blender-tools-adapter")
  return { music_gen: music, blender_render: blender.blenderRenderTool as ExecTool, blender_exec: blender.blenderExecTool as ExecTool }
}

export async function startExecBridge(env: Record<string, string | undefined> = process.env) {
  const token = env.HARNESS_INTERNAL_TOKEN
  if (!token) throw new Error("exec-bridge: HARNESS_INTERNAL_TOKEN 缺失，拒绝启动（fail-closed，不做回环信任降级）")
  const bridge = createExecBridge({ token, workspaceDir: env.WORKSPACE_DIR || "/opt/agent-harness/workspace", tools: await loadRealTools() })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(env.EXEC_BRIDGE_PORT || BRIDGE_PORT),
    idleTimeout: 255,
    fetch: (req, srv) => bridge.handle(req, { noTimeout: () => srv.timeout(req, 0) }),
  })
  const sweeper = setInterval(() => void bridge.sweep().catch(() => {}), 3600_000)
  sweeper.unref?.()
  void bridge.sweep().catch(() => {})
  return server
}

if (import.meta.main) {
  startExecBridge().then((s) => console.log(`[exec-bridge] listening ${s.hostname}:${s.port}`)).catch((e) => {
    console.error(String(e?.message ?? e))
    process.exit(1)
  })
}
