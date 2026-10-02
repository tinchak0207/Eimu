import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { transcribe } from "../lib/asr"

// 詞級時間軸（薄包）：邏輯全在 lib/asr.ts，本檔只做參數驗證與錯誤碼轉譯。
// 客戶端只抽 16kHz mono WAV，推論由 loopback 的本機 ASR 服務（services/asr/）做，零上游零付費。
export default tool({
  description:
    "把一段影片或音訊轉成**詞級時間軸**：抽出 16kHz 單聲道語音後交給本機 ASR 服務，回傳**每個詞的 start/end 秒**" +
    "（passages[].words[{text,start_seconds?,end_seconds?,score?}]）＋ audio_seconds ＋ language ＋ word_count。" +
    "source 收本機絕對路徑（mp4/mov/mkv/mp3/wav/m4a…）或 http(s) URL（URL 走既有下載輪子，單檔 25MB 上限）。" +
    "language **必須是具體語言碼（en/zh/ja/ko…），不接受 auto/und**；若你給 auto，本工具會先用啟發式（假名/漢字/ASCII 比例）" +
    "解析成 en/zh/ja 並在 warnings 寫明（ASR 服務本身不收 auto）。max_seconds 超過時**明確拒絕**（code=too_long），不靜默截斷。" +
    "**不編造缺失時間**：模型沒給出的 start/end 一律保持 undefined，不會補值或插 tick。" +
    "未配置時回 {ok:false, error:{code}}，code ∈ asr_unavailable|asr_failed|no_audio|no_speech|too_long|invalid_language|not_16k_mono_wav（no_audio＝這支片根本沒有音軌，不是轉寫失敗）；" +
    "asr_unavailable 的 hint 附具體 prepare 指令（services/asr/prepare.sh），probed 列出探測過但不可用的通道。" +
    "這是量測事實（每詞落在幾秒），不是散文摘要；拿到 results 後可直接對齊字幕、切鏡與台詞逐字對帳。",
  args: {
    source: tool.schema
      .string()
      .describe("本機絕對路徑（如 /tmp/a.mp4）或 http(s) URL；影片會自動抽音（16kHz mono s16 WAV）"),
    language: tool.schema
      .string()
      .optional()
      .describe("具體語言碼（en/zh/ja/ko…，小寫 2-3 字母）；不接受 und。給 auto 會由啟發式解析並記 warning（預設 auto）"),
    max_seconds: tool.schema
      .number()
      .positive()
      .max(1800)
      .optional()
      .describe("音訊時長上限（秒）；超過即拒絕並回 code=too_long（不截斷）"),
  },
  async execute(args, context) {
    const result = await transcribe(args.source, {
      language: args.language ?? "auto",
      ...(args.max_seconds === undefined ? {} : { max_seconds: args.max_seconds }),
      signal: context.abort,
    })
    if (!result.ok) {
      return fail(result.code ?? "asr_failed", result.reason ?? "轉寫失敗", {
        // 沒有音軌不是故障：標題不要叫「失敗」，否則 agent 會把它當可用性問題去重試。
        title: result.code === "no_audio" ? "無音軌：本片沒有可轉寫的語音（不是轉寫失敗）" : "轉寫失敗",
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
      title: `轉寫完成：${result.word_count ?? 0} 詞 / ${result.audio_seconds ?? "?"}s（${result.language ?? "?"}）`,
    })
  },
})
