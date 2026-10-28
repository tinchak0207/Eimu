// S18 不变量测试的进程级沙箱（必须在任何 gateway 模组之前 import）。
//
// 为什么单独一档：本仓已有坑——persistence-schema.ts 的 DB_PATH / constants-gateway.ts 的
// PLATFORM_BASE / OPENCODE_URL 都是**模组载入常量**，静态 import 会把路径钉死到生产值。
// 所以每个 *.test.ts 的第一行都是 `import "./fixtures/env"`，再 dynamic import 被测模块。
//
// 同时装一道 fetch 硬闸：只允许 127.0.0.1 / localhost，任何真实上游呼叫当场抛错并记账，
// 保证「禁止访问真实上游」不是靠自律。
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = process.env.EIMU_INVARIANTS_SANDBOX || mkdtempSync(join(tmpdir(), "s18-invariants-"))
process.env.EIMU_INVARIANTS_SANDBOX = ROOT
// 强制沙箱：即使运行环境预置了 WORKSPACE_DIR/SESSIONS_DB_PATH，也不许写到 /opt/agent-harness。
process.env.WORKSPACE_DIR = join(ROOT, "workspace")
process.env.SESSIONS_DB_PATH = join(ROOT, "sessions.db")
process.env.LEDGER_PATH = join(ROOT, "ledger.jsonl")
process.env.HARNESS_WORKSPACE = process.env.WORKSPACE_DIR
process.env.HARNESS_STATE = join(ROOT, "state")
process.env.OPENCODE_URL = "http://127.0.0.1:9" // 不可达 loopback：任何误投递都立即失败，不出网
if (!process.env.PLATFORM_BASE || process.env.PLATFORM_BASE.includes("image.tinchak0207.xyz")) {
  process.env.PLATFORM_BASE = "http://127.0.0.1:1"
}
process.env.CONFIRM_THRESHOLD_COINS = process.env.CONFIRM_THRESHOLD_COINS || "5"
mkdirSync(process.env.WORKSPACE_DIR, { recursive: true })
mkdirSync(process.env.HARNESS_STATE, { recursive: true })

export const INVARIANTS_SANDBOX = ROOT

/** 本进程里所有真实上游（非 loopback）请求；必须恒为 0。 */
export const foreignRequests: string[] = []

const REAL_FETCH = globalThis.fetch
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input?.url ?? input)
  let host = ""
  try {
    host = new URL(raw).hostname
  } catch {
    host = ""
  }
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]"
  if (!loopback) {
    foreignRequests.push(raw)
    throw new Error(`S18 不变量测试禁止真实网络请求：${raw}`)
  }
  return REAL_FETCH(input, init)
}) as typeof fetch

export function assertNoForeignRequests(): void {
  if (foreignRequests.length) throw new Error(`检测到真实上游请求 ${foreignRequests.length} 次：${foreignRequests.join(", ")}`)
}
