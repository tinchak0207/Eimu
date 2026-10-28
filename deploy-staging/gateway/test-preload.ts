// bun test 引导。必须在任何网关模块之前执行，且自身不得 import 网关模块。
// bun 1.4.2（744846f84）的 bunfig [test] 不认 isolate：二进制里的配置错误串没有这个键，
// 实测 isolate=true 与 false 都只跑一次 preload、只评估一次模块。
// CLI --isolate 会换一套 global、清空 ESM 模块表，并按文件重跑 preload
// （https://bun.com/docs/test/parallel ，「--isolate」节；同一进程，不是每文件一个进程）。
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

if (process.env.EIMU_GATEWAY_TEST_ISOLATE !== "1") {
  let args: string[] = []
  try {
    args = readFileSync("/proc/self/cmdline").toString().split("\0").filter(Boolean)
  } catch {
    args = []
  }
  const testAt = args.indexOf("test")
  const userArgs = testAt >= 0 ? args.slice(testAt + 1) : []
  const forwarded = userArgs.includes("--isolate") ? userArgs : ["--isolate", ...userArgs]
  const child = spawnSync(process.execPath, ["test", ...forwarded], {
    stdio: "inherit",
    env: { ...process.env, EIMU_GATEWAY_TEST_ISOLATE: "1" },
    cwd: process.cwd(),
  })
  process.exit(child.status === null ? 1 : child.status)
}

const root = mkdtempSync(join(tmpdir(), "gw-test-"))
process.env.WORKSPACE_DIR = join(root, "workspace")
process.env.LEDGER_PATH = join(root, "ledger.jsonl")
process.env.SESSIONS_DB_PATH = join(root, "sessions.db")
process.env.PLATFORM_BASE = "http://127.0.0.1:1"
process.env.OPENCODE_URL = "http://127.0.0.1:1"
delete process.env.QUOTA_URL
mkdirSync(process.env.WORKSPACE_DIR, { recursive: true })

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input?.url ?? input)
  if (raw.includes("image.tinchak0207.xyz")) {
    throw new Error(`gateway tests blocked a request to image.tinchak0207.xyz: ${raw}`)
  }
  return realFetch(input, init)
}) as typeof fetch
