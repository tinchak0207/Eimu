import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, resolveKey } from "../lib/client"

// TTS 走 gateway（loopback /agent/v1/tts），不是平台 API_BASE——
// 平台 /v1/* 没有 tts 端点（实测 404）。
const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description:
    "配音（TTS）：输入一句台词文本（中文），同步生成语音，返回音频 URL。用于剧本台词配音、旁白、单句 voiceover。\n\n【诚实纪律】上游 TTS 供应商当前不可用时，本工具会返回 tts_unavailable 错误——此时必须向用户如实说明「配音上游暂缺，无法生成音轨」，严禁编造音频链接或用文字冒充音频。上游恢复后本工具自动可用，无需换路。\n\n【成本】按字符计价（当前 0 币/字符，定价权威在 gateway pricing 模块，以工具返回的 cost_coins 为准）。",
  args: {
    text: tool.schema
      .string()
      .min(1)
      .max(2000)
      .describe("台词文本（中文），单句或短段落，≤2000 字符"),
    voice: tool.schema.string().optional().describe("音色名（可选，上游可用时生效）"),
  },
  async execute(args, context) {
    const key = await resolveKey(context.sessionID, context.abort)
    try {
      const resp = await fetch(`${GATEWAY}/agent/v1/tts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          text: args.text,
          ...(args.voice ? { voice: args.voice } : {}),
        }),
        signal: context.abort,
      })
      const data = (await resp.json().catch(() => ({}))) as {
        ok?: boolean
        url?: string
        chars?: number
        cost_coins?: number
        error?: { message?: string; code?: string }
      }
      if (resp.ok && data?.ok && data.url) {
        return ok({
          url: data.url,
          chars: data.chars ?? args.text.length,
          cost_coins: data.cost_coins ?? 0,
          note: "配音已生成，把 url 原样交给用户（可直接播放/下载）。",
        })
      }
      const hint =
        data?.error?.message ||
        `TTS 请求失败（HTTP ${resp.status}）。上游不可用时如实告知用户，勿编造音频链接。`
      return fail(data?.error?.code || `http_${resp.status}`, hint)
    } catch (e: any) {
      return fail("network_error", e?.message || "网络错误")
    }
  },
})
