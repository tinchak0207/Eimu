import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

// 剧本结构化解析（2026-08-31 片1 实装）：剧本原文 → 场次表 JSON。
// 纯代码正则解析（零扣费零 LLM）：场次标题（INT./EXT./第X场/场景N/【】/SCENE N/第X集）
// + 台词行（角色名：/「」/（OS））+ 动作节拍；台词时长按 4.5 字/秒折算。
// 契约对齐 src/lib/shortdrama-domain/index.ts:parseScript（scenes[{sceneId,heading,beats}]）。

const WORKSPACE = "/opt/agent-harness/workspace"
const CHARS_PER_SECOND = 4.5

const SCENE_RE =
  /^\s*(?:#{1,6}\s*)?(?:[〇零一二三四五六七八九十百\d]+\s*[、.．]\s*)?((?:(?:INT\.?|EXT\.?|内外景|内景|外景)\s*[.．]?\s*)?(?:第[〇零一二三四五六七八九十百千\d]+[场场][景次]?|场景[：:\s]*[〇零一二三四五六七八九十百千\d]+|场\s*[〇零一二三四五六七八九十百千\d]+|SCENE\s*\d+|EP(?:ISODE)?\s*\d+|第[〇零一二三四五六七八九十百千\d]+[集话话]|【[^】]{1,40}】))/i

const TRANSITION_RE = /^\s*(切至|转场|转场|淡入|淡出|黑场|黑场|CUT\s*TO|FADE\s*(IN|OUT)|DISSOLVE)/i

const DIALOGUE_RE = /^\s*(?:(?:[（(\[]\s*)?(?:OS|VO|画外音|旁白|独白|独白|O\.S\.|V\.O\.)(?:\s*[）)\]])?\s*)?([\u4e00-\u9fa5A-Za-z0-9·]{1,12}?)\s*(?:[（(][^）)]{0,20}[）)])?\s*[：:]\s*(.+)$/

const QUOTED_DIALOGUE_RE = /^\s*(?:[\u4e00-\u9fa5A-Za-z0-9·]{1,12}\s*[：:]\s*)?[「『]([^」』]{1,300})[」』]\s*$/

function speechSeconds(text: string): number {
  const spoken = text.replace(/[\s，。！？、；：「」『』“”‘’（）()《》〈〉…—\-·,.!?;:"']/g, "")
  return Math.max(0.1, Math.round((spoken.length / CHARS_PER_SECOND) * 10) / 10)
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
  return { reason: "script 与 path 至少填一个：script 直接给剧本原文，path 给 txt/md 档案路径" }
}

export default tool({
  description:
    "剧本结构化解析（纯代码，零扣费）。script 栏位填剧本原文，或 path 栏位填 txt/md 档案路径（绝对或 workspace 相对）。输出场次表 JSON：scenes[{sceneId,heading,beats[{type:action|dialogue|transition,speaker?,text,duration_seconds?}]}]，台词按 4.5 字/秒折算 duration_seconds，并给总时长统计。支援 INT./EXT./第X场/场景N/【】/SCENE N/第X集 等中英场次标题与「角色名：台词」识别。短剧生产线第一步：拿到剧本先调本工具再排分镜。禁止用 read+grep 现造轮子做同样解析。",
  args: {
    script: tool.schema.string().optional().describe("剧本原文（与 path 二选一）"),
    path: tool.schema.string().optional().describe("剧本档案路径 txt/md（与 script 二选一）"),
  },
  async execute(args) {
    const resolved = resolveText(args.script, args.path)
    if (!resolved.text) return fail("empty_script", resolved.reason || "剧本为空", { title: "剧本为空" })

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
        current = { sceneId: "S1", heading: "（未标注场次，全文归入单一场）", beats: [] }
        scenes.push(current)
        warnings.push("未识别到任何场次标题，全文归入单一场次")
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
          speaker: "未标注",
          text: quoted[1],
          duration_seconds: speechSeconds(quoted[1]),
        })
        continue
      }
      current.beats.push({ type: "action", text: line })
    }

    if (scenes.length === 0 || scenes.every((s) => s.beats.length === 0)) {
      return fail("unparseable_script", "剧本有文字但解析不出任何节拍，请检查格式", { title: "解析失败" })
    }

    const dialogueBeats = scenes.flatMap((s) => s.beats.filter((b) => b.type === "dialogue"))
    const totalDialogueSeconds = Math.round(dialogueBeats.reduce((sum, b) => sum + (b.duration_seconds || 0), 0) * 10) / 10
    const emptyBeatScenes = scenes.filter((s) => s.beats.length === 0).map((s) => s.sceneId)
    if (emptyBeatScenes.length) warnings.push(`空场次：${emptyBeatScenes.join(", ")}`)

    return ok({
      title: `场次表：${scenes.length} 场`,
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
