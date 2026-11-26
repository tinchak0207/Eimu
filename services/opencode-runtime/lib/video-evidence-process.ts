import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// 执行档位置（VPS 现场：ffmpeg/ffprobe 不在 PATH；惯例同 lib/asr.ts:61-62）

const BIN_DIR = "/opt/agent-harness/bin"
export const FFMPEG = process.env.FFMPEG_PATH || (existsSync(join(BIN_DIR, "ffmpeg")) ? join(BIN_DIR, "ffmpeg") : "ffmpeg")
export const FFPROBE = process.env.FFPROBE_PATH || (existsSync(join(BIN_DIR, "ffprobe")) ? join(BIN_DIR, "ffprobe") : "ffprobe")

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function round(value: number): number {
  return Number(value.toFixed(3))
}

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

export async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  )
}

// ---------------------------------------------------------------------------
// 外部程序层（移植 hypit process.ts：成功时 stderr 仍可携带工具 metadata，
// 例如被抽出的影格时间戳，故 runProcessOutput 必须把 stderr 交回呼叫端）

type ProcessInput = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>
export type ProcessOutput = { readonly stdout: Buffer; readonly stderr: string }

function run(
  executable: string,
  args: readonly string[],
  input: ProcessInput | undefined,
  timeoutMs: number,
  onStderrLine?: (line: string) => void,
): Promise<ProcessOutput> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, [...args], { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true })
    const out: Buffer[] = []
    let err = ""
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolveRun({ stdout: Buffer.concat(out), stderr: err })
      else reject(error)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(new Error(`${executable} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk))
    let pendingLine = ""
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      err = `${err}${text}`.slice(-100_000)
      if (onStderrLine !== undefined) {
        const lines = `${pendingLine}${text}`.split(/\r?\n/u)
        pendingLine = lines.pop()!
        for (const line of lines) onStderrLine(line)
      }
    })
    child.on("error", (error) => finish(new Error(`${executable} could not start: ${error.message}`)))
    child.on("close", (code) => {
      if (code === 0) finish()
      else finish(new Error(`${executable} exited with ${code}: ${err.trim()}`))
    })
    if (input !== undefined && child.stdin !== null) {
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") finish(new Error(`${executable} input failed: ${error.message}`))
      })
      void (async () => {
        const chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array> = input instanceof Uint8Array ? [input] : input
        for await (const chunk of chunks) {
          if (!child.stdin!.write(chunk)) await once(child.stdin!, "drain")
        }
        child.stdin!.end()
      })().catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "EPIPE")) {
          child.kill("SIGKILL")
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
    }
  })
}

/** 跑完一支外部程序并回传 stdout；stderr 进错误讯息。 */
export async function runProcess(executable: string, args: readonly string[], timeoutMs = 300_000): Promise<Buffer> {
  return (await run(executable, args, undefined, timeoutMs)).stdout
}

/** 成功时 stderr 仍可携带工具 metadata，例如被抽出的影格时间戳。 */
export function runProcessOutput(
  executable: string,
  args: readonly string[],
  timeoutMs = 300_000,
  onStderrLine?: (line: string) => void,
): Promise<ProcessOutput> {
  return run(executable, args, undefined, timeoutMs, onStderrLine)
}

/** 同一个程序边界，当确定性位元流是程式的输入之一时使用（位图字型叠字）。 */
export async function runProcessWithInput(
  executable: string,
  args: readonly string[],
  input: ProcessInput,
  timeoutMs = 300_000,
): Promise<Buffer> {
  return (await run(executable, args, input, timeoutMs)).stdout
}

// ---------------------------------------------------------------------------
// sharp 探测（拼板文字标签；现场 vips 8.18.7 可用，text/pango 实测可渲染）

type SharpFactory = ((input: unknown, options?: unknown) => any) & { versions?: { vips?: string } }

let sharpPromise: Promise<SharpFactory | null> | null = null

/** 探测 sharp 是否可用；不可用回 null（呼叫端决定是明示失败还是退化）。 */
export function loadSharp(): Promise<SharpFactory | null> {
  if (sharpPromise === null) {
    sharpPromise = (async (): Promise<SharpFactory | null> => {
      try {
        const mod = (await import("sharp")) as unknown as { default?: SharpFactory }
        const factory = (mod.default ?? (mod as unknown as SharpFactory)) as SharpFactory
        return typeof factory === "function" ? factory : null
      } catch {
        return null
      }
    })()
  }
  return sharpPromise
}
