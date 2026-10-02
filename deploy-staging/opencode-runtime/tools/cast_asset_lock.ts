import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import {
  ORCH_DEFAULT_MODEL,
  SEED_NOTE,
  normalizeSize,
  parseJsonArray,
  planRequests,
  runGenBatch,
} from "../lib/img-orchestrate"

// 角色資產鎖定（2026-08-31 片2）：名單 → 每角色三視圖鎖定卡 + 元數據持久化。
// 誠實機制：seed 平台不可控（源碼核實），以 seed:null + DNA 後綴錨定，不吹噓種子鎖定。

export default tool({
  description:
    "角色資產鎖定：cast 填角色名單 JSON 陣列字串 [{name, appearance}]，每角色生成一張三視圖鎖定卡（正面/側面/背面 turnaround），結果連 prompt/model/task_id/實際花費寫入返回 metadata 供後續步驟（keyframe_render/story_sequence 等）引用。平台不支持 seed 鎖定，seed 誠實標 null（見 seed_policy）。dry_run=true 只返回完整請求清單與報價、不提交零扣費。生圖走與 image_generate 相同的站點計費鏈（總額 >0.1 幣先跳出用戶確認）。任一角色卡沒生出來即回 ok:false（error.code＝失敗原因，如 insufficient_quota＝用戶帳戶餘額不足、非通路故障；部分成功為 partial_failed，已成功的卡仍在 characters[].url）。只有 characters[].status=succeeded 且有 url 才算通路可用，不得據失敗結果宣稱付費通路「可用/是活的」。",
  args: {
    cast: tool.schema
      .string()
      .describe('角色名單 JSON 陣列字串，如 [{"name":"小林","appearance":"20yo woman, short black bob, red hoodie, white sneakers"}]'),
    style_anchor: tool.schema.string().optional().describe("全局風格錨（附加到每個角色 prompt，保證全組同風格）"),
    model: tool.schema.string().optional().describe(`生成模型，默認 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048，默認 1024x1024"),
    dry_run: tool.schema.boolean().optional().describe("true=只構造並返回請求清單與報價，不提交生圖、不扣費"),
  },
  async execute(args, context) {
    const parsed = parseJsonArray(args.cast, "cast")
    if (!parsed.ok) return fail("invalid_cast", parsed.hint, { title: "輸入非法" })
    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = normalizeSize(args.size)
    const reqs: { tag: string; prompt: string; model: string; size: string; n: number }[] = []
    for (const c of parsed.value) {
      const name = String(c?.name ?? "").trim() || `char${reqs.length + 1}`
      const appearance = String(c?.appearance ?? "").trim()
      if (!appearance) return fail("missing_appearance", `角色 ${name} 缺 appearance 外觀描述`, { title: "輸入非法" })
      reqs.push({
        tag: name,
        prompt: `character turnaround reference sheet, "${name}": ${appearance}, shown in front view, side view and back view on one sheet, full body, neutral A-pose, plain white background, consistent lighting and scale${args.style_anchor ? ", " + args.style_anchor : ""}`,
        model,
        size,
        n: 1,
      })
    }
    if (args.dry_run) {
      return ok({ title: `cast_asset_lock dry_run：${reqs.length} 個角色`, ...(await planRequests(reqs, context.sessionID, context.abort)) })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `角色資產鎖定：${reqs.length} 张三视图卡（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "批量生圖失敗", ...batch.detail })
    const characters = batch.results.map((r) => ({
      name: r.tag,
      prompt: r.prompt,
      model: r.model,
      size: r.size,
      task_id: r.task_id,
      status: r.status,
      url: r.url,
      urls: r.urls,
      seed: null,
      cost_coins: r.cost_coins,
      ...(r.error ? { error: r.error } : {}),
    }))
    const done = characters.filter((c) => c.status === "succeeded").length
    // R9-C（2026-09-30）：內部生圖失敗不得回綠燈。事故：yuri-op-mv SSE 7833 tool.result ok:true，
    // 實際兩張卡皆 insufficient_quota。runGenBatch 的 error 形如 "<code>: <hint>"（提交期，classifyError）；
    // 輪詢期失敗沒有 code，歸為 generation_failed。
    if (done < characters.length) {
      const codes = [
        ...new Set(
          characters
            .filter((c) => c.status !== "succeeded")
            .map((c) => /^([a-z][a-z0-9_]*): /.exec(String(c.error ?? ""))?.[1] ?? "generation_failed"),
        ),
      ]
      const code = done > 0 ? "partial_failed" : codes.length === 1 ? codes[0] : "generation_failed"
      const firstErr = characters.find((c) => c.status !== "succeeded")?.error ?? "生成失敗"
      return fail(
        code,
        `角色鎖定：${done}/${characters.length} 成功，${characters.length - done} 張定妝卡沒生出來（失敗原因：${codes.join("、")}）。${firstErr}`,
        {
          title: `角色鎖定：${done}/${characters.length} 成功`,
          failure_codes: codes,
          characters,
          total_cost_coins: batch.total_cost_coins,
          channel_verified: done > 0,
          note:
            done > 0
              ? "只有 status=succeeded 的角色卡可引用；失敗的角色不得當作已鎖定。"
              : "本次沒有任何定妝卡生成成功，模型/付費通路的可用性未被驗證，不得對用戶宣稱通路可用。insufficient_quota＝用戶帳戶餘額不足（換模型無效），model_unavailable＝模型通路故障，兩者不可混報。",
        },
      )
    }
    return ok(
      {
        title: `角色鎖定：${done}/${characters.length} 成功`,
        characters,
        total_cost_coins: batch.total_cost_coins,
        seed_policy: SEED_NOTE,
        note: "characters[].url 即三視圖鎖定卡；後續步驟把該角色的 prompt（含外觀描述）作為 DNA 後綴注入可複用本卡風格。",
      },
      { characters, total_cost_coins: batch.total_cost_coins, seed_policy: SEED_NOTE },
    )
  },
})
