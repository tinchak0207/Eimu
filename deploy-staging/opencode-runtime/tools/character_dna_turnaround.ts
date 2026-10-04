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

// 角色 DNA 三视图（2026-08-31 片2）：8 维 DNA（发型/脸型/体型/肤色/服装/色板/年龄感/标志物）
// 由输入解析或 LLM 补全 → 拼固定后缀模板 → 生三视图。诚实：DNA 是结构化一致性锚点
// （把特征写进每个 prompt），非魔法编码；seed 平台不可控标 null。

const DNA_KEYS = ["hair", "face_shape", "body_type", "skin_tone", "outfit", "palette", "age_vibe", "signature"] as const

const DNA_SYSTEM =
  "你是角色设计助手。从角色设定提炼 8 维 DNA，只输出一个 JSON 物件，键固定为：hair（发型发色）、face_shape（脸型）、body_type（体型）、skin_tone（肤色）、outfit（服装）、palette（主色板，写具体颜色词）、age_vibe（年龄感）、signature（标志性物件/特征）。设定未提及的维度给与设定一致的合理值。值为简短英文短语（生图模型对英文响应最好）。"

export default tool({
  description:
    "角色 DNA 三视图：character_setting 填角色设定文字，输出三视图（正面/侧面/背面）+ 8 维 DNA 签名（发型/脸型/体型/肤色/服装/色板/年龄感/标志物）。DNA 可由 dna 参数（JSON 物件字串）直给，否则用 LLM 从设定补全；DNA 表与后缀进 metadata 供后续步骤引用。诚实声明：DNA 是结构化一致性锚点（把 8 维特征固定写入每个 prompt 后缀），不是魔法编码；平台不支持 seed，seed 标 null。dry_run=true 只返回请求清单与报价，不提交生图（LLM 补全 DNA 为内部通道不扣费，仍会执行以给完整 prompt）。",
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
    const prompt = `character turnaround sheet, "${setting}", shown in front view, side view and back view on one sheet, full body, neutral pose, plain white background, character DNA lock — ${dnaSuffix || "(DNA 补全不可用，仅凭设定)"}`
    const reqs = [{ tag: "turnaround", prompt, model, size, n: 1 }]
    if (args.dry_run) {
      return ok({
        title: "character_dna_turnaround dry_run",
        dna,
        dna_source: dnaSource,
        ...(await planRequests(reqs, context.sessionID, context.abort)),
      })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `角色 DNA 三视图（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "生图失败", ...batch.detail })
    const r0 = batch.results[0]
    return ok(
      {
        title: r0.status === "succeeded" ? "DNA 三视图完成" : "DNA 三视图失败",
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
        note: "dna/dna_suffix 即一致性锚点：后续任何步骤把 dna_suffix 原样附加到 prompt 尾部即可复用本角色。",
      },
      { dna, dna_suffix: dnaSuffix || null, url: r0.url, seed: null },
    )
  },
})
