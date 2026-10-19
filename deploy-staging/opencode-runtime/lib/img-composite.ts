// 图像编排共用 lib（2026-08-31 片3）。
// 职责：确定性排版/风格工具的基础设施——公网 blob 上传（image-data-api）、
// 图片下载、PIL 沙箱执行（spawn python3 + imgops.py）、VLM 主体框（复用片2 img-orchestrate）。
// 零生图扣费：本档绝不触碰 /images/generations；仅 VLM chat（内部通道）与本地 PIL。
// 此档不是 tool，不得 export tool 定义，必须放在 tools/ 之外。

import { readFileSync } from "node:fs"
import { mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { vlmAskJson } from "./img-orchestrate"

const CP_ENV = "/opt/eimu-control-plane/.env.control-plane"
const WORKSPACE = "/opt/eimu-harness/workspace"
const RUN_DIR = WORKSPACE + "/.run"
const LIB_DIR = WORKSPACE + "/.opencode/lib"
// 中英混排标题（例「drama-visual-2 镜头拆解」）：Droid Fallback 无拉丁字形→豆腐块；文泉驿微米黑两者皆含。
const CJK_FONT = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"
const LATIN_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

// ---------------------------------------------------------------------------
// 公网 blob（image-data-api）：PUT /api/blob/<path> → 公网 GET <base>/files/<path>
// key 仅进程内使用，严禁入返回值/日志。
// ---------------------------------------------------------------------------
let blobCfg: { base: string; key: string } | null = null

export function resolveBlob(): { base: string; key: string } | null {
  if (blobCfg) return blobCfg
  try {
    const txt = readFileSync(CP_ENV, "utf8")
    const pick = (k: string): string | null => {
      const m = txt.match(new RegExp(`^${k}=(.*)$`, "m"))
      if (!m) return null
      return m[1].trim().replace(/^["']|["']$/g, "") || null
    }
    const base = pick("IMAGE_DATA_BASE_URL")
    const key = pick("IMAGE_DATA_API_KEY")
    if (!base || !key) return null
    blobCfg = { base: base.replace(/\/+$/, ""), key }
    return blobCfg
  } catch {
    return null
  }
}

/** 下载图片为 Buffer（公网/站点 URL 皆可）。失败抛错，呼叫端转 ok:false。 */
export async function downloadImage(url: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`下载原图失败 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) throw new Error("下载原图为空")
  if (buf.length > 25 * 1024 * 1024) throw new Error("原图超过 25MB")
  return buf
}

/** 上传 PNG Buffer 到公网 blob，回传可 GET 的公网 URL。 */
export async function uploadBlob(
  pathname: string,
  buf: Buffer,
  contentType = "image/png",
  signal?: AbortSignal,
): Promise<string> {
  const cfg = resolveBlob()
  if (!cfg) throw new Error("blob 通道未配置（control-plane env 缺 IMAGE_DATA_*）")
  const enc = pathname
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/")
  const res = await fetch(`${cfg.base}/api/blob/${enc}`, {
    method: "PUT",
    headers: {
      "x-image-data-key": cfg.key,
      "x-content-type": contentType,
      "Content-Type": "application/octet-stream",
    },
    body: buf as unknown as BodyInit,
    signal: signal ?? AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`上传公网失败 HTTP ${res.status}`)
  const j = (await res.json().catch(() => ({}))) as { url?: string }
  if (!j.url) throw new Error("上传未返回 url")
  return j.url
}

// ---------------------------------------------------------------------------
// PIL 沙箱：spawn python3，注入 imgops 模组，读写本机档，回传输出 Buffer + JSON。
// ---------------------------------------------------------------------------
export interface PilJob {
  inputs?: Record<string, Buffer>
  params?: Record<string, unknown>
  outputs?: string[]
  code: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface PilResult {
  ok: boolean
  result?: Record<string, unknown>
  files?: Record<string, Buffer>
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

export async function runPIL(job: PilJob): Promise<PilResult> {
  const dir = `${RUN_DIR}/b3-${Date.now()}-${randomBytes(4).toString("hex")}`
  await mkdir(dir, { recursive: true })
  try {
    const inPaths: Record<string, string> = {}
    for (const [name, buf] of Object.entries(job.inputs || {})) {
      const p = `${dir}/in_${name}`
      await writeFile(p, buf)
      inPaths[name] = p
    }
    const outPaths: Record<string, string> = {}
    for (const name of job.outputs || []) outPaths[name] = `${dir}/out_${name}`
    const jobPath = `${dir}/job.json`
    await writeFile(jobPath, JSON.stringify({ inputs: inPaths, params: job.params || {}, outputs: outPaths }))

    const preamble =
      `import sys, json\n` +
      `sys.path.insert(0, ${JSON.stringify(LIB_DIR)})\n` +
      `from PIL import Image\n` +
      `import imgops\n` +
      `JOB=json.load(open(${JSON.stringify(jobPath)}))\n` +
      `IN=JOB['inputs']; PARAMS=JOB['params']; OUT=JOB['outputs']\n` +
      `_RESULT={}\n` +
      `def emit(**kw):\n` +
      `    _RESULT.update(kw)\n` +
      `def load(name):\n` +
      `    return Image.open(IN[name])\n`
    const script = preamble + "\n" + job.code + `\nprint("@@B3RESULT@@"+json.dumps(_RESULT))\n`
    const pyPath = `${dir}/main.py`
    await writeFile(pyPath, script)

    const run = await spawnPython(pyPath, dir, job.timeoutMs ?? 90_000, job.signal)
    if (run.code !== 0 || run.timedOut) {
      return { ok: false, stderr: run.stderr || `exit=${run.code}`, exitCode: run.code, timedOut: run.timedOut }
    }
    let result: Record<string, unknown> | undefined
    const marker = "@@B3RESULT@@"
    const idx = run.stdout.lastIndexOf(marker)
    if (idx >= 0) {
      try {
        result = JSON.parse(run.stdout.slice(idx + marker.length).trim())
      } catch {
        /* 保留 undefined */
      }
    }
    const files: Record<string, Buffer> = {}
    for (const name of job.outputs || []) {
      try {
        files[name] = await readFile(outPaths[name])
      } catch {
        /* 输出缺失由呼叫端判定 */
      }
    }
    return { ok: true, result, files, stderr: run.stderr, exitCode: run.code, timedOut: false }
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function spawnPython(
  file: string,
  tmpDir: string,
  timeoutMs: number,
  abort?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [file], {
      cwd: tmpDir,
      env: {
        PATH: "/opt/eimu-harness/bin:/usr/local/bin:/usr/bin:/bin",
        HOME: WORKSPACE,
        TMPDIR: tmpDir,
        LANG: "C.UTF-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
    const onAbort = () => {
      timedOut = true
      child.kill("SIGKILL")
    }
    if (abort) abort.addEventListener("abort", onAbort, { once: true })
    child.stdout.on("data", (d) => {
      if (stdout.length < 256 * 1024) stdout += d
    })
    child.stderr.on("data", (d) => {
      if (stderr.length < 64 * 1024) stderr += d
    })
    child.on("error", (e) => {
      clearTimeout(timer)
      if (abort) abort.removeEventListener("abort", onAbort)
      reject(e)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (abort) abort.removeEventListener("abort", onAbort)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

// ---------------------------------------------------------------------------
// VLM 主体框（复用片2 vlmAskJson）。回传像素 bbox 或 null（失败诚实标 null，置中退化）。
// ---------------------------------------------------------------------------
const BBOX_Q =
  "这是单张图像。请框出画面主体（最主要的单一物件/人物/产品）的边界框。" +
  '输出 JSON：{"bbox":[x1,y1,x2,y2]}，座标为相对宽高的千分比（0-1000，左上为原点，x1<x2, y1<y2）。只输出 JSON。'

export interface SubjectBox {
  ok: boolean
  bbox: [number, number, number, number] | null
  reason?: string
}

/** 取主体框并换算为像素（依 w×h）。VLM 失败回 ok:false,bbox:null（呼叫端置中退化）。 */
export async function subjectBox(
  imageUrl: string,
  w: number,
  h: number,
): Promise<SubjectBox> {
  const r = await vlmAskJson([imageUrl], BBOX_Q, 500)
  if (!r.ok) return { ok: false, bbox: null, reason: r.reason }
  const raw = (r.data as { bbox?: unknown }).bbox
  if (!Array.isArray(raw) || raw.length !== 4 || raw.some((v) => typeof v !== "number")) {
    return { ok: false, bbox: null, reason: "VLM bbox 格式非法" }
  }
  let [rx1, ry1, rx2, ry2] = raw as number[]
  // 千分比 → 像素，先规范化顺序再换算，最后夹到边界
  const px = (v: number, dim: number) => clamp(Math.round((v / 1000) * dim), 0, dim)
  const x1 = px(Math.min(rx1, rx2), w)
  const x2 = px(Math.max(rx1, rx2), w)
  const y1 = px(Math.min(ry1, ry2), h)
  const y2 = px(Math.max(ry1, ry2), h)
  if (x2 - x1 < 8 || y2 - y1 < 8) return { ok: false, bbox: null, reason: "VLM bbox 退化（过小）" }
  return { ok: true, bbox: [x1, y1, x2, y2] }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function pickFont(text: string): string {
  // 含 CJK（中日韩统一/拡张A/标点/全形）用 Droid Fallback，否则 DejaVu
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (
      (c >= 0x3000 && c <= 0x303f) || // CJK 标点
      (c >= 0x3400 && c <= 0x4dbf) || // 拡张 A
      (c >= 0x4e00 && c <= 0x9fff) || // 统一表意
      (c >= 0xf900 && c <= 0xfaff) || // 兼容
      (c >= 0xff00 && c <= 0xffef) // 全形
    )
      return CJK_FONT
  }
  return LATIN_FONT
}

/** 生成唯一 blob 路径前缀，避免覆盖。 */
export function blobPath(prefix: string, ext = "png"): string {
  return `agent-batch3/${prefix}-${Date.now()}-${randomBytes(3).toString("hex")}.${ext}`
}
