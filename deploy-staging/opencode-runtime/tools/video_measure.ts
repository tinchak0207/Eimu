import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { measureScript } from "../lib/measure"

// 台詞量測（薄包）：全部邏輯在 lib/measure.ts（純本機計算、零外部呼叫、零網路）；本檔只做參數轉譯。
// 算式逐條照抄競品 hypit（packages/estimate/src/program.ts ＋ policy.ts）。
export default tool({
  description:
    "台詞量測（寫作期）：把台詞文本折算成**秒數**，供你先把時長寫進劇本／分鏡再出片。**純本機計算、零外部呼叫**。" +
    "算式逐條照抄 hypit：units ÷ rate，padding 在 rounding 之前加入。units 定義：zh/ja 逐字（Han＋假名碼點）＋夾雜英文按逐詞音節；en 逐詞音節；es 逐詞音節。音節查 CMU 發音詞典（命中為詞典值，未命中為啟發式估算）。" +
    "PACE_RATE（units/秒）zh slow/normal/fast=4.2/5.25/6.5625、en=4.2/4.6/5.6、ja=6/7.5/9.375、es=4.72/5.9/7.375。" +
    "**預設照抄 hypit 表（zh normal 5.25 字/秒）**；要對齊我方短劇散文口徑（4.5 字/秒）時請傳 rate: 4.5。" +
    "必填：language（auto|en|zh|ja|es）、rounding（none|round|ceil），以及 pace 與 rate **恰有其一**（兩個同時給或都不給一律拒收）。" +
    "回傳 {duration_sec, units, units_per_sec, language, policy, note}；note 誠實標明詞典命中情況與口徑差異。",
  args: {
    text: tool.schema.string().describe("要量測的台詞原文（可整段對白或單句；標點會照常切詞）"),
    language: tool.schema
      .enum(["auto", "en", "zh", "ja", "es"])
      .optional()
      .describe("口徑語言；auto 會先偵測（假名 > max(Han, ascii/4) → ja；Han > ascii/4 → zh；西語詞/變音符 → es；否則 en）"),
    pace: tool.schema
      .enum(["slow", "normal", "fast"])
      .optional()
      .describe("語速檔位（與 rate 恰有其一）；各語言速率見 description"),
    rate: tool.schema
      .number()
      .positive()
      .optional()
      .describe("直接指定 units/秒（與 pace 恰有其一）；對齊我方短劇散文口徑請傳 4.5"),
    rounding: tool.schema
      .enum(["none", "round", "ceil"])
      .optional()
      .describe("秒數取整：none=保留原值 | round=四捨五入整秒 | ceil=向上取整整秒"),
    padding: tool.schema.number().min(0).optional().describe("額外留白秒數（表演呼吸位），預設 0"),
  },
  async execute(args) {
    const result = measureScript(args.text, {
      language: args.language,
      pace: args.pace,
      rate: args.rate,
      rounding: args.rounding,
      padding: args.padding,
    })
    if (!result.ok) {
      return fail(result.code ?? "measure_failed", result.reason ?? "量測失敗", {
        title: "量測失敗",
        units: result.units,
        units_per_sec: result.units_per_sec,
        policy: result.policy,
      })
    }
    return ok({
      ...result,
      title: `量測完成：${result.duration_sec}s（${result.units} 單位 @ ${result.units_per_sec}/s，${result.language}）`,
    })
  },
})
