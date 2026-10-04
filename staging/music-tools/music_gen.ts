// music_gen 工具（音频卡行内引用接线，2026-09-25）。
//
// 背景：`@[音频:夜雨环境音]` 这种行内实体 tag 过去在音频链路上**零展开**——音频卡只是型别层
// 能力，token 会以字面串送进上游（被念出来／被当风格描述）。
//
// 形状轮子 = tools/image_generate.ts 的 `resolveCharacterTags`：同一支 `siteFetch`、同一个端点
// `/api/biz/character-resolve`，差别只有 `target: "audio"`（站点只让音频卡参与、参考图一律回空）。
// 音频链路没有参考图语义，故本工具**不传** reference_images（那些是 base64 分镜图，端点契约只吃 URL）。
// 工具端只用 `prompt.includes("@[")` 判断，**不自己写 token regex**（解析是站点的事）。
//
// 失败政策（**fail-open**）：解析失败／逾时／形状不符 → 用原文照常送，并在回执带一行提示。
// 理由＝本轮硬契约「解析失败永不得阻断音频生成」（与 image_generate 的 fail-closed 不同：
// 生图端把原始 token 送模型会生出废图，音频端宁可照原样念也不要整条生成被挡）。
import { wrapMusicTool, musicGenTool } from "../lib/music-tools-adapter"
import { siteFetch } from "../lib/client"

/** `@[` 出现次数（只数标记，不做语法解析）。 */
function markerCount(text: string): number {
  return text.split("@[").length - 1
}

interface AudioResolveOutcome {
  prompt: string
  /** 给回执的人话提示；无事发生时空字串。 */
  note: string
}

/** 送上游前把 `@[音频:名称]` 就地展开（站点 target:"audio"）。fail-open：任何失败回原文。 */
async function resolveAudioEntityPrompt(
  prompt: string,
  sessionID: string,
  signal?: AbortSignal,
): Promise<AudioResolveOutcome> {
  if (!prompt.includes("@[")) return { prompt, note: "" }
  try {
    const resp = await siteFetch(
      "/api/biz/character-resolve",
      { method: "POST", body: JSON.stringify({ prompt, target: "audio" }) },
      sessionID,
      signal,
    )
    if (!resp.ok) {
      console.warn(`[music_gen] 音频卡 tag 解析失败（HTTP ${resp.status}），改用原文送出；prompt_length=${prompt.length}`)
      return { prompt, note: `【音频卡 tag】解析失败（HTTP ${resp.status}），已按原文送出。` }
    }
    const body: any = await resp.json().catch(() => null)
    if (!body || typeof body !== "object" || typeof body.prompt !== "string" || !body.prompt.trim()) {
      console.warn(`[music_gen] 音频卡 tag 回应形状不符，改用原文送出；prompt_length=${prompt.length}`)
      return { prompt, note: "【音频卡 tag】解析回应形状不符，已按原文送出。" }
    }
    const warnings = Array.isArray(body.warnings)
      ? body.warnings.filter((w: unknown): w is string => typeof w === "string" && !!w.trim())
      : []
    const resolved: string = body.prompt
    const parts = [`【音频卡 tag】提示词 ${prompt.length}→${resolved.length} 字，剩余未解析引用 ${markerCount(resolved)} 处`]
    if (warnings.length > 0) parts.push(warnings.join("；"))
    return { prompt: resolved, note: parts.join("；") }
  } catch (e: any) {
    console.warn(`[music_gen] 音频卡 tag 解析抛错（${e?.name || "error"}），改用原文送出；prompt_length=${prompt.length}`)
    return { prompt, note: "【音频卡 tag】解析请求抛错，已按原文送出。" }
  }
}

/** 把提示并进工具回执（成功与失败都并，让 agent 与人都看得见展开真的发生了）。 */
function withCardNote(result: any, note: string): any {
  if (!note || !result || typeof result.output !== "string") return result
  try {
    const parsed = JSON.parse(result.output)
    if (!parsed || typeof parsed !== "object") return result
    parsed.card_note = note
    return { ...result, output: JSON.stringify(parsed) }
  } catch {
    return result
  }
}

const musicGenBase = wrapMusicTool(musicGenTool)

export default {
  ...musicGenBase,
  async execute(args: Record<string, unknown>, context: any) {
    const prompt = typeof args?.prompt === "string" ? args.prompt : ""
    // 不含 `@[` → 完全不呼叫站点（不多一个 RTT，行为与改动前逐位元相同）。
    if (!prompt.includes("@[")) return musicGenBase.execute(args, context)
    const resolved = await resolveAudioEntityPrompt(prompt, context?.sessionID, context?.abort)
    const result = await musicGenBase.execute({ ...args, prompt: resolved.prompt }, context)
    return withCardNote(result, resolved.note)
  },
}
