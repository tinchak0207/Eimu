// Hugging Face Space（Gradio ≥5，sse_v3 协议）的最小客户端：上传文件 → 入队 → 读 SSE 到完成。
//
// 为什么不用 @gradio/client：运行时是 Bun 沙箱，不为一个上游多拖一棵依赖树；协议只用到
// upload / queue/join / queue/data 三个端点，和 gradio_client 的调用顺序一致。
//
// 有状态的 Space（TRELLIS.2 的 gr.State）靠同一个 session_hash 串起多次调用，
// 所以 GradioSession 一次生成用一个，不复用、不并发。
import { randomUUID } from "node:crypto"

export interface GradioFileRef {
  path: string
  url?: string
  orig_name?: string
  mime_type?: string
  size?: number
  meta: { _type: "gradio.FileData" }
}

export class GradioSpaceError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** 上游把 ZeroGPU 配额用尽、排队过长、Space 休眠等归成可读错误码，供工具回执如实转述。 */
export function classifyGradioMessage(message: string): string {
  const m = message.toLowerCase()
  if (/gpu quota|exceeded your|quota exceeded|zerogpu/.test(m)) return "upstream_quota_exhausted"
  if (/sleeping|paused|building|runtime error|not running/.test(m)) return "upstream_unavailable"
  if (/queue is full|too many/.test(m)) return "upstream_busy"
  return "upstream_failed"
}

export class GradioSession {
  readonly base: string
  readonly sessionHash: string
  private readonly token?: string
  private fnIndex: Map<string, number> | null = null
  /** Gradio 5+ 是 "/gradio_api"，4.x 没有前缀；从 Space 的 /config 读。 */
  private prefix = "/gradio_api"

  constructor(spaceHost: string, token?: string) {
    this.base = spaceHost.replace(/\/$/, "")
    this.sessionHash = randomUUID().replace(/-/g, "").slice(0, 11)
    this.token = token
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}`, ...extra } : extra
  }

  private async ensureConfig(signal?: AbortSignal): Promise<Map<string, number>> {
    if (this.fnIndex) return this.fnIndex
    const res = await fetch(`${this.base}/config`, { headers: this.headers(), signal })
    if (!res.ok) throw new GradioSpaceError("upstream_unavailable", `Space config HTTP ${res.status}`)
    const config: any = await res.json()
    this.prefix = typeof config?.api_prefix === "string" ? config.api_prefix.replace(/\/$/, "") : ""
    const map = new Map<string, number>()
    const deps: any[] = Array.isArray(config?.dependencies) ? config.dependencies : []
    deps.forEach((d, i) => {
      if (typeof d?.api_name === "string") map.set(d.api_name, typeof d.id === "number" ? d.id : i)
    })
    this.fnIndex = map
    return map
  }

  private async resolveFn(apiName: string, signal?: AbortSignal): Promise<number> {
    const idx = (await this.ensureConfig(signal)).get(apiName)
    if (idx === undefined) throw new GradioSpaceError("upstream_contract_changed", `Space 已无 ${apiName} 端点`)
    return idx
  }

  async upload(bytes: Uint8Array, filename: string, mime: string, signal?: AbortSignal): Promise<GradioFileRef> {
    await this.ensureConfig(signal)
    const form = new FormData()
    form.append("files", new Blob([bytes], { type: mime }), filename)
    const res = await fetch(`${this.base}${this.prefix}/upload`, { method: "POST", body: form, headers: this.headers(), signal })
    if (!res.ok) throw new GradioSpaceError("upstream_unavailable", `Space 上传 HTTP ${res.status}`)
    const paths: unknown = await res.json()
    if (!Array.isArray(paths) || typeof paths[0] !== "string") throw new GradioSpaceError("upstream_contract_changed", "Space 上传回执形状不符")
    return { path: paths[0], orig_name: filename, mime_type: mime, size: bytes.byteLength, meta: { _type: "gradio.FileData" } }
  }

  /** 调用一个端点并等到 process_completed；返回 output.data。 */
  async call(apiName: string, data: unknown[], opts: { signal?: AbortSignal; timeoutMs: number; onProgress?: (msg: any) => void }): Promise<unknown[]> {
    const fnIndex = await this.resolveFn(apiName, opts.signal)
    const timed = AbortSignal.timeout(opts.timeoutMs)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timed]) : timed
    const join = await fetch(`${this.base}${this.prefix}/queue/join`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ data, event_data: null, fn_index: fnIndex, trigger_id: null, session_hash: this.sessionHash }),
      signal,
    })
    if (!join.ok) {
      const text = await join.text().catch(() => "")
      throw new GradioSpaceError(classifyGradioMessage(text), `Space 入队 HTTP ${join.status}: ${text.slice(0, 300)}`)
    }
    const { event_id: eventId } = (await join.json()) as { event_id?: string }
    if (!eventId) throw new GradioSpaceError("upstream_contract_changed", "Space 入队未回 event_id")
    const stream = await fetch(`${this.base}${this.prefix}/queue/data?session_hash=${this.sessionHash}`, {
      headers: this.headers({ Accept: "text/event-stream" }),
      signal,
    })
    if (!stream.ok || !stream.body) throw new GradioSpaceError("upstream_unavailable", `Space 事件流 HTTP ${stream.status}`)
    const reader = stream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let cut: number
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          const line = frame.split("\n").find((l) => l.startsWith("data:"))
          if (!line) continue
          let msg: any
          try {
            msg = JSON.parse(line.slice(5).trim())
          } catch {
            continue
          }
          if (msg?.event_id && msg.event_id !== eventId) continue
          if (msg?.msg === "process_completed") {
            if (msg.success === false || msg.output?.error) {
              const text = String(msg.output?.error ?? msg.title ?? "Space 生成失败")
              throw new GradioSpaceError(classifyGradioMessage(text), text.slice(0, 500))
            }
            return Array.isArray(msg.output?.data) ? msg.output.data : []
          }
          if (msg?.msg === "unexpected_error") {
            const text = String(msg.message ?? "Space 返回 unexpected_error")
            throw new GradioSpaceError(classifyGradioMessage(text), text.slice(0, 500))
          }
          opts.onProgress?.(msg)
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    throw new GradioSpaceError("upstream_failed", `Space 事件流在 ${apiName} 完成前关闭`)
  }

  /** Space 产物（gradio 临时文件）下载成字节；临时文件会被 Space 清掉，必须当场转存。 */
  async download(ref: unknown, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    const file = ref as Partial<GradioFileRef> | string | null
    const url =
      typeof file === "string"
        ? `${this.base}${this.prefix}/file=${file}`
        : file?.url ?? (file?.path ? `${this.base}${this.prefix}/file=${file.path}` : null)
    if (!url) throw new GradioSpaceError("upstream_contract_changed", "Space 产物没有文件路径")
    const res = await fetch(url, { headers: this.headers(), signal })
    if (!res.ok) throw new GradioSpaceError("upstream_failed", `Space 产物下载 HTTP ${res.status}`)
    const declared = Number(res.headers.get("content-length") || 0)
    if (declared > maxBytes) throw new GradioSpaceError("artifact_too_large", `产物 ${declared} 字节，超过 ${maxBytes}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > maxBytes) throw new GradioSpaceError("artifact_too_large", `产物 ${buf.byteLength} 字节，超过 ${maxBytes}`)
    if (!buf.byteLength) throw new GradioSpaceError("upstream_failed", "Space 产物为空")
    return buf
  }
}
