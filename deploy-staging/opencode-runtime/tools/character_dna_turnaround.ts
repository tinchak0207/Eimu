import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { llmChatJson } from "../lib/llm-channel"
import {
  ORCH_DEFAULT_MODEL,
  SEED_NOTE,
  normalizeSize,
  parseJsonObject,
  planRequests,
  runGenBatch,
} from "../lib/img-orchestrate"

// 单张排版概念图，不是分视角锁定。8 维外观文本拼进同一张图的提示词，只生一次。
// 这些文本供后续提示词拼接，不锁死正面/侧面/背面的一致性。seed 平台不可控，标 null。

const DNA_KEYS = ["hair", "face_shape", "body_type", "skin_tone", "outfit", "palette", "age_vibe", "signature"] as const

const DNA_SYSTEM =
  "你是角色设计助手。从角色设定提炼 8 维 DNA，只输出一个 JSON 物件，键固定为：hair（发型发色）、face_shape（脸型）、body_type（体型）、skin_tone（肤色）、outfit（服装）、palette（主色板，写具体颜色词）、age_vibe（年龄感）、signature（标志性物件/特征）。设定未提及的维度给与设定一致的合理值。值为简短英文短语（生图模型对英文响应最好）。"

export default tool({
  description:
    "单张排版概念图，不是分视角锁定。character_setting 填角色设定文字，一次只生成一张把正面、侧面、背面排在同一张上的概念图，并给出 8 维外观文本（发型/脸型/体型/肤色/服装/色板/年龄感/标志物）。这些文本只供后续提示词拼接，不锁死各视角一致性。dna 可直给 JSON，否则用 LLM 从设定补全。平台不支持 seed，seed 为 null。dry_run=true 只返回请求清单与报价，不提交生图（LLM 补全为内部通道不扣费，仍会执行以给完整 prompt）。",
  args: {
    character_setting: tool.schema.string().describe("角色设定文字（外貌/服装/气质等）"),
    dna: tool.schema
      .string()
      .optional()
      .describe(`可选：直给 8 维 DNA JSON 物件字串，键 ${DNA_KEYS.join("/")}`),
    model: tool.schema.string().optional().describe(`生成模型，默认 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回请求清单与报价，不提交生图"),
  },
  async execute(args, context) {
    const setting = args.character_setting.trim()
    if (!setting) return fail("missing_setting", "character_setting 不能为空", { title: "输入非法" })
    let dna: Record<string, unknown> | null = null
    let dnaSource: "user" | "llm" | "unavailable" = "user"
    if (args.dna) {
      const p = parseJsonObject(args.dna, "dna")
      if (!p.ok) return fail("invalid_dna", p.hint, { title: "输入非法" })
      dna = p.value
    } else {
      const r = await llmChatJson(DNA_SYSTEM, `角色设定：${setting}`, 3000)
      if (r.ok) {
        dna = {}
        for (const k of DNA_KEYS) dna[k] = String(r.data?.[k] ?? "")
      } else {
        dnaSource = "unavailable"
      }
    }
    const dnaSuffix = dna
      ? DNA_KEYS.filter((k) => String(dna![k] ?? "").trim()).map((k) => `${k}: ${String(dna![k]).trim()}`).join("; ")
      : ""
    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = normalizeSize(args.size)
    const prompt = `single character concept sheet, "${setting}", front view, side view and back view arranged on one sheet, full body, neutral pose, plain white background, layout only not a locked turnaround — ${dnaSuffix || "(外观描述补全不可用，仅凭设定)"}`
    const reqs = [{ tag: "turnaround", prompt, model, size, n: 1 }]
    if (args.dry_run) {
      return ok({
        title: "单张排版概念图 dry_run",
        dna,
        dna_source: dnaSource,
        ...(await planRequests(reqs, context.sessionID, context.abort)),
      })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `单张排版概念图（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "生图失败", ...batch.detail })
    const r0 = batch.results[0]
    return ok(
      {
        title: r0.status === "succeeded" ? "单张排版概念图完成" : "单张排版概念图失败",
        dna,
        dna_source: dnaSource,
        dna_suffix: dnaSuffix || null,
        prompt: r0.prompt,
        task_id: r0.task_id,
        status: r0.status,
        url: r0.url,
        seed: null,
        cost_coins: r0.cost_coins,
        ...(r0.error ? { error: r0.error } : {}),
        seed_policy: SEED_NOTE,
        note: "单张排版概念图，不是分视角锁定。dna_suffix 只是可拼进后续提示词的文本，不锁死三视图一致性。",
      },
      { dna, dna_suffix: dnaSuffix || null, url: r0.url, seed: null },
    )
  },
})
