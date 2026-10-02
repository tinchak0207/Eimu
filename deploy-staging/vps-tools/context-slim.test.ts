// context-slim plugin 真值測試（T1-3 microCompact ＋ T1-4 工具結果安全網）。
//
// 真行為斷言：餵真實 messages 形狀（{info, parts}[]，Part 為 opencode ToolPart/TextPart）給
// **plugin 的 experimental.chat.messages.transform hook 本體**，斷言就地改寫後的記憶體狀態、
// 落盤檔內容逐位元相同、預覽切在換行邊界；不是源碼字串掃描。
//
// 跑法：bun test deploy-staging/vps-tools/context-slim.test.ts
// 環境變數須在動態 import plugin 前設定（常數在模組載入時求值）。
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"

const PERSIST_DIR = mkdtempSync(join(tmpdir(), "context-slim-"))
process.env.CONTEXT_SLIM = "1"
process.env.TOOL_RESULT_PERSIST_DIR = PERSIST_DIR

const { CLEARED_MARKER, slimMessages } = await import(
  "../opencode-runtime/lib/context-slim-core"
)
const { ContextSlim } = await import("../opencode-runtime/plugin/context-slim")

afterAll(() => {
  rmSync(PERSIST_DIR, { recursive: true, force: true })
})

// ── 測試用的 messages 工廠（貼近 opencode 內部 {info,parts}[] 形狀）────────────

const HOUR = 3_600_000

type Part = Record<string, unknown>
type Msg = { info: Record<string, unknown>; parts: Part[] }

function textPart(text: string): Part {
  return { id: `prt_${text.slice(0, 6)}`, type: "text", text, sessionID: "s", messageID: "m" }
}

function toolPart(tool: string, output: string, start: number): Part {
  return {
    id: `prt_${tool}`,
    sessionID: "s",
    messageID: "m",
    type: "tool",
    callID: `call_${tool}`,
    tool,
    state: {
      status: "completed",
      input: {},
      output,
      title: tool,
      metadata: {},
      time: { start, end: start + 1 },
    },
  }
}

function userMsg(created: number, text = "hello"): Msg {
  return { info: { role: "user", time: { created } }, parts: [textPart(text)] }
}
function asstMsg(parts: Part[], created: number): Msg {
  return { info: { role: "assistant", time: { created } }, parts }
}

/** 8 筆小工具結果（依序 tool-0..tool-7），最後 user 訊息時間可指定。 */
function eightTools(lastUserCreated: number): { messages: Msg[]; outputs: string[] } {
  const outputs = Array.from({ length: 8 }, (_, i) => `OUTPUT-${i}-` + "x".repeat(50))
  const parts = outputs.map((o, i) => toolPart(`tool-${i}`, o, lastUserCreated + i * 1000))
  return {
    messages: [userMsg(lastUserCreated, "請幫我連續做八件事"), asstMsg(parts, lastUserCreated + 1)],
    outputs,
  }
}

async function runHook(messages: Msg[]) {
  const hooks = await (ContextSlim as unknown as (ctx: unknown) => Promise<Record<string, unknown>>)(
    {},
  )
  const transform = hooks["experimental.chat.messages.transform"] as (
    i: unknown,
    o: { messages: Msg[] },
  ) => Promise<void>
  const out = { messages }
  await transform({}, out)
  return out
}

function toolState(msg: Msg, idx: number) {
  const p = msg.parts.filter((x) => x.type === "tool")[idx]
  return p.state as { output: string }
}

// ── loader 契約（2026-10-02 生產事故的守門真值斷言）────────────────────────────

describe("loader 契約：plugin 檔的每個 export 都必須是 function", () => {
  // 起因：plugin/context-slim.ts 曾把常數與函式一起 export，opencode plugin loader
  // 逐個 export 檢查、遇到非函式即整檔載入失敗（`Plugin export is not a function`），
  // 導致 microCompact 與工具結果安全網在生產全是死的。此斷言在舊版即為紅。
  test("plugin/context-slim.ts 的所有 export 皆為 function，且唯一 export 為 ContextSlim", async () => {
    const m = await import("../opencode-runtime/plugin/context-slim")
    const bad = Object.entries(m).filter(([, v]) => typeof v !== "function")
    expect(bad.map(([k]) => k)).toEqual([])
    expect(Object.keys(m)).toEqual(["ContextSlim"])
    expect(typeof (m as { ContextSlim?: unknown }).ContextSlim).toBe("function")
  })
})

// ── 需求 A：microCompact ────────────────────────────────────────────────────

describe("A microCompact：>1h 才清舊工具結果", () => {
  test("(a) 最後 user 訊息 2 小時前 → 前 3 筆清成標記、後 5 筆原文保留、文字 part 逐位元不變", async () => {
    const now = Date.now()
    const { messages, outputs } = eightTools(now - 2 * HOUR)
    const textBefore = JSON.stringify(messages[0].parts)
    const res = await slimMessages(messages, { now })
    expect(res.cleared).toBe(3)
    const asst = messages[1]
    expect(toolState(asst, 0).output).toBe(CLEARED_MARKER)
    expect(toolState(asst, 1).output).toBe(CLEARED_MARKER)
    expect(toolState(asst, 2).output).toBe(CLEARED_MARKER)
    for (let i = 3; i < 8; i++) expect(toolState(asst, i).output).toBe(outputs[i])
    // 文字 part 逐位元不變（且整條 user 訊息不變）
    expect(JSON.stringify(messages[0].parts)).toBe(textBefore)
    expect(JSON.stringify(messages[0])).toBe(JSON.stringify({ info: messages[0].info, parts: messages[0].parts }))
  })

  test("(b) 最後 user 訊息 10 分鐘前 → 零改動", async () => {
    const now = Date.now()
    const { messages, outputs } = eightTools(now - 10 * 60_000)
    const snapshot = JSON.stringify(messages)
    const res = await slimMessages(messages, { now })
    expect(res.cleared).toBe(0)
    expect(JSON.stringify(messages)).toBe(snapshot)
    for (let i = 0; i < 8; i++) expect(toolState(messages[1], i).output).toBe(outputs[i])
  })

  test("(c) 冪等：同一批連續跑兩次，第二次零額外改動", async () => {
    const now = Date.now()
    const { messages } = eightTools(now - 2 * HOUR)
    const first = await slimMessages(messages, { now })
    expect(first.cleared).toBe(3)
    const afterFirst = JSON.stringify(messages)
    const second = await slimMessages(messages, { now })
    expect(second.cleared).toBe(0)
    expect(JSON.stringify(messages)).toBe(afterFirst)
  })

  test("(d) skill 類工具被豁免（不進清除計數）", async () => {
    const now = Date.now()
    const parts = [
      toolPart("skill", "SKILL-OUT-" + "y".repeat(40), now - 2 * HOUR),
      ...Array.from({ length: 3 }, (_, i) => toolPart(`tool-${i}`, `OUT-${i}`, now - 2 * HOUR + i)),
    ]
    const messages: Msg[] = [userMsg(now - 2 * HOUR), asstMsg(parts, now - 2 * HOUR + 1)]
    const res = await slimMessages(messages, { now })
    // 4 筆中 skill 豁免 → 可壓縮 3 筆，keep=5 → 全保留
    expect(res.cleared).toBe(0)
    expect(toolState(messages[1], 0).output).toContain("SKILL-OUT-")
  })

  test("(e) 未完成／error 狀態不動", async () => {
    const now = Date.now()
    const running = { type: "tool", tool: "tool-r", state: { status: "running", input: {}, time: { start: now } } }
    const errored = { type: "tool", tool: "tool-e", state: { status: "error", input: {}, error: "boom" } }
    const completed = toolPart("tool-c", "C", now - 2 * HOUR)
    const messages: Msg[] = [userMsg(now - 2 * HOUR), asstMsg([running as Part, errored as Part, completed], now - 2 * HOUR)]
    await slimMessages(messages, { now })
    expect((running.state as { status: string }).status).toBe("running")
    expect((errored.state as { status: string }).status).toBe("error")
    expect(toolState(messages[1], 2).output).toBe("C") // 僅 1 筆可壓縮 → 保留
  })
})

// ── 需求 B：工具結果預算安全網 ──────────────────────────────────────────────

/** 產生含換行、總長 ≥ n 的內容（模擬原生沒截到的大輸出）。 */
function bigContent(n: number): string {
  const line = "L" + "a".repeat(77) + "\n" // 79 chars/line
  let s = ""
  let i = 0
  while (s.length < n) s += `${String(i++).padStart(5, "0")} ${line}`
  return s
}

function parsePersistedPath(out: string): string {
  const m = /<persisted-output path="([^"]+)"/.exec(out)
  if (!m) throw new Error("no persisted path in output")
  return m[1]
}

describe("B 工具結果安全網：單筆上限與落盤", () => {
  test("(a) 60,000 字元結果 → 改寫後 <50,000、含 <persisted-output、落盤逐位元相同、預覽切在換行邊界", async () => {
    const now = Date.now()
    const original = bigContent(60_000)
    expect(original.length).toBeGreaterThan(59_000)
    const messages: Msg[] = [userMsg(now), asstMsg([toolPart("bash", original, now)], now)]
    const res = await slimMessages(messages, { now })
    expect(res.persisted).toBe(1)

    const out = toolState(messages[1], 0).output
    expect(out.length).toBeLessThan(50_000)
    expect(out).toContain("<persisted-output")

    const file = parsePersistedPath(out)
    expect(existsSync(file)).toBe(true)
    // 落盤內容與原文逐位元相同
    expect(readFileSync(file, "utf8")).toBe(original)

    // 預覽切在換行邊界：頭部是原文前綴且以 "\n" 收尾；尾部是原文後綴且其前一字元是 "\n"
    const afterTag = out.slice(out.indexOf(">\n") + 2)
    const head = afterTag.slice(0, afterTag.indexOf("\n...[中略"))
    expect(head.length).toBeGreaterThan(0)
    expect(original.startsWith(head)).toBe(true)
    expect(head.endsWith("\n")).toBe(true)
    const withoutEnd = out.slice(0, out.lastIndexOf("\n</persisted-output>"))
    const tailText = withoutEnd.slice(withoutEnd.lastIndexOf("]...\n") + 5)
    expect(tailText.length).toBeGreaterThan(0)
    expect(original.endsWith(tailText)).toBe(true)
    if (tailText.length < original.length) {
      expect(original[original.length - tailText.length - 1]).toBe("\n")
    }
  })

  test("(a2) 落盤檔名以內容 hash 定址（同內容同檔、冪等）", async () => {
    const now = Date.now()
    const original = bigContent(60_000)
    const messages: Msg[] = [userMsg(now), asstMsg([toolPart("bash", original, now)], now)]
    await slimMessages(messages, { now })
    const file1 = parsePersistedPath(toolState(messages[1], 0).output)
    // 第二次：輸出已是 <persisted-output> → 安全網放行，不二次落盤
    const res2 = await slimMessages(messages, { now })
    expect(res2.persisted).toBe(0)
    expect(parsePersistedPath(toolState(messages[1], 0).output)).toBe(file1)
  })

  test("(b) 已是原生截斷參考句 → 未被二次處理", async () => {
    const now = Date.now()
    const native =
      "…（內容已截斷）…\nFull output saved to: /opt/agent-harness/workspace/.opencode-state/tool-output/tool_01ABC\nUse Grep/Read with offset/limit to inspect the file."
    const messages: Msg[] = [userMsg(now), asstMsg([toolPart("bash", native, now)], now)]
    const snapshot = JSON.stringify(messages)
    const res = await slimMessages(messages, { now })
    expect(res.persisted).toBe(0)
    expect(JSON.stringify(messages)).toBe(snapshot)
    expect(toolState(messages[1], 0).output).toBe(native)
  })

  test("(c) 單訊息聚合 >200,000 → 後續筆落盤（預算生效）", async () => {
    const now = Date.now()
    // 每筆 45,000（<50k 單筆上限）共 5 筆 = 225,000 > 200,000 → 第 5 筆落盤，前 4 筆保留
    const parts = Array.from({ length: 5 }, (_, i) => bigContent(45_000))
    const messages: Msg[] = [
      userMsg(now),
      asstMsg(parts.map((p, i) => toolPart("bash", p, now + i)), now),
    ]
    const res = await slimMessages(messages, { now })
    expect(res.persisted).toBe(1)
    for (let i = 0; i < 4; i++) expect(toolState(messages[1], i).output).toBe(parts[i])
    expect(toolState(messages[1], 4).output).toContain("<persisted-output")
    const file = parsePersistedPath(toolState(messages[1], 4).output)
    expect(readFileSync(file, "utf8")).toBe(parts[4])
  })
})

// ── Hook 本體：就地改寫 output.messages ────────────────────────────────────

describe("hook 本體", () => {
  test("transform 就地改寫 output.messages（同一陣列參照）", async () => {
    const now = Date.now()
    const { messages } = eightTools(now - 2 * HOUR)
    const out = await runHook(messages)
    expect(out.messages).toBe(messages) // 就地，不是換陣列
    expect(toolState(messages[1], 0).output).toBe(CLEARED_MARKER)
    expect(toolState(messages[1], 7).output).toContain("OUTPUT-7-")
  })

  test("hook 對畸形輸入不拋（原樣放行）", async () => {
    const hooks = await (ContextSlim as unknown as (ctx: unknown) => Promise<Record<string, unknown>>)({})
    const transform = hooks["experimental.chat.messages.transform"] as (i: unknown, o: unknown) => Promise<void>
    await expect(transform({}, {})).resolves.toBeUndefined()
    await expect(transform({}, { messages: undefined })).resolves.toBeUndefined()
    await expect(transform({}, { messages: [{ info: {}, parts: [{ type: "tool" }] }] })).resolves.toBeUndefined()
  })
})
