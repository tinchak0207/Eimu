/**
 * blender_* 三工具 opencode 形狀 staging 稿（Astra 3D 導演工作站 P1-2，片G，2026-09-06）。
 *
 * 行為真源 = src/lib/blender-tools.ts（L27-509）：本檔是其 opencode tool() 形狀的逐條翻譯——
 * 常量、參數整理助手、錯誤分類、bpy 腳本合成器、ok()/fail() 與全部簡體文案逐行搬運，
 * 行為零偏離；只把「描述符 args + 自帶 plumbing」換成「tool.schema + @opencode-ai/plugin tool()」。
 * 形狀輪子 = src/vendor-bridges/opencode-tools/director_*.ts + lib/director-common.ts
 * （tool({ description, args, execute })、返回 { title, output: JSON 字串 } 契約）。
 *
 * VPS 落位（本檔不上傳到 tools/，完整命令見同目錄 PATCH-PLAN.md）：
 *   本檔整份            → /opt/agent-harness/workspace/.opencode/lib/blender-tools-impl.ts
 *   三個 3 行 adapter   → .opencode/tools/blender_exec.ts / blender_render.ts / blender_export_gltf.ts
 *   （adapter 只做 `import { blenderXxxTool } from "../lib/blender-tools-impl"` + `export default`）
 *
 * 傳輸契約（與片 A 橋逐字共享，雙方不得單方面改動）：
 *   GET  /v1/health → 200 {ok:true, blender_version, gpu:"egl"|"cpu", workdir}
 *   POST /v1/execute body {script:string, timeout_ms?:number} →
 *     200 {ok:true, artifacts:[{path,bytes,kind}], scene_summary:string, stdout_tail:string, duration_ms:number}
 *     500 {ok:false, error:string, stdout_tail:string}
 * 橋位址 = env BLENDER_BRIDGE_URL（默認 http://127.0.0.1:8765）。
 *
 * 錯誤鐵律：橋未就緒/超時/非 200 一律返回結構化 fail()（含「桥未启动，请先启动
 * blender-bridge」指引），絕不 throw 原始 fetch 錯誤。工具文案一律簡體（記憶 agent-gateway-copy-rules）。
 */
import { tool } from "@opencode-ai/plugin/tool"

// ═══ 公共面（= blender-tools.ts L27-116 + L180-236 逐行搬運） ═══════════════

const EXEC_DEFAULT_TIMEOUT_MS = 120_000
const RENDER_DEFAULT_TIMEOUT_MS = 1_800_000
const EXPORT_DEFAULT_TIMEOUT_MS = 300_000
/** 橋自有 timeout_ms 判定先行；客戶端僅在其後 + 寬限值才中止，讓橋的結構化 500（帶 stdout_tail）優先到達。 */
const CLIENT_ABORT_GRACE_MS = 10_000
const MAX_FRAME_SPAN = 2000

const BLENDER_BRIDGE_URL_DEFAULT = "http://127.0.0.1:8765"

function bridgeUrl(): string {
  return process.env.BLENDER_BRIDGE_URL || BLENDER_BRIDGE_URL_DEFAULT
}

interface BlenderArtifact {
  path: string
  bytes: number
  kind: string
}

interface BlenderExecuteSuccess {
  ok: true
  artifacts: BlenderArtifact[]
  scene_summary: string
  stdout_tail: string
  duration_ms: number
}

interface BlenderToolContext {
  abort?: AbortSignal
}

// ok/fail 同構 director-common.ts（工具返回契約 {title, output}）
function ok(data: Record<string, unknown>): { title: string; output: string } {
  const { title, ...rest } = data
  return { title: (title as string) ?? "完成", output: JSON.stringify({ ok: true, ...rest }) }
}

function fail(code: string, hint: string, extra?: Record<string, unknown>): { title: string; output: string } {
  const { title, ...rest } = extra ?? {}
  return { title: (title as string) ?? "失败", output: JSON.stringify({ ok: false, error: { code, hint }, ...rest }) }
}

class BridgeError extends Error {
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

function toFail(e: unknown): { title: string; output: string } {
  if (e instanceof BridgeError) return fail(e.code, e.message)
  return fail("blender_tool_error", `blender 工具执行异常：${(e as Error)?.message ?? String(e)}`)
}

// ── 參數整理助手（同構 director-common.ts num/bool 口徑；= blender-tools.ts L180-236） ──

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

// ── bpy 腳本合成器（render / export 走同一 POST /v1/execute 通道；= blender-tools.ts L240-334 逐字） ──

function buildRenderScript(p: {
  sceneBlendPath?: string
  engine: string
  frames: { start: number; end: number } | null
  turntable: boolean
  outputBase: string
}): string {
  return `import bpy, math, mathutils

SCENE_PATH = ${p.sceneBlendPath ? pyStr(p.sceneBlendPath) : "None"}
ENGINE_NAME = ${pyStr(p.engine)}
FRAME_START = ${pyInt(p.frames ? p.frames.start : null)}
FRAME_END = ${pyInt(p.frames ? p.frames.end : null)}
TURNTABLE = ${pyBool(p.turntable)}
OUTPUT_BASE = ${pyStr(p.outputBase)}

def set_engine(scene, name):
    candidates = ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"] if name == "eevee" else ["CYCLES"]
    for cand in candidates:
        try:
            scene.render.engine = cand
            return cand
        except TypeError:
            continue
    raise RuntimeError("无法设置渲染引擎: " + name)

if SCENE_PATH:
    bpy.ops.wm.open_mainfile(filepath=SCENE_PATH)
scene = bpy.context.scene
used_engine = set_engine(scene, ENGINE_NAME)

if TURNTABLE:
    if FRAME_START is None:
        FRAME_START = 1
        FRAME_END = 96
    scene.frame_start = FRAME_START
    scene.frame_end = FRAME_END
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
    pivot_empty.keyframe_insert(data_path="rotation_euler", frame=scene.frame_start)
    pivot_empty.rotation_euler.z = 2 * math.pi
    pivot_empty.keyframe_insert(data_path="rotation_euler", frame=scene.frame_end)
    for fc in pivot_empty.animation_data.action.fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"
    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "MEDIUM"
    scene.render.filepath = OUTPUT_BASE
    bpy.ops.render.render(animation=True)
    print("RENDER_DONE: turntable " + OUTPUT_BASE)
elif FRAME_START is not None:
    scene.render.image_settings.file_format = "PNG"
    for f in range(FRAME_START, FRAME_END + 1):
        scene.frame_set(f)
        scene.render.filepath = OUTPUT_BASE + "_f%04d" % f
        bpy.ops.render.render(write_still=True)
    print("RENDER_DONE: frames %d-%d" % (FRAME_START, FRAME_END))
else:
    scene.render.image_settings.file_format = "PNG"
    scene.frame_set(scene.frame_current)
    scene.render.filepath = OUTPUT_BASE + "_f%04d" % scene.frame_current
    bpy.ops.render.render(write_still=True)
    print("RENDER_DONE: still")
print("ENGINE_USED:" + used_engine)
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

// ═══ 工具一：blender_exec（= blender-tools.ts blenderExecTool L338-374） ═════

export const blenderExecTool = tool({
  description:
    "在 Blender 沙箱执行 bpy 脚本：建模、搭建场景、修改场景、骨架动画 keyframe。产物文件自动落到桥的工作目录。",
  args: {
    script: tool.schema.string().describe("完整 bpy 脚本文本（import bpy 开头）；产物写相对路径即落到桥工作目录。"),
    timeout_ms: tool.schema.number().optional().describe("脚本执行超时毫秒，默认 120000，上限 3600000。"),
  },
  async execute(args: Record<string, unknown>, context: BlenderToolContext) {
    try {
      const script = asString(args.script)
      if (!script) {
        return fail("invalid_args", "缺少必填参数 script：需要完整 bpy 脚本文本（import bpy 开头）。")
      }
      const timeoutMs = asInt(args.timeout_ms, EXEC_DEFAULT_TIMEOUT_MS, 1_000, 3_600_000)
      const data = await bridgeExecute(script, timeoutMs, context)
      return ok({
        title: "执行完成",
        artifacts: data.artifacts,
        artifact_count: data.artifacts.length,
        scene_summary: data.scene_summary,
        stdout_tail: data.stdout_tail,
        duration_ms: data.duration_ms,
      })
    } catch (e) {
      return toFail(e)
    }
  },
})

// ═══ 工具二：blender_render（= blender-tools.ts blenderRenderTool L376-447） ═══

export const blenderRenderTool = tool({
  description:
    "对已搭建的 Blender 场景出渲染帧或 turntable mp4。render_engine=eevee 快稿预览、cycles 品质档（慢）。产物自动落到桥的工作目录。",
  args: {
    scene_blend_path: tool.schema
      .string()
      .optional()
      .describe("要渲染的 .blend 场景文件路径；缺省使用桥工作目录中的当前场景。"),
    render_engine: tool.schema
      .enum(["eevee", "cycles"])
      .optional()
      .describe("渲染引擎：eevee=快稿，cycles=品质档。默认 eevee。"),
    frames: tool.schema
      .string()
      .optional()
      .describe('帧范围，如 "1-120"（渲染帧序列 PNG）或单帧号 "42"；缺省只渲染当前帧单帧。'),
    turntable: tool.schema
      .boolean()
      .optional()
      .describe("true 时对场景内网格物体绕 Z 轴 360° 旋转渲染并输出 turntable mp4（默认 1-96 帧，可配合 frames 指定）。"),
    output_name: tool.schema.string().optional().describe("产物文件名（不含扩展名），默认 turntable / render。"),
  },
  async execute(args: Record<string, unknown>, context: BlenderToolContext) {
    try {
      const engineRaw = asString(args.render_engine)
      if (engineRaw !== undefined && engineRaw !== "eevee" && engineRaw !== "cycles") {
        return fail("invalid_args", `render_engine 只接受 "eevee" 或 "cycles"，收到 "${engineRaw}"。`)
      }
      const frames = parseFrames(args.frames)
      if (frames === "invalid") {
        return fail(
          "invalid_args",
          `frames 格式应为 "起始帧-结束帧"（如 "1-120"）或单帧号，且跨度不超过 ${MAX_FRAME_SPAN} 帧。`,
        )
      }
      const turntable = asBool(args.turntable, false)
      const outputBase = sanitizeOutputName(args.output_name, turntable ? "turntable" : "render")
      const script = buildRenderScript({
        sceneBlendPath: asString(args.scene_blend_path),
        engine: engineRaw ?? "eevee",
        frames,
        turntable,
        outputBase,
      })
      const data = await bridgeExecute(script, RENDER_DEFAULT_TIMEOUT_MS, context)
      return ok({
        title: turntable ? "Turntable 渲染完成" : "渲染完成",
        artifacts: data.artifacts,
        artifact_count: data.artifacts.length,
        scene_summary: data.scene_summary,
        stdout_tail: data.stdout_tail,
        duration_ms: data.duration_ms,
        engine: engineRaw ?? "eevee",
        frames: frames ?? null,
        turntable,
        output_base: outputBase,
      })
    } catch (e) {
      return toFail(e)
    }
  },
})

// ═══ 工具三：blender_export_gltf（= blender-tools.ts blenderExportGltfTool L449-498） ═══

export const blenderExportGltfTool = tool({
  description:
    "把 Blender 场景导出 glb/glTF 供前端 viewport 预览。glb=单文件二进制（推荐），gltf=JSON+分离资源。产物自动落到桥的工作目录。",
  args: {
    scene_blend_path: tool.schema
      .string()
      .optional()
      .describe("要导出的 .blend 场景文件路径；缺省使用桥工作目录中的当前场景。"),
    output_name: tool.schema.string().optional().describe("导出文件名（不含扩展名），默认 scene。"),
    format: tool.schema
      .enum(["glb", "gltf"])
      .optional()
      .describe("导出格式：glb=单文件二进制，gltf=JSON+分离资源。默认 glb。"),
  },
  async execute(args: Record<string, unknown>, context: BlenderToolContext) {
    try {
      const formatRaw = asString(args.format)
      if (formatRaw !== undefined && formatRaw !== "glb" && formatRaw !== "gltf") {
        return fail("invalid_args", `format 只接受 "glb" 或 "gltf"，收到 "${formatRaw}"。`)
      }
      const format = formatRaw ?? "glb"
      const outputName = sanitizeOutputName(args.output_name, "scene")
      const script = buildExportScript({
        sceneBlendPath: asString(args.scene_blend_path),
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
})
