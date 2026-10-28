// 工程产物入库：内容寻址（artifactId = "art_" + sha256 前 16 位）。设计文档 §3.4。
// 布局：<projectDir>/artifacts/<artifactId><ext> + <artifactId>.meta.json（sha256/mime/bytes）。
// 与 artifact-store-io.ts 的 sha256Hex 同一套哈希（node:crypto sha256 hex），但不复用其 16MB 上限（视频会超）。
import { createHash, randomBytes } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { resolvePublicHost } from "../artifact-store-io.ts"
import type { ArtifactId, FingerprintResolver, Output, Sha256 } from "./types.ts"

const MIME_EXT: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
  "video/mp4": ".mp4", "video/webm": ".webm", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
  "audio/mp4": ".m4a", "audio/ogg": ".ogg", "application/json": ".json", "text/plain": ".txt", "text/vtt": ".vtt",
  "application/x-subrip": ".srt", "application/zip": ".zip", "model/gltf-binary": ".glb",
}
const EXT_MIME: Record<string, string> = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]))
EXT_MIME[".jpeg"] = "image/jpeg"

export const DEFAULT_MAX_INGEST_BYTES = 2 * 1024 * 1024 * 1024
const MAX_REDIRECTS = 3

export interface ArtifactMeta { sha256: Sha256; mime: string; bytes: number; file: string; createdAt: string }
export interface IngestHint { port: string; mime?: string; origin: Output["origin"] }
export interface ArtifactStoreOptions {
  /** 工程目录（projects/<sid>）；path 入库只允许该目录或 allowedPathRoots 之内的常规文件。 */
  projectDir: string
  allowedPathRoots?: string[]
  maxBytes?: number
  fetchImpl?: typeof fetch
  /** 仅测试：允许内网/回环地址（fake HTTP 服务器）。生产保持 false。 */
  allowPrivateNetwork?: boolean
  now?: () => Date
}

export function artifactIdForSha(sha: Sha256): ArtifactId {
  return "art_" + sha.slice(0, 16)
}
export const ARTIFACT_ID_RE = /^art_[0-9a-f]{16}$/

async function hashFile(file: string): Promise<{ sha: Sha256; bytes: number }> {
  const h = createHash("sha256")
  let bytes = 0
  for await (const chunk of createReadStream(file)) {
    h.update(chunk as Buffer)
    bytes += (chunk as Buffer).length
  }
  return { sha: h.digest("hex"), bytes }
}

function safeExt(raw: string | undefined): string {
  if (!raw) return ""
  const e = raw.toLowerCase()
  return /^\.[a-z0-9]{1,8}$/.test(e) ? e : ""
}

export class ArtifactStore implements FingerprintResolver {
  readonly dir: string
  private readonly opts: ArtifactStoreOptions
  constructor(opts: ArtifactStoreOptions) {
    this.opts = opts
    this.dir = path.join(opts.projectDir, "artifacts")
  }

  private metaPath(id: ArtifactId): string {
    return path.join(this.dir, `${id}.meta.json`)
  }

  private async readMeta(id: ArtifactId): Promise<ArtifactMeta | null> {
    if (!ARTIFACT_ID_RE.test(id)) return null
    try {
      const meta = JSON.parse(await readFile(this.metaPath(id), "utf-8")) as ArtifactMeta
      return meta && typeof meta.sha256 === "string" && typeof meta.file === "string" ? meta : null
    } catch {
      return null
    }
  }

  /** 文件和元数据都在、字节数对得上才算存在（缓存命中前的廉价复核；不重算 sha）。 */
  async get(id: ArtifactId, hint?: { port?: string; origin?: Output["origin"] }): Promise<Output | null> {
    const meta = await this.readMeta(id)
    if (!meta) return null
    const file = path.join(this.dir, meta.file)
    try {
      const st = await stat(file)
      if (!st.isFile() || st.size !== meta.bytes) return null
    } catch {
      return null
    }
    return { port: hint?.port ?? "out", artifactId: id, sha256: meta.sha256, path: file, mime: meta.mime, bytes: meta.bytes, origin: hint?.origin ?? "derived" }
  }

  /** FingerprintResolver：产物不在/被改（字节数不符）→ 抛错 → 签名 unstable。 */
  async fileSha256(id: ArtifactId): Promise<Sha256> {
    const out = await this.get(id)
    if (!out) throw new Error(`artifact missing: ${id}`)
    return out.sha256
  }

  /** 重算 sha256 与元数据比对（审计/修复用，不在热路径）。 */
  async verify(id: ArtifactId): Promise<boolean> {
    const out = await this.get(id)
    if (!out) return false
    return (await hashFile(out.path)).sha === out.sha256
  }

  async putBytes(bytes: Uint8Array | string, hint: IngestHint & { ext?: string }): Promise<Output> {
    const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf-8") : Buffer.from(bytes)
    const max = this.opts.maxBytes ?? DEFAULT_MAX_INGEST_BYTES
    if (buf.length > max) throw new Error(`artifact too large: ${buf.length} > ${max}`)
    await mkdir(this.dir, { recursive: true })
    const tmp = path.join(this.dir, `.in-${randomBytes(6).toString("hex")}.tmp`)
    await writeFile(tmp, buf)
    return this.adopt(tmp, createHash("sha256").update(buf).digest("hex"), buf.length, hint)
  }

  /** 把已写好的临时文件按内容收编（已存在同 id 产物则丢弃临时文件，幂等）。 */
  private async adopt(tmp: string, sha: Sha256, bytes: number, hint: IngestHint & { ext?: string }): Promise<Output> {
    const id = artifactIdForSha(sha)
    const mime = (hint.mime ?? "application/octet-stream").split(";")[0].trim().toLowerCase() || "application/octet-stream"
    const existing = await this.get(id, { port: hint.port, origin: hint.origin })
    if (existing && existing.sha256 === sha) {
      await rm(tmp, { force: true })
      return existing
    }
    const ext = safeExt(hint.ext) || MIME_EXT[mime] || ""
    const file = `${id}${ext}`
    const final = path.join(this.dir, file)
    await rename(tmp, final)
    const meta: ArtifactMeta = { sha256: sha, mime, bytes, file, createdAt: (this.opts.now?.() ?? new Date()).toISOString() }
    const metaTmp = `${this.metaPath(id)}.${randomBytes(4).toString("hex")}.tmp`
    await writeFile(metaTmp, JSON.stringify(meta), "utf-8")
    await rename(metaTmp, this.metaPath(id))
    return { port: hint.port, artifactId: id, sha256: sha, path: final, mime, bytes, origin: hint.origin }
  }

  private async allowedRoots(): Promise<string[]> {
    const roots = [this.opts.projectDir, ...(this.opts.allowedPathRoots ?? [])]
    const out: string[] = []
    for (const r of roots) {
      try { out.push(await realpath(r)) } catch { out.push(path.resolve(r)) }
    }
    return out
  }

  /** ctx.ingest 的实现：本地路径（限定目录内常规文件）或 URL（公网 http/https，重定向逐跳校验）。 */
  async ingest(src: { path: string } | { url: string }, hint: IngestHint, extra?: { signal?: AbortSignal }): Promise<Output> {
    await mkdir(this.dir, { recursive: true })
    const tmp = path.join(this.dir, `.in-${randomBytes(6).toString("hex")}.tmp`)
    try {
      if ("path" in src) return await this.ingestPath(src.path, tmp, hint)
      return await this.ingestUrl(src.url, tmp, hint, extra?.signal)
    } catch (e) {
      await rm(tmp, { force: true })
      throw e
    }
  }

  private async ingestPath(inputPath: string, tmp: string, hint: IngestHint): Promise<Output> {
    if (!path.isAbsolute(inputPath)) throw new Error("ingest path must be absolute")
    const lst = await lstat(inputPath)
    if (lst.isSymbolicLink() || !lst.isFile()) throw new Error("ingest path must be a regular file")
    const real = await realpath(inputPath)
    const roots = await this.allowedRoots()
    if (!roots.some((r) => real === r || real.startsWith(r + path.sep))) throw new Error("ingest path outside allowed roots")
    const max = this.opts.maxBytes ?? DEFAULT_MAX_INGEST_BYTES
    if (lst.size > max) throw new Error(`artifact too large: ${lst.size} > ${max}`)
    await copyFile(real, tmp)
    const { sha, bytes } = await hashFile(tmp)
    const ext = path.extname(real)
    return this.adopt(tmp, sha, bytes, { ...hint, mime: hint.mime ?? EXT_MIME[ext.toLowerCase()], ext })
  }

  private async ingestUrl(rawUrl: string, tmp: string, hint: IngestHint, signal?: AbortSignal): Promise<Output> {
    const doFetch = this.opts.fetchImpl ?? fetch
    let url = new URL(rawUrl)
    let res: Response | null = null
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("ingest url must be http(s)")
      if (!this.opts.allowPrivateNetwork) await resolvePublicHost(url.hostname, signal)
      res = await doFetch(url, { redirect: "manual", signal })
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location") as string, url)
        await res.body?.cancel()
        res = null
        continue
      }
      break
    }
    if (!res) throw new Error("too many redirects")
    if (!res.ok || !res.body) throw new Error(`ingest http ${res.status}`)
    const max = this.opts.maxBytes ?? DEFAULT_MAX_INGEST_BYTES
    const declared = Number(res.headers.get("content-length") ?? "0")
    if (declared > max) throw new Error(`artifact too large: ${declared} > ${max}`)
    const h = createHash("sha256")
    let bytes = 0
    const counter = async function* (src: AsyncIterable<Uint8Array>) {
      for await (const chunk of src) {
        bytes += chunk.length
        if (bytes > max) throw new Error(`artifact too large: >${max}`)
        h.update(chunk)
        yield chunk
      }
    }
    await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(tmp), signal ? { signal } : {})
    const mime = hint.mime ?? res.headers.get("content-type")?.split(";")[0].trim() ?? EXT_MIME[path.extname(url.pathname).toLowerCase()]
    return this.adopt(tmp, h.digest("hex"), bytes, { ...hint, mime, ext: path.extname(url.pathname) })
  }
}
