// music_gen 工具（音頻卡行內引用接線，2026-09-25）。
//
// 背景：`@[音频:夜雨环境音]` 這種行內實體 tag 過去在音頻鏈路上**零展開**——音頻卡只是型別層
// 能力，token 會以字面串送進上游（被念出來／被當風格描述）。
//
// 形狀輪子 = tools/image_generate.ts 的 `resolveCharacterTags`：同一支 `siteFetch`、同一個端點
// `/api/biz/character-resolve`，差別只有 `target: "audio"`（站點只讓音頻卡參與、參考圖一律回空）。
// 音頻鏈路沒有參考圖語義，故本工具**不傳** reference_images（那些是 base64 分鏡圖，端點契約只吃 URL）。
// 工具端只用 `prompt.includes("@[")` 判斷，**不自己寫 token regex**（解析是站點的事）。
//
// 失敗政策（**fail-open**）：解析失敗／逾時／形狀不符 → 用原文照常送，並在回執帶一行提示。
// 理由＝本輪硬契約「解析失敗永不得阻斷音頻生成」（與 image_generate 的 fail-closed 不同：
// 生圖端把原始 token 送模型會生出廢圖，音頻端寧可照原樣念也不要整條生成被擋）。
import { wrapMusicTool, musicGenTool } from "../lib/music-tools-adapter"
import { siteFetch } from "../lib/client"

/** `@[` 出現次數（只數標記，不做語法解析）。 */
function markerCount(text: string): number {
  return text.split("@[").length - 1
}

interface AudioResolveOutcome {
  prompt: string
  /** 給回執的人話提示；無事發生時空字串。 */
  note: string
}

/** 送上游前把 `@[音频:名称]` 就地展開（站點 target:"audio"）。fail-open：任何失敗回原文。 */
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

/** 把提示併進工具回執（成功與失敗都併，讓 agent 與人都看得見展開真的發生了）。 */
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
    // 不含 `@[` → 完全不呼叫站點（不多一個 RTT，行為與改動前逐位元相同）。
    if (!prompt.includes("@[")) return musicGenBase.execute(args, context)
    const resolved = await resolveAudioEntityPrompt(prompt, context?.sessionID, context?.abort)
    const result = await musicGenBase.execute({ ...args, prompt: resolved.prompt }, context)
    return withCardNote(result, resolved.note)
  },
}
