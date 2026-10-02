import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

// 劇本結構化解析（2026-08-31 片1 實裝）：劇本原文 → 場次表 JSON。
// 純代碼正則解析（零扣費零 LLM）：場次標題（INT./EXT./第X場/場景N/【】/SCENE N/第X集）
// + 台詞行（角色名：/「」/（OS））+ 動作節拍；台詞時長按 4.5 字/秒折算。
// 契約對齊 src/lib/shortdrama-domain/index.ts:parseScript（scenes[{sceneId,heading,beats}]）。

const WORKSPACE = "/opt/agent-harness/workspace"
const CHARS_PER_SECOND = 4.5

const SCENE_RE =
  /^\s*(?:#{1,6}\s*)?(?:[〇零一二三四五六七八九十百\d]+\s*[、.．]\s*)?((?:(?:INT\.?|EXT\.?|内外景|内景|外景)\s*[.．]?\s*)?(?:第[〇零一二三四五六七八九十百千\d]+[场場][景次]?|场景[：:\s]*[〇零一二三四五六七八九十百千\d]+|場\s*[〇零一二三四五六七八九十百千\d]+|SCENE\s*\d+|EP(?:ISODE)?\s*\d+|第[〇零一二三四五六七八九十百千\d]+[集话話]|【[^】]{1,40}】))/i

const TRANSITION_RE = /^\s*(切至|转场|轉場|淡入|淡出|黑场|黑場|CUT\s*TO|FADE\s*(IN|OUT)|DISSOLVE)/i

const DIALOGUE_RE = /^\s*(?:(?:[（(\[]\s*)?(?:OS|VO|画外音|旁白|独白|獨白|O\.S\.|V\.O\.)(?:\s*[）)\]])?\s*)?([\u4e00-\u9fa5A-Za-z0-9·]{1,12}?)\s*(?:[（(][^）)]{0,20}[）)])?\s*[：:]\s*(.+)$/

const QUOTED_DIALOGUE_RE = /^\s*(?:[\u4e00-\u9fa5A-Za-z0-9·]{1,12}\s*[：:]\s*)?[「『]([^」』]{1,300})[」』]\s*$/

function speechSeconds(text: string): number {
  const spoken = text.replace(/[\s，。！？、；：「」『』“”‘’（）()《》〈〉…—\-·,.!?;:"']/g, "")
  return Math.max(0.1, Math.round((spoken.length / CHARS_PER_SECOND) * 10) / 10)
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
  return { reason: "script 與 path 至少填一個：script 直接給劇本原文，path 給 txt/md 檔案路徑" }
}

export default tool({
  description:
    "劇本結構化解析（純代碼，零扣費）。script 欄位填劇本原文，或 path 欄位填 txt/md 檔案路徑（絕對或 workspace 相對）。輸出場次表 JSON：scenes[{sceneId,heading,beats[{type:action|dialogue|transition,speaker?,text,duration_seconds?}]}]，台詞按 4.5 字/秒折算 duration_seconds，並給總時長統計。支援 INT./EXT./第X場/場景N/【】/SCENE N/第X集 等中英場次標題與「角色名：台詞」識別。短劇生產線第一步：拿到劇本先調本工具再排分鏡。禁止用 read+grep 現造輪子做同樣解析。",
  args: {
    script: tool.schema.string().optional().describe("劇本原文（與 path 二選一）"),
    path: tool.schema.string().optional().describe("劇本檔案路徑 txt/md（與 script 二選一）"),
  },
  async execute(args) {
    const resolved = resolveText(args.script, args.path)
    if (!resolved.text) return fail("empty_script", resolved.reason || "劇本為空", { title: "劇本為空" })

    const lines = resolved.text.split(/\r?\n/)
    interface Beat {
      type: "action" | "dialogue" | "transition"
      speaker?: string
      text: string
      duration_seconds?: number
    }
    interface Scene {
      sceneId: string
      heading: string
      beats: Beat[]
    }
    const scenes: Scene[] = []
    let current: Scene | null = null
    const warnings: string[] = []

    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      const sceneMatch = line.match(SCENE_RE)
      if (sceneMatch) {
        current = { sceneId: `S${scenes.length + 1}`, heading: line.slice(0, 120), beats: [] }
        scenes.push(current)
        continue
      }
      if (!current) {
        current = { sceneId: "S1", heading: "（未標註場次，全文歸入單一場）", beats: [] }
        scenes.push(current)
        warnings.push("未識別到任何場次標題，全文歸入單一場次")
      }
      if (TRANSITION_RE.test(line)) {
        current.beats.push({ type: "transition", text: line })
        continue
      }
      const dlg = line.match(DIALOGUE_RE)
      if (dlg && !SCENE_RE.test(line)) {
        const speaker = dlg[1].trim()
        const text = dlg[2].trim()
        current.beats.push({ type: "dialogue", speaker, text, duration_seconds: speechSeconds(text) })
        continue
      }
      const quoted = line.match(QUOTED_DIALOGUE_RE)
      if (quoted) {
        current.beats.push({
          type: "dialogue",
          speaker: "未標註",
          text: quoted[1],
          duration_seconds: speechSeconds(quoted[1]),
        })
        continue
      }
      current.beats.push({ type: "action", text: line })
    }

    if (scenes.length === 0 || scenes.every((s) => s.beats.length === 0)) {
      return fail("unparseable_script", "劇本有文字但解析不出任何節拍，請檢查格式", { title: "解析失敗" })
    }

    const dialogueBeats = scenes.flatMap((s) => s.beats.filter((b) => b.type === "dialogue"))
    const totalDialogueSeconds = Math.round(dialogueBeats.reduce((sum, b) => sum + (b.duration_seconds || 0), 0) * 10) / 10
    const emptyBeatScenes = scenes.filter((s) => s.beats.length === 0).map((s) => s.sceneId)
    if (emptyBeatScenes.length) warnings.push(`空場次：${emptyBeatScenes.join(", ")}`)

    return ok({
      title: `場次表：${scenes.length} 場`,
      scenes,
      summary: {
        scene_count: scenes.length,
        action_beats: scenes.flatMap((s) => s.beats).filter((b) => b.type === "action").length,
        dialogue_beats: dialogueBeats.length,
        transition_beats: scenes.flatMap((s) => s.beats).filter((b) => b.type === "transition").length,
        total_dialogue_seconds: totalDialogueSeconds,
        chars_per_second: CHARS_PER_SECOND,
      },
      warnings,
    })
  },
})
