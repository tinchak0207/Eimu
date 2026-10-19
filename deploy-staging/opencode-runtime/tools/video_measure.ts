import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { measureScript } from "../lib/measure"

// 台词量测（薄包）：全部逻辑在 lib/measure.ts（纯本机计算、零外部呼叫、零网路）；本档只做参数转译。
// 算式逐条照抄竞品 hypit（packages/estimate/src/program.ts ＋ policy.ts）。
export default tool({
  description:
    "台词量测（写作期）：把台词文本折算成**秒数**，供你先把时长写进剧本／分镜再出片。**纯本机计算、零外部呼叫**。" +
    "算式逐条照抄 hypit：units ÷ rate，padding 在 rounding 之前加入。units 定义：zh/ja 逐字（Han＋假名码点）＋夹杂英文按逐词音节；en 逐词音节；es 逐词音节。音节查 CMU 发音词典（命中为词典值，未命中为启发式估算）。" +
    "PACE_RATE（units/秒）zh slow/normal/fast=4.2/5.25/6.5625、en=4.2/4.6/5.6、ja=6/7.5/9.375、es=4.72/5.9/7.375。" +
    "**预设照抄 hypit 表（zh normal 5.25 字/秒）**；要对齐我方短剧散文口径（4.5 字/秒）时请传 rate: 4.5。" +
    "必填：language（auto|en|zh|ja|es）、rounding（none|round|ceil），以及 pace 与 rate **恰有其一**（两个同时给或都不给一律拒收）。" +
    "回传 {duration_sec, units, units_per_sec, language, policy, note}；note 诚实标明词典命中情况与口径差异。",
  args: {
    text: tool.schema.string().describe("要量测的台词原文（可整段对白或单句；标点会照常切词）"),
    language: tool.schema
      .enum(["auto", "en", "zh", "ja", "es"])
      .optional()
      .describe("口径语言；auto 会先侦测（假名 > max(Han, ascii/4) → ja；Han > ascii/4 → zh；西语词/变音符 → es；否则 en）"),
    pace: tool.schema
      .enum(["slow", "normal", "fast"])
      .optional()
      .describe("语速档位（与 rate 恰有其一）；各语言速率见 description"),
    rate: tool.schema
      .number()
      .positive()
      .optional()
      .describe("直接指定 units/秒（与 pace 恰有其一）；对齐我方短剧散文口径请传 4.5"),
    rounding: tool.schema
      .enum(["none", "round", "ceil"])
      .optional()
      .describe("秒数取整：none=保留原值 | round=四舍五入整秒 | ceil=向上取整整秒"),
    padding: tool.schema.number().min(0).optional().describe("额外留白秒数（表演呼吸位），预设 0"),
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
      return fail(result.code ?? "measure_failed", result.reason ?? "量测失败", {
        title: "量测失败",
        units: result.units,
        units_per_sec: result.units_per_sec,
        policy: result.policy,
      })
    }
    return ok({
      ...result,
      title: `量测完成：${result.duration_sec}s（${result.units} 单位 @ ${result.units_per_sec}/s，${result.language}）`,
    })
  },
})
