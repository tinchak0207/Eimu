import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { llmChatJson } from "../lib/llm-channel"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

// 世界观抽取（2026-08-31 片1 实装）：小说/设定文本 → 世界观 JSON。
// 文本分块 → 逐块调 LLM 抽取（通道绑定见 lib/llm-channel.ts，key 不落任何输出）
// → 合并去重 → schema 校验。LLM 失败诚实回 ok:false，不降级编造。

const WORKSPACE = "/opt/agent-harness/workspace"
const CHUNK_CHARS = 4500
const MAX_CHUNKS = 6

const SYSTEM = [
  "你是世界观设定抽取器。从给定的小说/设定文本块中抽取世界观要素。",
  "只输出一个 JSON 物件，不要任何解释、不要 markdown 栅栏。schema：",
  '{"characters":[{"name","role","description"}],"locations":[{"name","description"}],"factions":[{"name","description"}],"terms":[{"term","definition"}],"keywords":["string"]}',
  "规则：name/term 用文本原词；description 不超过 60 字且只写文本中有依据的内容，禁止编造；",
  "keywords 为可复用于生图 prompt 的视觉/风格词（服装、地貌、光线、色调、材质等），每块最多 12 个。",
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
    if (!existsSync(abs)) return { reason: `档案不存在：${abs}` }
    try {
      const text = readFileSync(abs, "utf8")
      if (!text.trim()) return { reason: `档案为空：${abs}` }
      return { text }
    } catch (e) {
      return { reason: `读档失败：${(e as Error).message}` }
    }
  }
  return { reason: "text 与 path 至少填一个：text 直接给小说文本，path 给 txt/md 档案路径" }
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
    "世界观抽取（LLM 语义任务，走 harness 文字通道，不产生任何图像/视频生成扣费）。text 填小说/设定文本原文，或 path 填 txt/md 路径；可选 focus 指定抽取侧重（如「只关注势力与法术体系」）。输出 world_bible JSON：characters/locations/factions/terms/keywords（可直接复用为生图 prompt 词库）。文本超长自动分块（最多 6 块，超出截断并老实标注）。短剧/小说可视化第一步：先抽世界观再锁角色场景卡。LLM 失败时回 ok:false 与原因，绝不编造。",
  args: {
    text: tool.schema.string().optional().describe("小说/设定文本原文（与 path 二选一）"),
    path: tool.schema.string().optional().describe("文本档案路径 txt/md（与 text 二选一）"),
    focus: tool.schema.string().optional().describe("可选：抽取侧重说明"),
  },
  async execute(args) {
    const resolved = resolveText(args.text, args.path)
    if (!resolved.text) return fail("empty_text", resolved.reason || "文本为空", { title: "文本为空" })

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
      const user = `${args.focus ? `抽取侧重：${args.focus}\n` : ""}文本块 ${i + 1}/${chunks.length}：\n${chunks[i]}`
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
      return fail("llm_channel_failed", `LLM 通道全部 ${chunks.length} 块失败：${lastReason}`, { title: "抽取失败" })
    }

    const empty = characters.length + locations.length + factions.length + terms.length + keywords.length === 0
    if (empty) {
      return fail("nothing_extracted", "LLM 有回应但未抽到任何要素，请检查文本是否为叙事/设定内容", { title: "无抽取结果" })
    }

    return ok({
      title: `世界观：${characters.length} 人物/${locations.length} 地理/${factions.length} 势力/${terms.length} 术语/${keywords.length} 关键词`,
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
