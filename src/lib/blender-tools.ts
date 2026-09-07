/**
 * Blender 工具族（Astra 3D 導演工作站 P0-4，片C，2026-09-06）。
 *
 * 三個工具：blender_exec / blender_render / blender_export_gltf。
 * 定義形狀同構 src/vendor-bridges/opencode-tools/director_*.ts 的
 * tool({ description, args, execute }) + ok()/fail() 契約（回 { title, output }，
 * output 為 JSON 字串）；因 @opencode-ai/plugin 與 zod 不在 src/lib 可解析範圍
 * （tsconfig exclude src/vendor-bridges，根 package.json 無此依賴），本檔以零依賴
 * 同構結構承載同名欄位，VPS .opencode/tools/ 落位時逐條譯成 tool.schema 調用、
 * execute 體原樣搬運即可。
 *
 * 傳輸契約（與片 A 逐字共享，橋由片 A 施工；artifact 端點為片 AJ 追加）：
 *   GET  /v1/health → 200 {ok:true, blender_version, gpu:"egl"|"cpu", workdir}
 *   POST /v1/execute body {script:string, timeout_ms?:number} →
 *     200 {ok:true, artifacts:[{path,bytes,kind}], scene_summary:string, stdout_tail:string, duration_ms:number}
 *     500 {ok:false, error:string, stdout_tail:string}
 *   GET  /v1/artifact?path=<out/ 內相對路徑> → 200 binary（Content-Type 按副檔名白名單）
 * 橋位址 = env BLENDER_BRIDGE_URL（默認 http://127.0.0.1:8765）。
 *
 * 產物取回（片 AJ，T1 斷點修復）：產物落在橋主機 out/，agent 沙箱（VPS）與橋主機
 * 異構、沙箱不自持檔案 → exec/render 成功 result 帶 artifact_base_url（=
 * ${bridgeUrl()}/v1/artifact，bridgeUrl 即 env BLENDER_BRIDGE_URL——VPS 側經
 * blender-bridge-tunnel 反向隧道指向橋主機，同一 base 即取回入口），agent 用
 * `${artifact_base_url}?path=${encodeURIComponent(artifact.path)}` 逐檔取回字節。
 * 禁止在沙箱 ls/find 等本機檔案。
 *
 * 錯誤鐵律：橋未就緒/超時/非 200 一律返回結構化 fail()（含「桥未启动，请先启动
 * blender-bridge」指引），絕不 throw 原始 fetch 錯誤。
 * deny 例外暫存與橋接說明：docs/blender-bridge-notes.md。
 * 工具文案一律簡體（記憶 agent-gateway-copy-rules）。
 *
 * Blender 5.2 兼容 + 存活配方（2026-09-06 片M 修復，依 smoke P0-5 實錘
 * 2026-09-06-blender-bridge-render-crash-survival-recipe）：
 *   ① slotted action：action.fcurves 已死 → channelbags 路徑（verify_keyframe.py 同構）。
 *   ② file_format="FFMPEG" enum 已死 → turntable 不再走橋內 muxer（in-process
 *      muxer 必崩出 48 字節 stub），改分塊 ≤10 幀 PNG + 工具層系統 ffmpeg 合成 H264。
 *   ③ Eevee previz 存活預設 samples=1 + RT off（負載越大橋內越易 native 崩；cycles 不受限）。
 *
 * export 註記（2026-09-06 片AA）：buildChunkRenderScript 供 generation-core 的
 * blender_bridge 適配層（supplier-adapter.ts generateWithBlenderNode）直接 import
 * 復用——單幀 still 路徑（chunkStart=null + turntable=false）即節點派發的安全單位，
 * 零複本零漂移（存活配方修復只落一處）。
 */

// ── 常量與類型 ──────────────────────────────────────────────────────────────

import { spawn } from "node:child_process"
import * as fsp from "node:fs/promises"
import * as nodePath from "node:path"
import { findTemplateByFingerprint, fingerprintScript, saveSceneAssets } from "./blender-asset-store"

const EXEC_DEFAULT_TIMEOUT_MS = 120_000
const RENDER_DEFAULT_TIMEOUT_MS = 1_800_000
const EXPORT_DEFAULT_TIMEOUT_MS = 300_000
/** 橋自有 timeout_ms 判定先行；客戶端僅在其後 + 寬限值才中止，讓橋的結構化 500（帶 stdout_tail）優先到達。 */
const CLIENT_ABORT_GRACE_MS = 10_000
const MAX_FRAME_SPAN = 2000
/** 存活配方：橋內每請求渲染幀數上限（實錘：動畫 >10 幀必死，samples=1 全過）。 */
const RENDER_CHUNK_FRAMES = 10
/** turntable PNG 序列合成系統 ffmpeg 路徑（可 env 覆蓋）。 */
const FFMPEG_BIN = process.env.BLENDER_FFMPEG_BIN || "ffmpeg"

export const BLENDER_BRIDGE_URL_DEFAULT = "http://127.0.0.1:8765"

export function bridgeUrl(): string {
  return process.env.BLENDER_BRIDGE_URL || BLENDER_BRIDGE_URL_DEFAULT
}

/**
 * 產物取回入口（片 AJ）：橋主機與 agent 沙箱異構、沙箱不自持檔案，產物一律經
 * 橋 GET /v1/artifact 取回。取回 base = 橋地址（env BLENDER_BRIDGE_URL 已含
 * 隧道語義：VPS 側 127.0.0.1:8765 經 blender-bridge-tunnel 反向隧道達橋主機）。
 * 完整 URL = `${artifactBaseUrl()}?path=${encodeURIComponent(artifact.path)}`。
 */
export function artifactBaseUrl(): string {
  return `${bridgeUrl()}/v1/artifact`
}

export interface BlenderArtifact {
  path: string
  bytes: number
  kind: string
}

export interface BlenderExecuteSuccess {
  ok: true
  artifacts: BlenderArtifact[]
  scene_summary: string
  stdout_tail: string
  duration_ms: number
}

export type BlenderToolResult = { title: string; output: string }

export interface BlenderToolContext {
  abort?: AbortSignal
  /**
   * 呼叫者 userId（資產包 per-user 持久化；片 AG2 指紋接線）。
   * 提供時 blender_exec 成功路徑自動 saveSceneAssets 入庫 + 執行前腳本指紋預查；
   * 缺省維持舊契約（不入庫、不預查）。
   */
  userId?: number
}

export interface BlenderToolArgSpec {
  type: "string" | "number" | "boolean"
  required: boolean
  description: string
  enum?: readonly string[]
}

export interface BlenderToolDef {
  id: string
  description: string
  args: Record<string, BlenderToolArgSpec>
  execute: (args: Record<string, unknown>, context?: BlenderToolContext) => Promise<BlenderToolResult>
}

// ── plumbing（ok/fail 同構 director-common.ts；錯誤分類為橋契約專用） ────────

function ok(data: Record<string, unknown>): BlenderToolResult {
  const { title, ...rest } = data
  return { title: (title as string) ?? "完成", output: JSON.stringify({ ok: true, ...rest }) }
}

function fail(code: string, hint: string, extra?: Record<string, unknown>): BlenderToolResult {
  const { title, ...rest } = extra ?? {}
  return { title: (title as string) ?? "失败", output: JSON.stringify({ ok: false, error: { code, hint }, ...rest }) }
}

export class BridgeError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "BridgeError"
  }
}

function bridgeError(code: string, message: string): BridgeError {
  return new BridgeError(code, message)
}

/** 分類 fetch 底層錯誤 → 人話（含「桥未启动」指引）。絕不讓原始錯誤逃逸。 */
function classifyFetchError(e: unknown): BridgeError {
  const err = e as Error & { cause?: { code?: string; message?: string } }
  const causeCode = err?.cause?.code ?? ""
  const transient =
    causeCode === "ECONNREFUSED" || causeCode === "ENOTFOUND" || causeCode === "ECONNRESET" || causeCode === "EHOSTUNREACH"
  if (transient || err?.name === "TypeError") {
    return bridgeError(
      "bridge_unavailable",
      `桥未启动，请先启动 blender-bridge（默认 ${bridgeUrl()}，可用 GET ${bridgeUrl()}/v1/health 验证应返回 200）。` +
        `启动步骤与排障见 docs/blender-bridge-notes.md。底层原因：${err?.message ?? String(e)}${causeCode ? ` (${causeCode})` : ""}`,
    )
  }
  return bridgeError(
    "bridge_request_failed",
    `调用 blender-bridge 失败：${err?.message ?? String(e)}。请确认 BLENDER_BRIDGE_URL=${bridgeUrl()} 可达。`,
  )
}

async function bridgeExecute(
  script: string,
  timeoutMs: number,
  context?: BlenderToolContext,
): Promise<BlenderExecuteSuccess> {
  const controller = new AbortController()
  const abortMs = timeoutMs + CLIENT_ABORT_GRACE_MS
  const timer = setTimeout(() => controller.abort(), abortMs)
  const signals: AbortSignal[] = [controller.signal]
  if (context?.abort) signals.push(context.abort)
  const signal = typeof AbortSignal.any === "function" ? AbortSignal.any(signals) : controller.signal
  let response: Response
  try {
    response = await fetch(`${bridgeUrl()}/v1/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script, timeout_ms: timeoutMs }),
      signal,
    })
  } catch (e) {
    clearTimeout(timer)
    if (controller.signal.aborted && !context?.abort?.aborted) {
      throw bridgeError(
        "bridge_timeout",
        `等待 blender-bridge 响应超时（上限 ${abortMs} ms，脚本 timeout_ms=${timeoutMs}）。` +
          `可为 blender_exec 传更大的 timeout_ms，或缩短脚本工作量；桥进程健康可用 GET ${bridgeUrl()}/v1/health 验证。`,
      )
    }
    if (context?.abort?.aborted) {
      throw bridgeError("aborted", "调用方已中止本次 blender 工具调用。")
    }
    throw classifyFetchError(e)
  }
  clearTimeout(timer)
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    if (body && body.ok === false) {
      const errorText = typeof body.error === "string" && body.error ? body.error : "未知错误"
      const tail = typeof body.stdout_tail === "string" && body.stdout_tail ? `\nstdout_tail：\n${body.stdout_tail}` : ""
      throw bridgeError("blender_script_error", `bpy 脚本执行失败（HTTP ${response.status}）：${errorText}${tail}`)
    }
    throw bridgeError(
      "bridge_http_error",
      `blender-bridge 返回异常状态 HTTP ${response.status}，请确认桥进程健康（GET ${bridgeUrl()}/v1/health）后再试。`,
    )
  }
  if (!body || body.ok !== true) {
    throw bridgeError(
      "bridge_bad_response",
      `blender-bridge 响应形状异常（HTTP 200 但缺少 ok:true 成功体），HTTP 契约见 docs/blender-bridge-notes.md。`,
    )
  }
  return body as unknown as BlenderExecuteSuccess
}

function toFail(e: unknown): BlenderToolResult {
  if (e instanceof BridgeError) return fail(e.code, e.message)
  return fail("blender_tool_error", `blender 工具执行异常：${(e as Error)?.message ?? String(e)}`)
}

/** GET /v1/health：拿橋 workdir（分塊 PNG / ffmpeg 產物的絕對路徑根）。 */
async function bridgeHealth(
  context?: BlenderToolContext,
): Promise<{ blenderVersion: string; workdir: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  let response: Response
  try {
    response = await fetch(`${bridgeUrl()}/v1/health`, { signal: controller.signal })
  } catch (e) {
    clearTimeout(timer)
    if (controller.signal.aborted && !context?.abort?.aborted) {
      throw bridgeError(
        "bridge_timeout",
        `等待 blender-bridge /v1/health 响应超时（10s）。桥进程健康可用 GET ${bridgeUrl()}/v1/health 验证。`,
      )
    }
    if (context?.abort?.aborted) {
      throw bridgeError("aborted", "调用方已中止本次 blender 工具调用。")
    }
    throw classifyFetchError(e)
  }
  clearTimeout(timer)
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok || !body || body.ok !== true || typeof body.workdir !== "string" || body.workdir === "") {
    throw bridgeError(
      "bridge_bad_response",
      `blender-bridge /v1/health 响应异常（HTTP ${response.status}${body && !body.workdir ? "，缺少 workdir" : ""}），` +
        `请确认桥进程健康（GET ${bridgeUrl()}/v1/health）后再试。`,
    )
  }
  return { blenderVersion: String(body.blender_version ?? ""), workdir: body.workdir }
}

/**
 * 系统命令执行（spawn 直呼，不走 shell，无注入面）。产出只取 stderr 尾部用于报错。
 * 注意：spawn 的 ENOENT（命令不存在）经 'error' 事件到达，不抛同步异常。
 */
function runCommand(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: true; stderr: string } | { ok: false; error: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ ok: false, error: `命令超时（${timeoutMs} ms）被终止`, stderr })
    }, timeoutMs)
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve({ ok: false, error: e.code === "ENOENT" ? `${bin} 不存在（系统未安装）` : e.message, stderr })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ ok: true, stderr })
      else resolve({ ok: false, error: `${bin} 退出码 ${code ?? "null"}`, stderr })
    })
  })
}

/** ffmpeg 可用性探测（turntable 合成必需；缺失时结构化报错并给安装指引）。 */
async function ensureFfmpegAvailable(): Promise<void> {
  const probe = await runCommand(FFMPEG_BIN, ["-version"], 15_000)
  if (!probe.ok) {
    throw bridgeError(
      "ffmpeg_unavailable",
      `系统 ffmpeg 不可用（${probe.error}）：turntable 分块 PNG 序列合成 mp4 需要系统 ffmpeg。` +
        `请安装 ffmpeg（Arch: sudo pacman -S ffmpeg）或用环境变量 BLENDER_FFMPEG_BIN 指定可执行文件路径。`,
    )
  }
}

// ── 參數整理助手（同構 director-common.ts num/bool 口徑） ────────────────────

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined
}

function asInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback
}

/** frames 參數："1-120" 區間 / "42" 單幀；缺省 null（渲染當前幀）。 */
function parseFrames(raw: unknown): { start: number; end: number } | null | "invalid" {
  if (raw === undefined || raw === null || raw === "") return null
  const s = String(raw).trim()
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(s)
  if (range) {
    const start = Number(range[1])
    const end = Number(range[2])
    if (end < start) return "invalid"
    if (end - start + 1 > MAX_FRAME_SPAN) return "invalid"
    return { start, end }
  }
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return { start: n, end: n }
  }
  return "invalid"
}

/** output_name 白名單化：剝擴展名、禁路徑分隔符，防產物逃出橋工作目錄。 */
function sanitizeOutputName(raw: unknown, fallback: string): string {
  const s = asString(raw)
  if (!s) return fallback
  const cleaned = s
    .replace(/\.(mp4|png|glb|gltf|blend)$/i, "")
    .replace(/[/\\]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80)
    .replace(/^_+|_+$/g, "")
  return cleaned || fallback
}

/** Python 字符串字面量轉義（嵌入 bpy 腳本的參數都過這裡）。 */
function pyStr(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"'
}

function pyInt(n: number | null): string {
  return n === null ? "None" : String(Math.round(n))
}

function pyBool(b: boolean): string {
  return b ? "True" : "False"
}

// ── bpy 腳本模板（render / export 走同一 POST /v1/execute 通道） ─────────────

/**
 * 單塊渲染腳本（每塊 ≤RENDER_CHUNK_FRAMES 幀）。
 *
 * 存活配方（smoke P0-5 實錘，2026-09-06-blender-bridge-render-crash-survival-recipe）：
 *   - 橋內 Eevee 渲染負載越大越易 native 無聲崩（動畫>10 幀必死、samples=16 全崩）；
 *     samples=1 + RT off 全過 → 每請求只渲 ≤10 幀 PNG + previz 存活預設（cycles 檔不受此限）。
 *   - 橋契約一次 execute 一個腳本 → 分塊由工具層循環多次 execute；mp4 合成在工具層
 *     系統 ffmpeg 完成（橋內 in-process mp4 muxer 必崩出 48 字節 stub）。
 *   - 進程死=場景丟 → 每塊都重新 open_mainfile；turntable 的 pivot/關鍵幀按 FULL 區間
 *     每塊重建（從場景網格重算，確定性一致，塊間旋轉連續）。
 *   - CWD：橋以 $BLENDER_WORK 為 Blender 工作目錄 spawn，產物統一寫 out/<名>/frame_%04d.png
 *     （橋按 mtime 增量掃 out/ 回 artifacts）。
 */
export function buildChunkRenderScript(p: {
  sceneBlendPath?: string
  engine: string
  turntable: boolean
  /** 本塊渲染幀起（null=渲染當前幀單張 still）。 */
  chunkStart: number | null
  chunkEnd: number
  /** turntable 關鍵幀全跨度（旋轉 0→2π 映射 FULL_START→FULL_END，塊間一致）。 */
  fullStart: number
  fullEnd: number
  outputDirName: string
}): string {
  return `import bpy, math, mathutils, os, json

SCENE_PATH = ${p.sceneBlendPath ? pyStr(p.sceneBlendPath) : "None"}
ENGINE_NAME = ${pyStr(p.engine)}
TURNTABLE = ${pyBool(p.turntable)}
CHUNK_START = ${pyInt(p.chunkStart)}
CHUNK_END = ${pyInt(p.chunkEnd)}
FULL_START = ${pyInt(p.fullStart)}
FULL_END = ${pyInt(p.fullEnd)}
OUTPUT_DIR_NAME = ${pyStr(p.outputDirName)}

def set_engine(scene, name):
    # "BLENDER_EEVEE_NEXT" 僅存在於 Blender 4.2-4.x；5.2 起（4.2 已合并）唯一
    # enum 是 "BLENDER_EEVEE"，舊名在 5.2 拋 TypeError 落回新名（兩名都敗才拋錯）。
    candidates = ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"] if name == "eevee" else ["CYCLES"]
    for cand in candidates:
        try:
            scene.render.engine = cand
            return cand
        except TypeError:
            continue
    raise RuntimeError("无法设置渲染引擎: " + name)

def action_fcurves(act):
    # Blender 4.4+ slotted action：action.fcurves 已移除，走
    # layers[*].strips[*].channelbags[*].fcurves（同構
    # skills/blender-director/verify/verify_keyframe.py 已驗證寫法）。
    for layer in act.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                yield from bag.fcurves

def apply_previz_survival_preset(scene):
    # 存活預設：samples=1 + RT off（Eevee 負載越大橋內越易 native 崩，實錘矩陣見註釋頭）。
    try:
        scene.eevee.taa_render_samples = 1
    except (TypeError, AttributeError):
        pass
    try:
        scene.eevee.use_raytracing = False
    except (AttributeError, TypeError):
        pass

if SCENE_PATH:
    bpy.ops.wm.open_mainfile(filepath=SCENE_PATH)
scene = bpy.context.scene
used_engine = set_engine(scene, ENGINE_NAME)
print("ENGINE_USED:" + used_engine)
if used_engine.startswith("BLENDER_EEVEE"):
    apply_previz_survival_preset(scene)
scene.render.image_settings.file_format = "PNG"

if TURNTABLE:
    meshes = [o for o in scene.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("场景中没有网格物体，无法生成 turntable")
    origins = [mathutils.Vector(o.location) for o in meshes]
    pivot = sum(origins, mathutils.Vector()) / len(origins)
    pivot_empty = bpy.data.objects.new("turntable_pivot", None)
    scene.collection.objects.link(pivot_empty)
    pivot_empty.location = pivot
    for o in meshes:
        o.parent = pivot_empty
        o.matrix_parent_inverse = pivot_empty.matrix_world.inverted()
    scene.frame_start = FULL_START
    scene.frame_end = FULL_END
    pivot_empty.keyframe_insert(data_path="rotation_euler", frame=FULL_START)
    pivot_empty.rotation_euler.z = 2 * math.pi
    pivot_empty.keyframe_insert(data_path="rotation_euler", frame=FULL_END)
    for fc in action_fcurves(pivot_empty.animation_data.action):
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"

out_dir = os.path.join(os.getcwd(), "out", OUTPUT_DIR_NAME)
os.makedirs(out_dir, exist_ok=True)
# fps 走 sidecar 落盤（stdout_tail 會被 blender.log 佔滿擠掉 print，artifact 才硬）。
meta_path = os.path.join(out_dir, "meta.json")
if not os.path.exists(meta_path):
    with open(meta_path, "w") as fh:
        json.dump({"fps": round(scene.render.fps), "engine": used_engine}, fh)
if CHUNK_START is None:
    scene.frame_set(scene.frame_current)
    scene.render.filepath = os.path.join(out_dir, "frame_%04d.png" % scene.frame_current)
    bpy.ops.render.render(write_still=True)
    print("CHUNK_DONE: still")
else:
    for f in range(CHUNK_START, CHUNK_END + 1):
        scene.frame_set(f)
        scene.render.filepath = os.path.join(out_dir, "frame_%04d.png" % f)
        bpy.ops.render.render(write_still=True)
    print("CHUNK_DONE: %d-%d" % (CHUNK_START, CHUNK_END))
`
}

function buildExportScript(p: { sceneBlendPath?: string; format: string; outputPath: string }): string {
  return `import bpy

SCENE_PATH = ${p.sceneBlendPath ? pyStr(p.sceneBlendPath) : "None"}
OUTPUT_PATH = ${pyStr(p.outputPath)}
EXPORT_FORMAT = ${pyStr(p.format)}

if SCENE_PATH:
    bpy.ops.wm.open_mainfile(filepath=SCENE_PATH)
try:
    bpy.ops.export_scene.gltf(filepath=OUTPUT_PATH, export_format=EXPORT_FORMAT, use_selection=False)
except AttributeError:
    bpy.ops.preferences.addon_enable(module="io_scene_gltf2")
    bpy.ops.export_scene.gltf(filepath=OUTPUT_PATH, export_format=EXPORT_FORMAT, use_selection=False)
print("GLTF_EXPORTED:" + OUTPUT_PATH)
`
}

// ── 三個工具 ────────────────────────────────────────────────────────────────

export const blenderExecTool: BlenderToolDef = {
  id: "blender_exec",
  description:
    "在 Blender 沙箱执行 bpy 脚本：建模、搭建场景、修改场景、骨架动画 keyframe。产物文件自动落到桥的工作目录。",
  args: {
    script: {
      type: "string",
      required: true,
      description: "完整 bpy 脚本文本（import bpy 开头）；产物写相对路径即落到桥工作目录。",
    },
    timeout_ms: {
      type: "number",
      required: false,
      description: "脚本执行超时毫秒，默认 120000，上限 3600000。",
    },
  },
  async execute(rawArgs, context) {
    try {
      const script = asString(rawArgs.script)
      if (!script) {
        return fail("invalid_args", "缺少必填参数 script：需要完整 bpy 脚本文本（import bpy 开头）。")
      }
      const timeoutMs = asInt(rawArgs.timeout_ms, EXEC_DEFAULT_TIMEOUT_MS, 1_000, 3_600_000)

      // 執行前腳本指紋預查（片 AG2）：命中既有 bpy_script 資產只在 result 加提示欄，
      // 不阻斷、不跳過執行；無 userId / 資產庫異常時靜默跳過（best-effort）。
      let templateHit: { pack_id: string; title: string; fingerprint: string; scene_summary?: string } | undefined
      if (context?.userId) {
        try {
          const hit = await findTemplateByFingerprint(context.userId, fingerprintScript(script))
          if (hit.ok) {
            templateHit = {
              pack_id: hit.template.packId,
              title: hit.template.itemTitle,
              fingerprint: hit.template.fingerprint,
              ...(hit.template.sceneSummary ? { scene_summary: hit.template.sceneSummary } : {}),
            }
          }
        } catch {
          // 資產庫讀取失敗不影響 blender 執行主鏈
        }
      }

      const data = await bridgeExecute(script, timeoutMs, context)

      // 成功路徑自動入庫（片 AG2）：blend/glb 產物 + 腳本全文（指紋去重）進用戶
      // blender-3d-assets 包；best-effort，入庫失敗不回滾執行結果。
      let assetsSaved: { added: number; deduped: number } | undefined
      if (context?.userId) {
        try {
          const saved = await saveSceneAssets(context.userId, data.artifacts, {
            script,
            scene_summary: data.scene_summary,
          })
          if (saved.ok) {
            assetsSaved = { added: saved.items.length, deduped: saved.deduped }
          }
        } catch {
          // 資產庫寫入失敗不影響執行結果（產物仍在橋工作目錄）
        }
      }

      return ok({
        title: "执行完成",
        artifacts: data.artifacts,
        artifact_count: data.artifacts.length,
        artifact_base_url: artifactBaseUrl(),
        scene_summary: data.scene_summary,
        stdout_tail: data.stdout_tail,
        duration_ms: data.duration_ms,
        ...(templateHit
          ? {
              template_hit: templateHit,
              template_hint: `该脚本（规范化后）已存于资产包 ${templateHit.pack_id}「${templateHit.title}」，可用 asset_get 取出复用，勿重复造轮子。`,
            }
          : {}),
        ...(assetsSaved ? { assets_saved: assetsSaved } : {}),
      })
    } catch (e) {
      return toFail(e)
    }
  },
}

export const blenderRenderTool: BlenderToolDef = {
  id: "blender_render",
  description:
    "对已搭建的 Blender 场景出渲染帧或 turntable mp4。render_engine=eevee 快稿预览、cycles 品质档（慢）。产物自动落到桥的工作目录。",
  args: {
    scene_blend_path: {
      type: "string",
      required: false,
      description: "要渲染的 .blend 场景文件路径；缺省使用桥工作目录中的当前场景。",
    },
    render_engine: {
      type: "string",
      required: false,
      enum: ["eevee", "cycles"],
      description: "渲染引擎：eevee=快稿，cycles=品质档。默认 eevee。",
    },
    frames: {
      type: "string",
      required: false,
      description: '帧范围，如 "1-120"（渲染帧序列 PNG）或单帧号 "42"；缺省只渲染当前帧单帧。',
    },
    turntable: {
      type: "boolean",
      required: false,
      description:
        "true 时对场景内网格物体绕 Z 轴 360° 旋转渲染并输出 turntable mp4（默认 1-96 帧，可配合 frames 指定）。分块渲染 PNG（每块 ≤10 帧）+ 系统 ffmpeg 合成 H264。",
    },
    output_name: {
      type: "string",
      required: false,
      description: "产物文件名（不含扩展名），默认 turntable / render。",
    },
  },
  async execute(rawArgs, context) {
    try {
      const engineRaw = asString(rawArgs.render_engine)
      if (engineRaw !== undefined && engineRaw !== "eevee" && engineRaw !== "cycles") {
        return fail("invalid_args", `render_engine 只接受 "eevee" 或 "cycles"，收到 "${engineRaw}"。`)
      }
      const frames = parseFrames(rawArgs.frames)
      if (frames === "invalid") {
        return fail(
          "invalid_args",
          `frames 格式应为 "起始帧-结束帧"（如 "1-120"）或单帧号，且跨度不超过 ${MAX_FRAME_SPAN} 帧。`,
        )
      }
      const turntable = asBool(rawArgs.turntable, false)
      const outputBase = sanitizeOutputName(rawArgs.output_name, turntable ? "turntable" : "render")
      const sceneBlendPath = asString(rawArgs.scene_blend_path)

      // 橋 spawn Blender 時 CWD=workdir，腳本產物寫 out/<dir>/，橋 artifacts 路徑相對 out/。
      const health = await bridgeHealth(context)
      const outDir = nodePath.join(health.workdir, "out")

      // 存活配方（smoke P0-5 實錘）：每請求 ≤10 幀 PNG 分塊；turntable 的旋轉關鍵幀
      // 按全跨度 keyframe（塊間從同一 blend 重建 pivot，旋轉連續）。cycles 檔不受 previz 預設限制。
      const span = turntable ? frames ?? { start: 1, end: 96 } : frames
      const outputDirName = `${outputBase}_frames`
      let artifacts: BlenderArtifact[] = []
      let sceneSummary = ""
      let stdoutTail = ""
      let durationMs = 0
      let chunkCount = 0
      let sceneFps = 0

      const renderChunk = async (chunkStart: number, chunkEnd: number) => {        const script = buildChunkRenderScript({
          sceneBlendPath,
          engine: engineRaw ?? "eevee",
          turntable,
          chunkStart: span ? chunkStart : null,
          chunkEnd,
          fullStart: span ? span.start : chunkStart,
          fullEnd: span ? span.end : chunkEnd,
          outputDirName,
        })
        const data = await bridgeExecute(script, RENDER_DEFAULT_TIMEOUT_MS, context)
        chunkCount += 1
        artifacts = artifacts.concat(data.artifacts)
        sceneSummary = data.scene_summary
        stdoutTail = data.stdout_tail
        durationMs += data.duration_ms
        if (sceneFps === 0) {
          // fps 從首塊 sidecar meta.json 讀（stdout_tail 被 blender.log 佔滿時 print 會被擠掉，artifact 才硬）。
          const meta = await fsp
            .readFile(nodePath.join(outDir, outputDirName, "meta.json"), "utf8")
            .then((t) => JSON.parse(t) as { fps?: number })
            .catch(() => null)
          if (meta && Number.isFinite(Number(meta.fps)) && Number(meta.fps) > 0) {
            sceneFps = Math.max(1, Math.round(Number(meta.fps)))
          }
        }
      }

      // 橋內 Eevee native 崩潰非確定性（smoke 實錘：每 ~12 幀可能死一次）→ 每塊重試
      // 至多 2 次（橋崩後自動重啟、塊腳本自含重開 blend，重試乾淨）；仍敗按鐵律結構化停止。
      const renderChunkWithRetry = async (chunkStart: number, chunkEnd: number) => {
        let lastErr: unknown
        for (let attempt = 0; attempt <= 2; attempt++) {
          try {
            await renderChunk(chunkStart, chunkEnd)
            return
          } catch (e) {
            lastErr = e
            const code = e instanceof BridgeError ? e.code : ""
            const retriable =
              code === "blender_script_error" ||
              code === "bridge_unavailable" ||
              code === "bridge_http_error" ||
              code === "bridge_bad_response"
            if (!retriable || attempt === 2) throw e
            await new Promise((r) => setTimeout(r, 2_000))
          }
        }
        throw lastErr
      }

      if (span) {
        for (let c = span.start; c <= span.end; c += RENDER_CHUNK_FRAMES) {
          await renderChunkWithRetry(c, Math.min(c + RENDER_CHUNK_FRAMES - 1, span.end))
        }
      } else {
        await renderChunkWithRetry(0, 0)
      }

      let mp4Artifact: BlenderArtifact | null = null
      if (turntable && span) {
        // 橋內 in-process mp4 muxer 必崩（2/2 出 48 字節 stub）→ 工具層系統 ffmpeg 合成 H264。
        await ensureFfmpegAvailable()
        const fps = sceneFps || 24
        const mp4Abs = nodePath.join(outDir, `${outputBase}.mp4`)
        const mux = await runCommand(
          FFMPEG_BIN,
          [
            "-y",
            "-framerate",
            String(fps),
            "-start_number",
            String(span.start),
            "-i",
            nodePath.join(outDir, outputDirName, "frame_%04d.png"),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            mp4Abs,
          ],
          600_000,
        )
        const basePayload = {
          engine: engineRaw ?? "eevee",
          frames,
          turntable,
          output_base: outputBase,
        }
        if (!mux.ok) {
          return fail(
            "ffmpeg_failed",
            `turntable PNG 序列合成 mp4 失败：${mux.error}${mux.stderr ? `\nffmpeg stderr 尾部：\n${mux.stderr.slice(-1500)}` : ""}`,
            {
              title: "Turntable 渲染完成",
              // PNG 序列仍在（out/<名>_frames/），供排查或手工合成。
              artifacts,
              artifact_count: artifacts.length,
              artifact_base_url: artifactBaseUrl(),
              scene_summary: sceneSummary,
              stdout_tail: stdoutTail,
              duration_ms: durationMs,
              ...basePayload,
            },
          )
        }
        const stat = await fsp.stat(mp4Abs).catch(() => null)
        if (!stat || stat.size < 1024) {
          return fail(
            "ffmpeg_failed",
            `合成 mp4 产物异常（${stat ? `${stat.size} 字节，疑似 stub` : "文件缺失"}，正常应 >1KB）。` +
              `ffmpeg 命令：${FFMPEG_BIN} -framerate ${fps} ... ${mp4Abs}`,
            { title: "Turntable 渲染完成", artifacts, artifact_count: artifacts.length, artifact_base_url: artifactBaseUrl(), scene_summary: sceneSummary, stdout_tail: stdoutTail, duration_ms: durationMs, ...basePayload },
          )
        }
        // 成功：清理中间 PNG 目录，artifacts 收敛为 mp4（与旧 turntable 返回形状一致）。
        await fsp.rm(nodePath.join(outDir, outputDirName), { recursive: true, force: true }).catch(() => {})
        mp4Artifact = { path: `${outputBase}.mp4`, bytes: stat.size, kind: "mp4" }
        artifacts = [mp4Artifact]
      }

      return ok({
        title: turntable ? "Turntable 渲染完成" : "渲染完成",
        artifacts,
        artifact_count: artifacts.length,
        artifact_base_url: artifactBaseUrl(),
        scene_summary: sceneSummary,
        stdout_tail: stdoutTail,
        duration_ms: durationMs,
        engine: engineRaw ?? "eevee",
        frames: frames ?? null,
        turntable,
        output_base: outputBase,
        ...(mp4Artifact ? { mp4: mp4Artifact.path, fps: sceneFps || 24, chunk_count: chunkCount } : { chunk_count: chunkCount }),
      })
    } catch (e) {
      return toFail(e)
    }
  },
}

export const blenderExportGltfTool: BlenderToolDef = {
  id: "blender_export_gltf",
  description: "把 Blender 场景导出 glb/glTF 供前端 viewport 预览。glb=单文件二进制（推荐），gltf=JSON+分离资源。产物自动落到桥的工作目录。",
  args: {
    scene_blend_path: {
      type: "string",
      required: false,
      description: "要导出的 .blend 场景文件路径；缺省使用桥工作目录中的当前场景。",
    },
    output_name: {
      type: "string",
      required: false,
      description: "导出文件名（不含扩展名），默认 scene。",
    },
    format: {
      type: "string",
      required: false,
      enum: ["glb", "gltf"],
      description: "导出格式：glb=单文件二进制，gltf=JSON+分离资源。默认 glb。",
    },
  },
  async execute(rawArgs, context) {
    try {
      const formatRaw = asString(rawArgs.format)
      if (formatRaw !== undefined && formatRaw !== "glb" && formatRaw !== "gltf") {
        return fail("invalid_args", `format 只接受 "glb" 或 "gltf"，收到 "${formatRaw}"。`)
      }
      const format = formatRaw ?? "glb"
      const outputName = sanitizeOutputName(rawArgs.output_name, "scene")
      const script = buildExportScript({
        sceneBlendPath: asString(rawArgs.scene_blend_path),
        format: format === "glb" ? "GLB" : "GLTF_SEPARATE",
        outputPath: `${outputName}.${format}`,
      })
      const data = await bridgeExecute(script, EXPORT_DEFAULT_TIMEOUT_MS, context)
      return ok({
        title: "GLTF 导出完成",
        artifacts: data.artifacts,
        artifact_count: data.artifacts.length,
        scene_summary: data.scene_summary,
        stdout_tail: data.stdout_tail,
        duration_ms: data.duration_ms,
        format,
        output_path: `${outputName}.${format}`,
      })
    } catch (e) {
      return toFail(e)
    }
  },
}

/** 三工具定義集（id 順序 = HARNESS_TOOL_ID_LIST 登記順序）。 */
export const BLENDER_TOOLS: readonly BlenderToolDef[] = [
  blenderExecTool,
  blenderRenderTool,
  blenderExportGltfTool,
]

/** harness-tool-registry.ts 登記用 id 元組（字母序，與 HARNESS_TOOL_ID_LIST 登記順序一致）。 */
export const BLENDER_HARNESS_TOOL_IDS = ["blender_exec", "blender_export_gltf", "blender_render"] as const
