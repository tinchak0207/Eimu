import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { spawn } from "node:child_process"
import { mkdir, writeFile, open } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { checkAgentPath, sandboxAvailable, sandboxPrefix, sessionRunDir, sessionTmpDir } from "../lib/sandbox"

const OUT_CAP = 64 * 1024

// 通用資料加工逃生艙：確定型腳本（統計/清洗/格式轉換）一次呼叫完成。
// 限制：bwrap 沙箱（lib/sandbox.ts：無秘密環境、無網路、只見本會話附件）、cwd=.run、超時 SIGKILL、
// stdout+stderr 合計 64KB 截斷。沙箱不可用 → 拒絕執行（fail-closed）。

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
    "通用 Python 資料加工腳本逃生艙。輸入 code（Python 3 原始碼），在沙箱 .run 目錄以受限環境執行一次，回傳 {ok, exit_code, duration_ms, stdout, stderr}。用途：確定型資料統計/清洗/格式轉換，一次呼叫完成，取代多輪 awk/grep 鏈。沙箱無網路（需要下載/上傳請用原生工具）；只能讀寫工作區與本會話附件；程序逾時會被 SIGKILL。stdout+stderr 合計超過 64KB 會截斷並標 truncated。沙箱 PATH 已含 ffmpeg/ffprobe（/opt/agent-harness/bin，靜態二進制）：可做視頻裁剪/拼接/轉碼/字幕/音頻混音等本地媒體處理（免費不扣費）。",
  args: {
    code: tool.schema.string().min(1).describe("要執行的 Python 3 原始碼（一次呼叫內自足）"),
    timeout_seconds: tool.schema
      .number()
      .int()
      .min(5)
      .max(120)
      .optional()
      .describe("逾時秒數，5–120，預設 30"),
    stdin_path: tool.schema
      .string()
      .optional()
      .describe("可選：作為 stdin 餵給腳本的檔案路徑"),
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
        stderr: timedOut ? `逾時被 SIGKILL（timeout_seconds=${(timeoutMs / 1000) | 0}）\n` + se.text : se.text,
        truncated: so.truncated || se.truncated,
      }
      if (okRun) {
        return ok({ title: "run_py", ...payload })
      }
      return fail("run_py_failed", timedOut ? `逾時被 SIGKILL（${(timeoutMs / 1000) | 0}s）` : `exit=${r.code}；stderr 見 output`, payload)
    } catch (e: any) {
      return fail("run_py_failed", `run_py 執行失敗：${e?.message ?? e}`, { duration_ms: Date.now() - t0 })
    }
  },
})
