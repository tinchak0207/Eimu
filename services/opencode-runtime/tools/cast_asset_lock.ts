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

// 角色资产锁定（2026-08-31 片2）：名单 → 每角色三视图锁定卡 + 元数据持久化。
// 诚实机制：seed 平台不可控（源码核实），以 seed:null + DNA 后缀锚定，不吹嘘种子锁定。

export default tool({
  description:
    "角色资产锁定：cast 填角色名单 JSON 阵列字串 [{name, appearance}]，每角色生成一张三视图锁定卡（正面/侧面/背面 turnaround），结果连 prompt/model/task_id/实际花费写入返回 metadata 供后续步骤（keyframe_render/story_sequence 等）引用。平台不支持 seed 锁定，seed 诚实标 null（见 seed_policy）。dry_run=true 只返回完整请求清单与报价、不提交零扣费。生图走与 image_generate 相同的站点计费链（总额 >0.1 币先跳出用户确认）。任一角色卡没生出来即回 ok:false（error.code＝失败原因，如 insufficient_quota＝用户帐户余额不足、非通路故障；部分成功为 partial_failed，已成功的卡仍在 characters[].url）。只有 characters[].status=succeeded 且有 url 才算通路可用，不得据失败结果宣称付费通路「可用/是活的」。",
  args: {
    cast: tool.schema
      .string()
      .describe('角色名单 JSON 阵列字串，如 [{"name":"小林","appearance":"20yo woman, short black bob, red hoodie, white sneakers"}]'),
    style_anchor: tool.schema.string().optional().describe("全局风格锚（附加到每个角色 prompt，保证全组同风格）"),
    model: tool.schema.string().optional().describe(`生成模型，默认 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048，默认 1024x1024"),
    dry_run: tool.schema.boolean().optional().describe("true=只构造并返回请求清单与报价，不提交生图、不扣费"),
  },
  async execute(args, context) {
    const parsed = parseJsonArray(args.cast, "cast")
    if (!parsed.ok) return fail("invalid_cast", parsed.hint, { title: "输入非法" })
    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = normalizeSize(args.size)
    const reqs: { tag: string; prompt: string; model: string; size: string; n: number }[] = []
    for (const c of parsed.value) {
      const name = String(c?.name ?? "").trim() || `char${reqs.length + 1}`
      const appearance = String(c?.appearance ?? "").trim()
      if (!appearance) return fail("missing_appearance", `角色 ${name} 缺 appearance 外观描述`, { title: "输入非法" })
      reqs.push({
        tag: name,
        prompt: `character turnaround reference sheet, "${name}": ${appearance}, shown in front view, side view and back view on one sheet, full body, neutral A-pose, plain white background, consistent lighting and scale${args.style_anchor ? ", " + args.style_anchor : ""}`,
        model,
        size,
        n: 1,
      })
    }
    if (args.dry_run) {
      return ok({ title: `cast_asset_lock dry_run：${reqs.length} 个角色`, ...(await planRequests(reqs, context.sessionID, context.abort)) })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `角色资产锁定：${reqs.length} 张三视图卡（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "批量生图失败", ...batch.detail })
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
    // R9-C（2026-09-30）：内部生图失败不得回绿灯。事故：yuri-op-mv SSE 7833 tool.result ok:true，
    // 实际两张卡皆 insufficient_quota。runGenBatch 的 error 形如 "<code>: <hint>"（提交期，classifyError）；
    // 轮询期失败没有 code，归为 generation_failed。
    if (done < characters.length) {
      const codes = [
        ...new Set(
          characters
            .filter((c) => c.status !== "succeeded")
            .map((c) => /^([a-z][a-z0-9_]*): /.exec(String(c.error ?? ""))?.[1] ?? "generation_failed"),
        ),
      ]
      const code = done > 0 ? "partial_failed" : codes.length === 1 ? codes[0] : "generation_failed"
      const firstErr = characters.find((c) => c.status !== "succeeded")?.error ?? "生成失败"
      return fail(
        code,
        `角色锁定：${done}/${characters.length} 成功，${characters.length - done} 张定妆卡没生出来（失败原因：${codes.join("、")}）。${firstErr}`,
        {
          title: `角色锁定：${done}/${characters.length} 成功`,
          failure_codes: codes,
          characters,
          total_cost_coins: batch.total_cost_coins,
          channel_verified: done > 0,
          note:
            done > 0
              ? "只有 status=succeeded 的角色卡可引用；失败的角色不得当作已锁定。"
              : "本次没有任何定妆卡生成成功，模型/付费通路的可用性未被验证，不得对用户宣称通路可用。insufficient_quota＝用户帐户余额不足（换模型无效），model_unavailable＝模型通路故障，两者不可混报。",
        },
      )
    }
    return ok(
      {
        title: `角色锁定：${done}/${characters.length} 成功`,
        characters,
        total_cost_coins: batch.total_cost_coins,
        seed_policy: SEED_NOTE,
        note: "characters[].url 即三视图锁定卡；后续步骤把该角色的 prompt（含外观描述）作为 DNA 后缀注入可复用本卡风格。",
      },
      { characters, total_cost_coins: batch.total_cost_coins, seed_policy: SEED_NOTE },
    )
  },
})
