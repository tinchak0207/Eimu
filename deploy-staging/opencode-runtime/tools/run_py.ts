import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { spawn } from "node:child_process"
import { mkdir, writeFile, open } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { checkAgentPath, sandboxAvailable, sandboxPrefix, sessionRunDir, sessionTmpDir } from "../lib/sandbox"

const OUT_CAP = 64 * 1024

// 通用资料加工逃生舱：确定型脚本（统计/清洗/格式转换）一次呼叫完成。
// 限制：bwrap 沙箱（lib/sandbox.ts：无秘密环境、无网路、只见本会话附件）、cwd=.run、超时 SIGKILL、
// stdout+stderr 合计 64KB 截断。沙箱不可用 → 拒绝执行（fail-closed）。

function cap(s: string) {
  if (s.length <= OUT_CAP) return { text: s, truncated: false }
  return { text: s.slice(0, OUT_CAP), truncated: true }
}

function runOnce(
  sessionID: string,
  code: string,
  file: string,
  timeoutMs: number,
  stdinPath?: string,
  abort?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(async (resolve, reject) => {
    let stdinFd: any = null
    if (stdinPath) {
      try {
        stdinFd = await open(stdinPath, "r")
      } catch (e) {
        reject(e)
        return
      }
    }
    const runDir = sessionRunDir(sessionID)
    const prefix = sandboxPrefix({ sessionID, cwd: runDir })
    const child = spawn(prefix[0], [...prefix.slice(1), "python3", file], {
      cwd: runDir,
      env: { PATH: "/usr/bin:/bin" },
      stdio: [stdinFd ? stdinFd.fd : "ignore", "pipe", "pipe"],
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
      if (stdout.length < OUT_CAP * 2) stdout += d
    })
    child.stderr.on("data", (d) => {
      if (stderr.length < OUT_CAP * 2) stderr += d
    })
    child.on("error", (e) => {
      clearTimeout(timer)
      if (stdinFd) stdinFd.close().catch(() => {})
      reject(e)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (abort) abort.removeEventListener("abort", onAbort)
      if (stdinFd) stdinFd.close().catch(() => {})
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

export default tool({
  description:
    "通用 Python 资料加工脚本逃生舱。输入 code（Python 3 原始码），在沙箱 .run 目录以受限环境执行一次，回传 {ok, exit_code, duration_ms, stdout, stderr}。用途：确定型资料统计/清洗/格式转换，一次呼叫完成，取代多轮 awk/grep 链。沙箱无网路（需要下载/上传请用原生工具）；只能读写工作区与本会话附件；程序逾时会被 SIGKILL。stdout+stderr 合计超过 64KB 会截断并标 truncated。沙箱 PATH 已含 ffmpeg/ffprobe（/opt/agent-harness/bin，静态二进制）：可做视频裁剪/拼接/转码/字幕/音频混音等本地媒体处理（免费不扣费）。",
  args: {
    code: tool.schema.string().min(1).describe("要执行的 Python 3 原始码（一次呼叫内自足）"),
    timeout_seconds: tool.schema
      .number()
      .int()
      .min(5)
      .max(120)
      .optional()
      .describe("逾时秒数，5–120，预设 30"),
    stdin_path: tool.schema
      .string()
      .optional()
      .describe("可选：作为 stdin 喂给脚本的档案路径"),
  },
  async execute(args, context) {
    const t0 = Date.now()
    if (!sandboxAvailable()) return fail("run_py_unavailable", "执行环境暂不可用，请改用原生工具完成。")
    if (args.stdin_path) {
      const v = checkAgentPath(args.stdin_path, context.sessionID)
      if (!v.ok) return fail("run_py_path_denied", "stdin_path 不在本会话可访问的范围内。")
    }
    const runDir = sessionRunDir(context.sessionID)
    await mkdir(sessionTmpDir(context.sessionID), { recursive: true }).catch(() => {})
    await mkdir(runDir, { recursive: true })
    const file = `${runDir}/${Date.now()}-${randomBytes(4).toString("hex")}.py`
    await writeFile(file, args.code, "utf-8")

    const timeoutMs = Math.max(5, Math.min(120, args.timeout_seconds ?? 30)) * 1000
    try {
      const r = await runOnce(context.sessionID, args.code, file, timeoutMs, args.stdin_path, context.abort)
      const so = cap(r.stdout)
      const se = cap(r.stderr)
      const timedOut = r.timedOut
      const okRun = r.code === 0 && !timedOut
      const payload = {
        ok: okRun,
        exit_code: r.code,
        duration_ms: Date.now() - t0,
        stdout: so.text,
        stderr: timedOut ? `逾时被 SIGKILL（timeout_seconds=${(timeoutMs / 1000) | 0}）\n` + se.text : se.text,
        truncated: so.truncated || se.truncated,
      }
      if (okRun) {
        return ok({ title: "run_py", ...payload })
      }
      return fail("run_py_failed", timedOut ? `逾时被 SIGKILL（${(timeoutMs / 1000) | 0}s）` : `exit=${r.code}；stderr 见 output`, payload)
    } catch (e: any) {
      return fail("run_py_failed", `run_py 执行失败：${e?.message ?? e}`, { duration_ms: Date.now() - t0 })
    }
  },
})
