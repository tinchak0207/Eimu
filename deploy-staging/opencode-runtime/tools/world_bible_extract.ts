import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { llmChatJson } from "../lib/llm-channel"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

// 世界觀抽取（2026-08-31 片1 實裝）：小說/設定文本 → 世界觀 JSON。
// 文本分塊 → 逐塊調 LLM 抽取（通道綁定見 lib/llm-channel.ts，key 不落任何輸出）
// → 合併去重 → schema 校驗。LLM 失敗誠實回 ok:false，不降級編造。

const WORKSPACE = "/opt/agent-harness/workspace"
const CHUNK_CHARS = 4500
const MAX_CHUNKS = 6

const SYSTEM = [
  "你是世界觀設定抽取器。從給定的小說/設定文本塊中抽取世界觀要素。",
  "只輸出一個 JSON 物件，不要任何解釋、不要 markdown 柵欄。schema：",
  '{"characters":[{"name","role","description"}],"locations":[{"name","description"}],"factions":[{"name","description"}],"terms":[{"term","definition"}],"keywords":["string"]}',
  "規則：name/term 用文本原詞；description 不超過 60 字且只寫文本中有依據的內容，禁止編造；",
  "keywords 為可複用於生圖 prompt 的視覺/風格詞（服裝、地貌、光線、色調、材質等），每塊最多 12 個。",
].join("\n")

interface Entry {
  name: string
  description?: string
  role?: string
  term?: string
  definition?: string
}

function resolveText(inline?: string, filePath?: string): { text?: string; reason?: string } {
  if (typeof inline === "string" && inline.trim()) return { text: inline }
  if (typeof filePath === "string" && filePath.trim()) {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE, filePath)
    if (!existsSync(abs)) return { reason: `檔案不存在：${abs}` }
    try {
      const text = readFileSync(abs, "utf8")
      if (!text.trim()) return { reason: `檔案為空：${abs}` }
      return { text }
    } catch (e) {
      return { reason: `讀檔失敗：${(e as Error).message}` }
    }
  }
  return { reason: "text 與 path 至少填一個：text 直接給小說文本，path 給 txt/md 檔案路徑" }
}

function chunkText(text: string): { chunks: string[]; truncated: boolean } {
  const paragraphs = text.split(/\n{2,}|\r\n{2,}/)
  const chunks: string[] = []
  let buf = ""
  for (const p of paragraphs) {
    if ((buf + "\n\n" + p).length > CHUNK_CHARS && buf) {
      chunks.push(buf)
      buf = p
    } else {
      buf = buf ? `${buf}\n\n${p}` : p
    }
    if (buf.length > CHUNK_CHARS) {
      chunks.push(buf.slice(0, CHUNK_CHARS))
      buf = buf.slice(CHUNK_CHARS)
    }
  }
  if (buf.trim()) chunks.push(buf)
  const truncated = chunks.length > MAX_CHUNKS
  return { chunks: chunks.slice(0, MAX_CHUNKS), truncated }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

function normKey(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase()
}

function mergeInto(list: Entry[], seen: Map<string, number>, item: Entry, nameField: "name" | "term") {
  const name = str(item[nameField])
  if (!name) return
  const key = normKey(name)
  const idx = seen.get(key)
  if (idx === undefined) {
    seen.set(key, list.length)
    list.push(item)
    return
  }
  const prev = list[idx]
  const prevDesc = str(prev.description) || str(prev.definition)
  const nextDesc = str(item.description) || str(item.definition)
  if (nextDesc.length > prevDesc.length) {
    if (item.description !== undefined) prev.description = item.description
    if (item.definition !== undefined) prev.definition = item.definition
  }
  if (!prev.role && item.role) prev.role = item.role
}

export default tool({
  description:
    "世界觀抽取（LLM 語義任務，走 harness 文字通道，不產生任何圖像/視頻生成扣費）。text 填小說/設定文本原文，或 path 填 txt/md 路徑；可選 focus 指定抽取側重（如「只關注勢力與法術體系」）。輸出 world_bible JSON：characters/locations/factions/terms/keywords（可直接複用為生圖 prompt 詞庫）。文本超長自動分塊（最多 6 塊，超出截斷並老實標註）。短劇/小說可視化第一步：先抽世界觀再鎖角色場景卡。LLM 失敗時回 ok:false 與原因，絕不編造。",
  args: {
    text: tool.schema.string().optional().describe("小說/設定文本原文（與 path 二選一）"),
    path: tool.schema.string().optional().describe("文本檔案路徑 txt/md（與 text 二選一）"),
    focus: tool.schema.string().optional().describe("可選：抽取側重說明"),
  },
  async execute(args) {
    const resolved = resolveText(args.text, args.path)
    if (!resolved.text) return fail("empty_text", resolved.reason || "文本為空", { title: "文本為空" })

    const { chunks, truncated } = chunkText(resolved.text)
    const characters: Entry[] = []
    const locations: Entry[] = []
    const factions: Entry[] = []
    const terms: Entry[] = []
    const keywords: string[] = []
    const charSeen = new Map<string, number>()
    const locSeen = new Map<string, number>()
    const facSeen = new Map<string, number>()
    const termSeen = new Map<string, number>()
    const kwSeen = new Set<string>()

    let chunksFailed = 0
    let lastReason = ""
    for (let i = 0; i < chunks.length; i += 1) {
      const user = `${args.focus ? `抽取側重：${args.focus}\n` : ""}文本塊 ${i + 1}/${chunks.length}：\n${chunks[i]}`
      let result = await llmChatJson(SYSTEM, user, 3000)
      if (!result.ok) result = await llmChatJson(SYSTEM, user, 3000)
      if (!result.ok) {
        chunksFailed += 1
        lastReason = result.reason
        continue
      }
      const d = result.data
      for (const c of Array.isArray(d.characters) ? d.characters : []) {
        if (c && typeof c === "object") mergeInto(characters, charSeen, { name: str((c as Entry).name), role: str((c as Entry).role), description: str((c as Entry).description) }, "name")
      }
      for (const l of Array.isArray(d.locations) ? d.locations : []) {
        if (l && typeof l === "object") mergeInto(locations, locSeen, { name: str((l as Entry).name), description: str((l as Entry).description) }, "name")
      }
      for (const f of Array.isArray(d.factions) ? d.factions : []) {
        if (f && typeof f === "object") mergeInto(factions, facSeen, { name: str((f as Entry).name), description: str((f as Entry).description) }, "name")
      }
      for (const t of Array.isArray(d.terms) ? d.terms : []) {
        if (t && typeof t === "object") mergeInto(terms, termSeen, { term: str((t as Entry).term), definition: str((t as Entry).definition) }, "term")
      }
      for (const k of Array.isArray(d.keywords) ? d.keywords : []) {
        const kw = str(k)
        if (kw && !kwSeen.has(normKey(kw)) && keywords.length < 60) {
          kwSeen.add(normKey(kw))
          keywords.push(kw)
        }
      }
    }

    if (chunksFailed === chunks.length) {
      return fail("llm_channel_failed", `LLM 通道全部 ${chunks.length} 塊失敗：${lastReason}`, { title: "抽取失敗" })
    }

    const empty = characters.length + locations.length + factions.length + terms.length + keywords.length === 0
    if (empty) {
      return fail("nothing_extracted", "LLM 有回應但未抽到任何要素，請檢查文本是否為敘事/設定內容", { title: "無抽取結果" })
    }

    return ok({
      title: `世界觀：${characters.length} 人物/${locations.length} 地理/${factions.length} 勢力/${terms.length} 術語/${keywords.length} 關鍵詞`,
      world_bible: { characters, locations, factions, terms, keywords },
      meta: {
        chunks_used: chunks.length,
        chunks_failed: chunksFailed,
        truncated,
        focus: args.focus || null,
        last_llm_reason: chunksFailed ? lastReason : null,
      },
    })
  },
})
