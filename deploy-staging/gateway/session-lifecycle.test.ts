// S19 回滚安全回归（2026-10-28，S14 现场发现）：
// session-lifecycle.ts:handleCreateSession 在创建 opencode 会话时必须按**会话席位**选 agent——
// opencode 在创建时绑定工具表（本档 2026-10-19 事故注释），而 `creator` 已被 S14 重定义为
// 10 工具的工程席位。EIMU_PROJECT_MODE=off 时新会话若仍绑 `creator`，回滚路径直接坏掉。
//
// 期望值来源（独立于被测实现）：
//   - EIMU_PROJECT_MODE 语义与旧会话回退口径来自设计文档 §7；
//   - 每轮席位映射（creator / orchestrator_legacy / creator_legacy）来自 S14 resolvePromptSeat
//     的口径——创建 body 必须与它逐项一致，否则「会话内工具集不变」在第一条消息就破。
// fake opencode：拦截 global fetch，捕获 POST /session 的 body 并回 {id}。
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SANDBOX = mkdtempSync(join(tmpdir(), "s19-session-create-"))
process.env.SESSIONS_DB_PATH = join(SANDBOX, "sessions.db")
process.env.GATEWAY_DB_PATH = join(SANDBOX, "gw.db")
process.env.WORKSPACE_DIR = join(SANDBOX, "workspace")
process.env.LEDGER_PATH = join(SANDBOX, "ledger.jsonl")
process.env.OPENCODE_URL = "http://127.0.0.1:1" // 真网络不可达：所有请求都被下面的 stub 截住

type Captured = { method: string; path: string; body: Record<string, unknown> | null }
const captured: Captured[] = []
const realFetch = globalThis.fetch
let seq = 0
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : String((input as { url?: unknown })?.url ?? input))
  const method = (init?.method ?? "GET").toUpperCase()
  let body: Record<string, unknown> | null = null
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>
    } catch {
      body = null
    }
  }
  captured.push({ method, path: url.pathname, body })
  if (method === "POST" && url.pathname === "/session") return Response.json({ id: `oc-fake-${++seq}` })
  return Response.json({ error: "unexpected" }, { status: 500 })
}) as typeof fetch

const { handleCreateSession, beastAgentField } = await import("./session-lifecycle.ts")
const { sessions, seatUserId } = await import("./sessions-core.ts")
const persistence = await import("./persistence.ts")
type SessionState = import("./types-gateway.ts").SessionState

afterAll(() => {
  globalThis.fetch = realFetch
  rmSync(SANDBOX, { recursive: true, force: true })
})

function setBeast(apiKey: string, beast: boolean): void {
  persistence.saveUserSettings(apiKey, { interrupt_mode: "ask", persona: "default", cost_mode: "auto", beast_mode: beast })
}

/** 真 handleCreateSession → fake opencode 捕获创建 body → 读回内存态与持久化 row。 */
async function createSession(apiKey: string): Promise<{ agent: unknown; state: Record<string, unknown>; row: Record<string, unknown> | null }> {
  captured.length = 0
  const req = new Request("http://gateway.test/agent/v1/sessions", { method: "POST", body: JSON.stringify({}) })
  const res = await handleCreateSession(apiKey, req)
  expect(res.status).toBe(200)
  const json = (await res.json()) as { session_id?: string }
  expect(typeof json.session_id).toBe("string")
  const created = captured.find((c) => c.method === "POST" && c.path === "/session")
  expect(created).toBeDefined()
  const state = sessions.get(json.session_id!) as unknown as Record<string, unknown>
  expect(state).toBeDefined()
  const row = persistence.loadSessionById(json.session_id!) as unknown as Record<string, unknown> | null
  return { agent: created!.body?.agent, state, row }
}

function configure(mode: string, allowlist?: string[]): void {
  process.env.EIMU_PROJECT_MODE = mode
  if (allowlist) process.env.EIMU_PROJECT_MODE_ALLOWLIST = allowlist.join(",")
  else delete process.env.EIMU_PROJECT_MODE_ALLOWLIST
}

describe("会话创建席位（opencode 创建时绑定工具表）", () => {
  test("off + 非 beast → 创建 body agent=creator_legacy，锁存 seat=creator_legacy", async () => {
    configure("off")
    const key = "sk-create-off"
    setBeast(key, false)
    const { agent, state, row } = await createSession(key)
    expect(agent).toBe("creator_legacy")
    expect(state.seat).toBe("creator_legacy")
    expect(state.projectMode).toBe(false)
    expect(state.beast).toBe(false)
    // 创建时就落盘（重启后不丢锁存）
    expect((row?.data as { seat?: unknown })?.seat).toBe("creator_legacy")
  })

  test("off + beast → 创建 body agent=orchestrator_legacy，锁存 seat=creator_legacy/beast=true", async () => {
    configure("off")
    const key = "sk-create-off-beast"
    setBeast(key, true)
    const { agent, state } = await createSession(key)
    expect(agent).toBe("orchestrator_legacy")
    expect(state.seat).toBe("creator_legacy")
    expect(state.projectMode).toBe(false)
    expect(state.beast).toBe(true)
  })

  test("on → 创建 body agent=旧席位（creator_legacy／beast 时 orchestrator_legacy），锁存 seat=creator_legacy/projectMode=true", async () => {
    configure("on")
    for (const beast of [false, true]) {
      const key = `sk-create-on-${beast ? "beast" : "plain"}`
      setBeast(key, beast)
      const { agent, state } = await createSession(key)
      // 2026-10-29：工程模式＝旧席位＋工程图引擎，席位随 beast 走旧映射；lean creator 不再分给新会话
      expect(agent).toBe(beast ? "orchestrator_legacy" : "creator_legacy")
      expect(state.seat).toBe("creator_legacy")
      expect(state.projectMode).toBe(true)
      expect(state.beast).toBe(beast)
    }
  })

  test("allowlist：命中 → 旧席位＋工程引擎（projectMode=true）；未命中 → 旧席位无引擎（按已鉴权 userId）", async () => {
    const hitKey = "sk-create-allow-hit"
    const missKey = "sk-create-allow-miss"
    setBeast(hitKey, false)
    setBeast(missKey, false)
    configure("allowlist", [seatUserId(hitKey)])

    const hit = await createSession(hitKey)
    expect(hit.agent).toBe("creator_legacy")
    expect(hit.state.seat).toBe("creator_legacy")
    expect(hit.state.projectMode).toBe(true)

    const miss = await createSession(missKey)
    expect(miss.agent).toBe("creator_legacy")
    expect(miss.state.seat).toBe("creator_legacy")
    expect(miss.state.projectMode).toBe(false)
  })

  test("创建 body 的 agent 与 state 锁存同源：seat=creator_legacy 的 body 永远不会是 creator", async () => {
    configure("off")
    const key = "sk-create-consistency"
    setBeast(key, false)
    for (let i = 0; i < 3; i++) {
      const { agent, state } = await createSession(key)
      const expected = state.seat === "creator" ? "creator" : state.beast === true ? "orchestrator_legacy" : "creator_legacy"
      expect(agent).toBe(expected)
    }
  })
})

// ── 推送路径（job-delivery.ts:298 / workflow-gw-service.ts:597 / index.ts 的 prompt 推送）──
// beastAgentField 必须按锁存席位映射：旧席位会话不得被指到 S14 重定义的 10 工具 orchestrator。
describe("beastAgentField：按锁存席位映射", () => {
  const seatState = (apiKey: string, seat?: "creator" | "creator_legacy"): SessionState =>
    ({ apiKey, ...(seat ? { seat } : {}) }) as unknown as SessionState

  test("seat=creator：beast 两值都 → creator（工程会话不读设置换席位）", () => {
    const beastKey = "sk-push-proj-beast"
    const plainKey = "sk-push-proj-plain"
    setBeast(beastKey, true)
    setBeast(plainKey, false)
    expect(beastAgentField(seatState(beastKey, "creator"))).toEqual({ agent: "creator" })
    expect(beastAgentField(seatState(plainKey, "creator"))).toEqual({ agent: "creator" })
  })

  test("seat=creator_legacy + beast → orchestrator_legacy（旧席位，不是新 orchestrator）", () => {
    const key = "sk-push-legacy-beast"
    setBeast(key, true)
    const field = beastAgentField(seatState(key, "creator_legacy"))
    expect(field).toEqual({ agent: "orchestrator_legacy" })
    expect(Object.values(field)).not.toContain("orchestrator")
  })

  test("seat=creator_legacy + 非 beast → creator_legacy", () => {
    const key = "sk-push-legacy-plain"
    setBeast(key, false)
    // 独立依据：不带 agent 的 prompt 会被 opencode 落到 build，legacy 非 beast 必须显式 creator_legacy。
    expect(beastAgentField(seatState(key, "creator_legacy"))).toEqual({ agent: "creator_legacy" })
  })

  test("state 无 seat 键 → 按 creator_legacy 处理", () => {
    const beastKey = "sk-push-noseat-beast"
    const plainKey = "sk-push-noseat-plain"
    setBeast(beastKey, true)
    setBeast(plainKey, false)
    expect(beastAgentField(seatState(beastKey))).toEqual({ agent: "orchestrator_legacy" })
    // 独立依据：不带 agent 的 prompt 会被 opencode 落到 build，legacy 非 beast 必须显式 creator_legacy。
    expect(beastAgentField(seatState(plainKey))).toEqual({ agent: "creator_legacy" })
  })
})
