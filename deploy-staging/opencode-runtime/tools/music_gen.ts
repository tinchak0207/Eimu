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
import { registerMusicGenTrack } from "../lib/music-lyric-register"
import { GATEWAY, ok as musicOk, fail as musicFail } from "../lib/music-tools-impl-core"

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

// ── 一次用户请求只交付 1 条音乐（2026-11-04）──────────────────────────────────
// 真会话证据（/tmp/human-e2e-2026-11-04T13-33-53-301Z）：「配一段 10 秒的轻音乐」被 orchestrator 三次重派子代理、
// 各自 music_gen（3 币、3 条 audio.done，第三次还自己要 10.575 秒）。提示词压不住，由网关在生成前裁决：
// 用户原话明确单量且本回合已交付过 → 复用那条（不生成不扣费）；另一席位正在生成 → 拒绝重复发起。
// fail-open：网关不可达/非预期回应一律放行（不因闸门坏了挡住合法生成）。probe／乐谱编辑／翻唱不受影响。
type SingleDeliveryVerdict = { result?: { title: string; output: string }; claimed: boolean }
async function checkSingleDelivery(args: Record<string, unknown>, context: any): Promise<SingleDeliveryVerdict> {
  const sid = typeof context?.sessionID === "string" ? context.sessionID : ""
  if (!sid || args?.probe === true || args?.probe === "true" || args?.abc || args?.source_audio) return { claimed: false }
  try {
    const resp = await fetch(`${GATEWAY}/internal/media/music-reuse?session_id=${encodeURIComponent(sid)}`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!resp.ok) return { claimed: false }
    const body: any = await resp.json().catch(() => null)
    if (!body || body.ok !== true) return { claimed: false }
    if (body.reuse && typeof body.reuse.url === "string" && body.reuse.url) {
      const d = typeof body.reuse.duration_s === "number" ? body.reuse.duration_s : undefined
      return {
        claimed: false,
        result: musicOk({
          title: "已复用本次请求的音乐成品",
          url: body.reuse.url,
          ...(d ? { duration_seconds: d } : {}),
          cost_coins: 0,
          reused: true,
          notes: ["用户这次只要 1 首：本次请求已经交付过一条音乐，直接复用它，没有重新生成，也没有再扣费。不要为了凑时长精度或换感觉再调 music_gen；把这条交给用户即可，需要别的版本让用户另开一句话再说。"],
        }),
      }
    }
    if (body.busy === true) {
      return {
        claimed: false,
        result: musicFail("music_single_delivery_busy", "本次请求的那 1 首音乐正由另一个席位生成中，不要重复发起 music_gen（会重复扣费）。等它交付后直接用它的成品。"),
      }
    }
    return { claimed: true }
  } catch {
    return { claimed: false }
  }
}

async function releaseSingleDeliveryClaim(context: any): Promise<void> {
  const sid = typeof context?.sessionID === "string" ? context.sessionID : ""
  if (!sid) return
  try {
    await fetch(`${GATEWAY}/internal/media/music-reuse?session_id=${encodeURIComponent(sid)}&release=1`, { signal: AbortSignal.timeout(3000) })
  } catch {
    /* best-effort：占位 6 分钟自动过期 */
  }
}

function resultIsOk(result: any): boolean {
  try {
    return typeof result?.output === "string" && JSON.parse(result.output)?.ok === true
  } catch {
    return false
  }
}

async function generateAndRegister(args: Record<string, unknown>, context: any) {
  const prompt = typeof args?.prompt === "string" ? args.prompt : ""
  // 不含 `@[` → 完全不呼叫站点（不多一个 RTT，行为与改动前逐位元相同）。
  if (!prompt.includes("@[")) {
    const result = await musicGenBase.execute(args, context)
    // 出曲即入库：成功回执后登记（fail-open，不改回执、不挡返回）。
    await registerMusicGenTrack(args, result)
    return result
  }
  const resolved = await resolveAudioEntityPrompt(prompt, context?.sessionID, context?.abort)
  const result = await musicGenBase.execute({ ...args, prompt: resolved.prompt }, context)
  // 出曲即入库：登记用**原始入参**（args.lyrics），不受 tag 展开影响。
  await registerMusicGenTrack(args, result)
  return withCardNote(result, resolved.note)
}

export default {
  ...musicGenBase,
  async execute(args: Record<string, unknown>, context: any) {
    const verdict = await checkSingleDelivery(args, context)
    if (verdict.result) return verdict.result
    let result: any
    try {
      result = await generateAndRegister(args, context)
      return result
    } finally {
      // 失败/抛错：释放占位，让重试不被自己的占位挡住（成功时占位由网关在 audio.done 落账时清）。
      if (verdict.claimed && !resultIsOk(result)) await releaseSingleDeliveryClaim(context)
    }
  },
}
