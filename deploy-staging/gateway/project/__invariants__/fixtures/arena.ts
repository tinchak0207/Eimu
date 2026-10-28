// L2 对局台 v0：按脚本回放工具调用和文本。小样直接交给调用方。不打平台，不调模型。
import "./env.ts"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { INVARIANTS_SANDBOX } from "./env.ts"
import { platform } from "./fake-platform.ts"
import { recorder } from "./recorder.ts"

export const FAULT_NAMES = ["timeout", "bad_file", "gateway_restart", "user_changes_mind", "leave_and_return"] as const
export type FaultName = (typeof FAULT_NAMES)[number]
export type SampleKind = "image" | "video" | "audio"

export interface ScriptTurn {
  role: "user" | "agent"
  text?: string
  tool?: string
  args?: Record<string, unknown>
}

/** 5–40 轮。短于 5 或长于 40，replay 直接拒绝。 */
export interface SceneScript {
  id: string
  turns: ScriptTurn[]
}

export type Fault =
  | { name: "timeout"; at: number }
  | { name: "bad_file"; at: number }
  | { name: "gateway_restart"; at: number }
  | { name: "user_changes_mind"; at: number; text: string }
  | { name: "leave_and_return"; at: number }

export interface Charge {
  turn: number
  tool: string
  key: string
}

export interface ReplayEvent {
  index: number
  role: "user" | "agent"
  text?: string
  tool?: string
  args?: Record<string, unknown>
  status: "ok" | "failed"
  result: { path: string; bytes: number } | null
  debit: number
  retries: number
  readable: string[]
  decodeOk?: boolean
}

export interface ReplayState {
  scriptId: string
  cursor: number
  events: ReplayEvent[]
  charges: Charge[]
  corrections: string[]
  userTexts: string[]
}

export interface ResumeKey {
  scriptId: string
  cursor: number
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

const mem = new Map<string, ReplayState>()

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_")
}

function sessionFile(id: string): string {
  return join(INVARIANTS_SANDBOX, "arena-sessions", `${safeId(id)}.json`)
}

function save(state: ReplayState): void {
  const file = sessionFile(state.scriptId)
  mkdirSync(dirname(file), { recursive: true })
  const snap = clone(state)
  writeFileSync(file, JSON.stringify(snap))
  mem.set(state.scriptId, snap)
}

function load(id: string): ReplayState | null {
  const hit = mem.get(id)
  if (hit) return clone(hit)
  const file = sessionFile(id)
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, "utf8")) as ReplayState
}

function hasBin(name: string): boolean {
  const found = spawnSync("which", [name], { encoding: "utf8" })
  return found.status === 0 && Boolean(found.stdout.trim())
}

export async function makeSample(kind: SampleKind, destPath: string): Promise<{ bytes: number }> {
  mkdirSync(dirname(destPath), { recursive: true })
  if (kind === "image") {
    if (PNG_1X1[0] !== 0x89 || PNG_1X1[1] !== 0x50 || PNG_1X1[2] !== 0x4e || PNG_1X1[3] !== 0x47) {
      throw new Error("PNG 小样头不是 89 50 4E 47")
    }
    writeFileSync(destPath, PNG_1X1)
    return { bytes: PNG_1X1.length }
  }
  if (!hasBin("ffmpeg")) throw new Error(`本机没有 ffmpeg，拒绝为 ${kind} 写一个假容器冒充可解码`)
  const args = kind === "video"
    ? ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=160x120:d=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-t", "1", destPath]
    : ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-t", "1", "-c:a", "pcm_s16le", destPath]
  const ran = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 20000 })
  if (ran.status !== 0) {
    throw new Error(`ffmpeg 生成 ${kind} 失败，退出码 ${String(ran.status)}：${ran.stderr || ran.stdout || ran.error?.message || ""}`)
  }
  const bytes = statSync(destPath).size
  if (bytes <= 0) throw new Error(`${kind} 小样是空文件`)
  return { bytes }
}

function decodable(kind: SampleKind, filePath: string): boolean {
  const buf = readFileSync(filePath)
  if (kind === "image") {
    return buf.length >= 8
      && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
      && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  }
  if (!hasBin("ffprobe")) throw new Error(`本机没有 ffprobe，不能把 ${kind} 判成可解码`)
  const probe = spawnSync("ffprobe", ["-v", "error", filePath], { encoding: "utf8", timeout: 20000 })
  if (probe.error) throw new Error(`ffprobe 无法执行：${probe.error.message}`)
  return probe.status === 0
}

function assertScript(script: SceneScript): void {
  const n = script?.turns?.length ?? 0
  if (!script?.id) throw new Error("场景脚本缺少 id")
  if (n < 5 || n > 40) throw new Error(`场景脚本轮数必须在 5 到 40 之间，实际 ${n}`)
  for (const turn of script.turns) {
    if (turn.role !== "user" && turn.role !== "agent") throw new Error(`非法 role：${String(turn.role)}`)
  }
}

function assertFaults(script: SceneScript, faults: Fault[]): void {
  const known = new Set<string>(FAULT_NAMES)
  for (const fault of faults) {
    if (!known.has(fault.name)) throw new Error(`未知故障：${fault.name}`)
    if (!Number.isInteger(fault.at) || fault.at < 0 || fault.at >= script.turns.length) {
      throw new Error(`故障 ${fault.name} 的位置 ${fault.at} 不在脚本内`)
    }
    if (fault.name === "user_changes_mind" && fault.text.length === 0) throw new Error("user_changes_mind 缺少原文")
  }
}

function readKind(turn: ScriptTurn, required: boolean): SampleKind | null {
  const kind = (turn.args as { kind?: unknown } | undefined)?.kind
  if (kind == null) {
    if (required) throw new Error("bad_file 需要 args.kind = image|video|audio")
    return null
  }
  if (kind === "image" || kind === "video" || kind === "audio") return kind
  throw new Error(`未知节点类型：${String(kind)}`)
}

function samplePath(scriptId: string, index: number, kind: SampleKind): string {
  const ext = kind === "image" ? "png" : kind === "video" ? "mp4" : "wav"
  return join(INVARIANTS_SANDBOX, "arena-samples", `${safeId(scriptId)}-${index}.${ext}`)
}

/** 同一 turn + tool 只记一笔。调用点不放在循环里，超时不会再记第二笔。 */
function chargeOnce(state: ReplayState, turn: number, tool: string): void {
  state.charges.push({ turn, tool, key: `${state.scriptId}:${turn}:${tool}` })
}

async function corruptSample(kind: SampleKind, scriptId: string, index: number): Promise<{ path: string; bytes: number; decodeOk: boolean }> {
  const dest = samplePath(scriptId, index, kind)
  await makeSample(kind, dest)
  const buf = readFileSync(dest)
  if (buf.length < 8) throw new Error("小样太短，无法替换文件头")
  buf.set([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77], 0)
  writeFileSync(dest, buf)
  const decodeOk = decodable(kind, dest)
  if (decodeOk) throw new Error("bad_file 换成非法头之后解码检查仍通过")
  return { path: dest, bytes: buf.length, decodeOk }
}

function fresh(script: SceneScript): ReplayState {
  return { scriptId: script.id, cursor: 0, events: [], charges: [], corrections: [], userTexts: [] }
}

function resumeFrom(script: SceneScript, resume: ResumeKey): ReplayState {
  if (resume.scriptId !== script.id) throw new Error(`script id 不一致：请求 ${resume.scriptId}，脚本 ${script.id}`)
  const snap = load(script.id)
  if (!snap) throw new Error(`没有可恢复的对局：${script.id}`)
  if (snap.scriptId !== script.id) throw new Error(`快照 script id 不是 ${script.id}`)
  if (snap.cursor !== resume.cursor) throw new Error(`cursor 不一致：保存 ${snap.cursor}，请求 ${resume.cursor}`)
  if (snap.events.length !== snap.cursor) throw new Error(`游标 ${snap.cursor} 之前只剩下 ${snap.events.length} 条，已完成 turn 丢了`)
  return snap
}

async function oneTurn(script: SceneScript, index: number, state: ReplayState, fault: Fault | undefined): Promise<ReplayEvent> {
  const turn = script.turns[index]
  if (turn.role === "user" && turn.text) state.userTexts.push(turn.text)
  const event: ReplayEvent = {
    index,
    role: turn.role,
    status: "ok",
    result: null,
    debit: 0,
    retries: 0,
    readable: state.userTexts.slice(),
  }
  if (turn.text !== undefined) event.text = turn.text
  if (turn.tool !== undefined) event.tool = turn.tool
  if (turn.args !== undefined) event.args = turn.args
  if (turn.role !== "agent" || !turn.tool) return event
  if (fault?.name === "timeout") {
    chargeOnce(state, index, turn.tool)
    event.status = "failed"
    event.result = null
    event.debit = 1
    return event
  }
  if (fault?.name === "bad_file") {
    const file = await corruptSample(readKind(turn, true) as SampleKind, script.id, index)
    chargeOnce(state, index, turn.tool)
    event.status = "failed"
    event.result = { path: file.path, bytes: file.bytes }
    event.decodeOk = file.decodeOk
    event.debit = 1
    return event
  }
  const kind = readKind(turn, false)
  chargeOnce(state, index, turn.tool)
  event.debit = 1
  if (kind) {
    const dest = samplePath(script.id, index, kind)
    const got = await makeSample(kind, dest)
    event.result = { path: dest, bytes: got.bytes }
  }
  return event
}

export async function replay(
  script: SceneScript,
  faults: Fault[] = [],
  resume?: ResumeKey | null,
): Promise<{ state: ReplayState; halted: FaultName | null }> {
  const posts = platform.posts.length
  const reqs = recorder.requests.length
  try {
    assertScript(script)
    assertFaults(script, faults)
    const state = resume ? resumeFrom(script, resume) : fresh(script)
    let halted: FaultName | null = null
    for (let i = state.cursor; i < script.turns.length; i++) {
      const fault = faults.find((item) => item.at === i)
      if (fault?.name === "user_changes_mind") {
        state.corrections.push(fault.text)
        state.userTexts.push(fault.text)
      }
      if (fault?.name === "gateway_restart" || fault?.name === "leave_and_return") {
        state.cursor = i
        save(state)
        if (fault.name === "gateway_restart") mem.delete(script.id)
        halted = fault.name
        break
      }
      state.events.push(await oneTurn(script, i, state, fault))
      state.cursor = i + 1
    }
    if (!halted) save(state)
    return { state: clone(state), halted }
  } finally {
    if (platform.posts.length !== posts) throw new Error("arena 向计费平台提交了生成，本夹具不许扣到平台")
    if (recorder.requests.length !== reqs) throw new Error("arena 向 recorder 投递了请求")
  }
}

export const SAMPLE_SCRIPT: SceneScript = {
  id: "sample-shot-3-retake",
  turns: [
    { role: "user", text: "做一支 15 秒茶饮广告，三镜，16:9" },
    { role: "agent", text: "先出第 1 镜静帧", tool: "image.generate", args: { kind: "image", node: "shot1" } },
    { role: "agent", text: "第 2 镜接上", tool: "image.generate", args: { kind: "image", node: "shot2" } },
    { role: "user", text: "第 3 镜重拍，杯子换成玻璃杯" },
    { role: "agent", text: "重拍第 3 镜", tool: "video.generate", args: { kind: "video", node: "shot3" } },
    { role: "agent", text: "铺一层 1 秒正弦", tool: "audio.generate", args: { kind: "audio", node: "bed" } },
  ],
}
