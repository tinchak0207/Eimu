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

// 角色 DNA 三視圖（2026-08-31 片2）：8 維 DNA（髮型/臉型/體型/膚色/服裝/色板/年齡感/標誌物）
// 由輸入解析或 LLM 補全 → 拼固定後綴模板 → 生三視圖。誠實：DNA 是結構化一致性錨點
// （把特徵寫進每個 prompt），非魔法編碼；seed 平台不可控標 null。

const DNA_KEYS = ["hair", "face_shape", "body_type", "skin_tone", "outfit", "palette", "age_vibe", "signature"] as const

const DNA_SYSTEM =
  "你是角色設計助手。從角色設定提煉 8 維 DNA，只輸出一個 JSON 物件，鍵固定為：hair（髮型髮色）、face_shape（臉型）、body_type（體型）、skin_tone（膚色）、outfit（服裝）、palette（主色板，寫具體顏色詞）、age_vibe（年齡感）、signature（標誌性物件/特徵）。設定未提及的維度給與設定一致的合理值。值為簡短英文短語（生圖模型對英文響應最好）。"

export default tool({
  description:
    "角色 DNA 三視圖：character_setting 填角色設定文字，輸出三視圖（正面/側面/背面）+ 8 維 DNA 簽名（髮型/臉型/體型/膚色/服裝/色板/年齡感/標誌物）。DNA 可由 dna 參數（JSON 物件字串）直給，否則用 LLM 從設定補全；DNA 表與後綴進 metadata 供後續步驟引用。誠實聲明：DNA 是結構化一致性錨點（把 8 維特徵固定寫入每個 prompt 後綴），不是魔法編碼；平台不支持 seed，seed 標 null。dry_run=true 只返回請求清單與報價，不提交生圖（LLM 補全 DNA 為內部通道不扣費，仍會執行以給完整 prompt）。",
  args: {
    character_setting: tool.schema.string().describe("角色設定文字（外貌/服裝/氣質等）"),
    dna: tool.schema
      .string()
      .optional()
      .describe(`可選：直給 8 維 DNA JSON 物件字串，鍵 ${DNA_KEYS.join("/")}`),
    model: tool.schema.string().optional().describe(`生成模型，默認 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回請求清單與報價，不提交生圖"),
  },
  async execute(args, context) {
    const setting = args.character_setting.trim()
    if (!setting) return fail("missing_setting", "character_setting 不能為空", { title: "輸入非法" })
    let dna: Record<string, unknown> | null = null
    let dnaSource: "user" | "llm" | "unavailable" = "user"
    if (args.dna) {
      const p = parseJsonObject(args.dna, "dna")
      if (!p.ok) return fail("invalid_dna", p.hint, { title: "輸入非法" })
      dna = p.value
    } else {
      const r = await llmChatJson(DNA_SYSTEM, `角色設定：${setting}`, 3000)
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
    const prompt = `character turnaround sheet, "${setting}", shown in front view, side view and back view on one sheet, full body, neutral pose, plain white background, character DNA lock — ${dnaSuffix || "(DNA 補全不可用，僅憑設定)"}`
    const reqs = [{ tag: "turnaround", prompt, model, size, n: 1 }]
    if (args.dry_run) {
      return ok({
        title: "character_dna_turnaround dry_run",
        dna,
        dna_source: dnaSource,
        ...(await planRequests(reqs, context.sessionID, context.abort)),
      })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `角色 DNA 三視圖（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "生圖失敗", ...batch.detail })
    const r0 = batch.results[0]
    return ok(
      {
        title: r0.status === "succeeded" ? "DNA 三視圖完成" : "DNA 三視圖失敗",
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
        note: "dna/dna_suffix 即一致性錨點：後續任何步驟把 dna_suffix 原樣附加到 prompt 尾部即可複用本角色。",
      },
      { dna, dna_suffix: dnaSuffix || null, url: r0.url, seed: null },
    )
  },
})
