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

import { timingSafeEqual } from "node:crypto"
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

export type ExecRoute = "music_gen" | "blender_render"
type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export interface ExecTool {
  execute(args: Record<string, unknown>, context: any): Promise<{ title?: string; output: string }>
}
export interface BridgeFile { path: string; mime: string; bytes: number; durationSec?: number }
type Outcome =
  | { ok: true; files: BridgeFile[]; costCoins: number; chargeRef?: string; provider?: string; chargeError?: string }
  | { ok: false; code: string; message: string; retryable: boolean }
interface ExecRecord {
  idemKey: string; sessionId: string; route: ExecRoute; startedAt: number; finishedAt?: number
  state: "running" | "done" | "failed"
  files?: BridgeFile[]; costCoins?: number; chargeRef?: string; provider?: string
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
  const live = new Set<string>() // 本进程里正在跑的 key；磁盘 running 且不在此集合＝上次崩溃遗留
  const resultsDir = path.join(deps.workspaceDir, "exec-bridge", "results")
  const recordPath = (key: string) => path.join(resultsDir, `${key}.json`)
  const tmpDirOf = (sid: string, key: string) => path.join(deps.workspaceDir, "projects", sid, "tmp", key)

  async function saveRecord(rec: ExecRecord) {
    await mkdir(resultsDir, { recursive: true, mode: 0o755 })
    const tmp = `${recordPath(rec.idemKey)}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(rec), { mode: 0o644 })
    await rename(tmp, recordPath(rec.idemKey))
  }
  async function loadRecord(key: string): Promise<ExecRecord | null> {
    try {
      const rec = JSON.parse(await readFile(recordPath(key), "utf8")) as ExecRecord
      if (now() - (rec.finishedAt ?? rec.startedAt) > retention) return null
      return rec
    } catch { return null }
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

  async function runMusic(body: Body, signal: AbortSignal, outDir: string): Promise<Outcome> {
    if (body.params.probe === true || body.params.probe === "true") return { ok: false, code: "bad_input", message: "probe 不经 exec-bridge", retryable: false }
    const result = await deps.tools.music_gen.execute(body.params, { sessionID: body.sessionId, callID: body.idemKey, abort: signal })
    const parsed = parseToolOutput(result)
    if (!parsed || parsed.ok !== true) return mapToolFailure(parsed, "music_gen 未返回有效回执")
    const cands: { url?: string; duration?: number }[] = Array.isArray(parsed.audios) && parsed.audios.length
      ? parsed.audios.map((a: any) => ({ url: a?.url, duration: a?.duration_seconds }))
      : [{ url: parsed.url, duration: parsed.duration_seconds }]
    const files: BridgeFile[] = []
    const seen = new Set<string>()
    await mkdir(outDir, { recursive: true, mode: 0o755 })
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
      files.push({ path: dest, mime, bytes: got.bytes, ...(typeof c.duration === "number" ? { durationSec: c.duration } : {}) })
      i++
    }
    if (!files.length && inlineB64) {
      const buf = Buffer.from(inlineB64, "base64")
      const dest = path.join(outDir, `music-0.${MIME_EXT[mimeHint] ?? "mp3"}`)
      await writeFile(dest, buf, { mode: 0o644 })
      files.push({ path: dest, mime: mimeHint, bytes: buf.length, ...(typeof parsed.duration_seconds === "number" ? { durationSec: parsed.duration_seconds } : {}) })
    }
    if (!files.length) return { ok: false, code: "provider_error", message: "music_gen 成功回执里没有可取回的音频", retryable: false }
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

  interface Body { sessionId: string; projectId: string; nodeId: string; signature: string; idemKey: string; params: Record<string, unknown> }

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
    const rec: ExecRecord = { idemKey: body.idemKey, sessionId: body.sessionId, route, startedAt: now(), state: "running" }
    await saveRecord(rec)
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
        return route === "music_gen" ? await runMusic(body, ac.signal, outDir) : await runBlender(body, ac.signal, outDir)
      } catch (e: any) {
        if (!started) return { ok: false, code: "timeout", message: "排队超时，未开始执行", retryable: true } as Outcome
        return { ok: false, code: ac.signal.aborted ? "timeout" : "provider_error", message: String(e?.message ?? e).slice(0, 500), retryable: false } as Outcome
      } finally { release?.() }
    })()
    const TIMED_OUT = Symbol("timeout")
    let timer: ReturnType<typeof setTimeout> | undefined
    const first = await Promise.race([work, new Promise<typeof TIMED_OUT>((r) => { timer = setTimeout(() => r(TIMED_OUT), timeoutMs) })])
    clearTimeout(timer)
    const finish = async (o: Outcome, late = false) => {
      rec.finishedAt = now()
      if (o.ok) { Object.assign(rec, { state: "done", files: o.files, costCoins: o.costCoins, chargeRef: o.chargeRef, provider: o.provider }); delete rec.error }
      else Object.assign(rec, { state: "failed", error: { code: o.code, message: o.message, retryable: o.retryable } })
      if (!late) live.delete(body.idemKey)
      await saveRecord(rec)
    }
    if (first === TIMED_OUT) {
      ac.abort()
      const o: Outcome = { ok: false, code: "timeout", message: `${route} 超过 ${timeoutMs}ms`, retryable: !started }
      if (!started) { live.delete(body.idemKey); await rm(recordPath(body.idemKey), { force: true }) } // 从未开始＝没发生过，同 key 可重来
      else await finish(o)
      // 工具若不理会 abort 而是迟到成功：产物已花钱，升级记录供 result 取回；迟到失败不覆盖超时记录。
      work.then(async (late) => { if (late.ok && started) await finish(late, true) }).catch(() => {})
      return json(200, o)
    }
    await finish(first)
    return json(200, first)
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

    const joined = inflight.get(body.idemKey)
    if (joined) return (await joined).clone()
    const cached = await loadRecord(body.idemKey)
    if (cached) {
      if (cached.state === "done") return json(200, { ok: true, files: cached.files, costCoins: cached.costCoins ?? 0, chargeRef: cached.chargeRef, provider: cached.provider, cached: true })
      if (cached.state === "failed") return json(200, { ok: false, ...cached.error, cached: true })
      if (!live.has(body.idemKey)) // 上次进程崩溃遗留：不重投，诚实报未知
        return json(200, { ok: false, code: "submit_unknown", message: "桥重启前该 idemKey 已开始执行，结果未知，请按 result 查询或换新 key", retryable: false })
    }
    const raced = inflight.get(body.idemKey) // loadRecord 期间可能已有同 key 请求开跑
    if (raced) return (await raced).clone()
    const p = execute(route, body)
    inflight.set(body.idemKey, p)
    try { return (await p).clone() } finally { inflight.delete(body.idemKey) }
  }

  async function handleResult(key: string): Promise<Response> {
    if (!SAFE_ID.test(key)) return json(400, { error: "bad_key" })
    const rec = await loadRecord(key)
    if (!rec) return json(200, { state: "unknown" })
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
      if (now() - (rec.finishedAt ?? rec.startedAt) <= retention || live.has(key)) continue
      await rm(tmpDirOf(rec.sessionId, key), { recursive: true, force: true })
      await rm(path.join(resultsDir, name), { force: true })
      removed++
    }
    return removed
  }

  async function handle(req: Request, hooks?: { noTimeout?: () => void }): Promise<Response> {
    const supplied = req.headers.get("x-internal-token") ?? ""
    if (!tokenOk(supplied, deps.token)) return json(403, { error: "forbidden", code: "internal_token_required" })
    const url = new URL(req.url)
    if (req.method === "POST" && (url.pathname === "/v1/exec/music_gen" || url.pathname === "/v1/exec/blender_render")) {
      hooks?.noTimeout?.() // Bun.serve idleTimeout 上限 255s，blender 1200s 必须关掉
      return handlePost(req, url.pathname.endsWith("music_gen") ? "music_gen" : "blender_render")
    }
    const m = url.pathname.match(/^\/v1\/exec\/result\/([^/]+)$/)
    if (req.method === "GET" && m) return handleResult(decodeURIComponent(m[1]))
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
