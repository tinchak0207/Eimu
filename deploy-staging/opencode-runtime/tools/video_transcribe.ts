import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { transcribe } from "../lib/asr"

// 词级时间轴（薄包）：逻辑全在 lib/asr.ts，本档只做参数验证与错误码转译。
// 客户端只抽 16kHz mono WAV，推论由 loopback 的本机 ASR 服务（services/asr/）做，零上游零付费。
export default tool({
  description:
    "把一段影片或音讯转成**词级时间轴**：抽出 16kHz 单声道语音后交给本机 ASR 服务，回传**每个词的 start/end 秒**" +
    "（passages[].words[{text,start_seconds?,end_seconds?,score?}]）＋ audio_seconds ＋ language ＋ word_count。" +
    "source 收本机绝对路径（mp4/mov/mkv/mp3/wav/m4a…）或 http(s) URL（URL 走既有下载轮子，单档 25MB 上限）。" +
    "language **必须是具体语言码（en/zh/ja/ko…），不接受 auto/und**；若你给 auto，本工具会先用启发式（假名/汉字/ASCII 比例）" +
    "解析成 en/zh/ja 并在 warnings 写明（ASR 服务本身不收 auto）。max_seconds 超过时**明确拒绝**（code=too_long），不静默截断。" +
    "**不编造缺失时间**：模型没给出的 start/end 一律保持 undefined，不会补值或插 tick。" +
    "未配置时回 {ok:false, error:{code}}，code ∈ asr_unavailable|asr_failed|no_audio|no_speech|too_long|invalid_language|not_16k_mono_wav（no_audio＝这支片根本没有音轨，不是转写失败）；" +
    "asr_unavailable 的 hint 附具体 prepare 指令（services/asr/prepare.sh），probed 列出探测过但不可用的通道。" +
    "这是量测事实（每词落在几秒），不是散文摘要；拿到 results 后可直接对齐字幕、切镜与台词逐字对帐。",
  args: {
    source: tool.schema
      .string()
      .describe("本机绝对路径（如 /tmp/a.mp4）或 http(s) URL；影片会自动抽音（16kHz mono s16 WAV）"),
    language: tool.schema
      .string()
      .optional()
      .describe("具体语言码（en/zh/ja/ko…，小写 2-3 字母）；不接受 und。给 auto 会由启发式解析并记 warning（预设 auto）"),
    max_seconds: tool.schema
      .number()
      .positive()
      .max(1800)
      .optional()
      .describe("音讯时长上限（秒）；超过即拒绝并回 code=too_long（不截断）"),
  },
  async execute(args, context) {
    const result = await transcribe(args.source, {
      language: args.language ?? "auto",
      ...(args.max_seconds === undefined ? {} : { max_seconds: args.max_seconds }),
      signal: context.abort,
    })
    if (!result.ok) {
      return fail(result.code ?? "asr_failed", result.reason ?? "转写失败", {
        // 没有音轨不是故障：标题不要叫「失败」，否则 agent 会把它当可用性问题去重试。
        title: result.code === "no_audio" ? "无音轨：本片没有可转写的语音（不是转写失败）" : "转写失败",
        language: result.language,
        audio_seconds: result.audio_seconds,
        probed: result.probed ?? [],
        warnings: result.warnings ?? [],
        provider: result.provider,
        model: result.model,
      })
    }
    return ok({
      ...result,
      title: `转写完成：${result.word_count ?? 0} 词 / ${result.audio_seconds ?? "?"}s（${result.language ?? "?"}）`,
    })
  },
})
