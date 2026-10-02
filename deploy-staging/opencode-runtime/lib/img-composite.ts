// 圖像編排共用 lib（2026-08-31 片3）。
// 職責：確定性排版/風格工具的基礎設施——公網 blob 上傳（image-data-api）、
// 圖片下載、PIL 沙箱執行（spawn python3 + imgops.py）、VLM 主體框（復用片2 img-orchestrate）。
// 零生圖扣費：本檔絕不觸碰 /images/generations；僅 VLM chat（內部通道）與本地 PIL。
// 此檔不是 tool，不得 export tool 定義，必須放在 tools/ 之外。

import { readFileSync } from "node:fs"
import { mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { vlmAskJson } from "./img-orchestrate"

const CP_ENV = "/opt/image-control-plane/.env.control-plane"
const WORKSPACE = "/opt/agent-harness/workspace"
const RUN_DIR = WORKSPACE + "/.run"
const LIB_DIR = WORKSPACE + "/.opencode/lib"
// 中英混排標題（例「drama-visual-2 镜头拆解」）：Droid Fallback 無拉丁字形→豆腐塊；文泉驛微米黑兩者皆含。
const CJK_FONT = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"
const LATIN_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

// ---------------------------------------------------------------------------
// 公網 blob（image-data-api）：PUT /api/blob/<path> → 公網 GET <base>/files/<path>
// key 僅進程內使用，嚴禁入返回值/日誌。
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

/** 下載圖片為 Buffer（公網/站點 URL 皆可）。失敗拋錯，呼叫端轉 ok:false。 */
export async function downloadImage(url: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`下載原圖失敗 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) throw new Error("下載原圖為空")
  if (buf.length > 25 * 1024 * 1024) throw new Error("原圖超過 25MB")
  return buf
}

/** 上傳 PNG Buffer 到公網 blob，回傳可 GET 的公網 URL。 */
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
  if (!res.ok) throw new Error(`上傳公網失敗 HTTP ${res.status}`)
  const j = (await res.json().catch(() => ({}))) as { url?: string }
  if (!j.url) throw new Error("上傳未返回 url")
  return j.url
}

// ---------------------------------------------------------------------------
// PIL 沙箱：spawn python3，注入 imgops 模組，讀寫本機檔，回傳輸出 Buffer + JSON。
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
        /* 輸出缺失由呼叫端判定 */
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
        PATH: "/opt/agent-harness/bin:/usr/local/bin:/usr/bin:/bin",
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
// VLM 主體框（復用片2 vlmAskJson）。回傳像素 bbox 或 null（失敗誠實標 null，置中退化）。
// ---------------------------------------------------------------------------
const BBOX_Q =
  "這是單張圖像。請框出畫面主體（最主要的單一物件/人物/產品）的邊界框。" +
  '輸出 JSON：{"bbox":[x1,y1,x2,y2]}，座標為相對寬高的千分比（0-1000，左上為原點，x1<x2, y1<y2）。只輸出 JSON。'

export interface SubjectBox {
  ok: boolean
  bbox: [number, number, number, number] | null
  reason?: string
}

/** 取主體框並換算為像素（依 w×h）。VLM 失敗回 ok:false,bbox:null（呼叫端置中退化）。 */
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
  // 千分比 → 像素，先規範化順序再換算，最後夾到邊界
  const px = (v: number, dim: number) => clamp(Math.round((v / 1000) * dim), 0, dim)
  const x1 = px(Math.min(rx1, rx2), w)
  const x2 = px(Math.max(rx1, rx2), w)
  const y1 = px(Math.min(ry1, ry2), h)
  const y2 = px(Math.max(ry1, ry2), h)
  if (x2 - x1 < 8 || y2 - y1 < 8) return { ok: false, bbox: null, reason: "VLM bbox 退化（過小）" }
  return { ok: true, bbox: [x1, y1, x2, y2] }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function pickFont(text: string): string {
  // 含 CJK（中日韓統一/拡張A/標點/全形）用 Droid Fallback，否則 DejaVu
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (
      (c >= 0x3000 && c <= 0x303f) || // CJK 標點
      (c >= 0x3400 && c <= 0x4dbf) || // 拡張 A
      (c >= 0x4e00 && c <= 0x9fff) || // 統一表意
      (c >= 0xf900 && c <= 0xfaff) || // 兼容
      (c >= 0xff00 && c <= 0xffef) // 全形
    )
      return CJK_FONT
  }
  return LATIN_FONT
}

/** 生成唯一 blob 路徑前綴，避免覆蓋。 */
export function blobPath(prefix: string, ext = "png"): string {
  return `agent-batch3/${prefix}-${Date.now()}-${randomBytes(3).toString("hex")}.${ext}`
}
