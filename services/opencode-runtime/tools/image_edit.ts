import { contentHash } from "../lib/image-journal"
import { tool } from "@opencode-ai/plugin/tool"
import {
  classifyError,
  confirmSpend,
  dedupHash,
  emitEvent,
  estimateEditCoins,
  platformFetch,
  probeModelAvailable,
  publicImageUrl,
  randomUUID,
  registerTask,
  resolveMediaId,
  ok,
  fail,
} from "../lib/client"

// 编辑能力后盾 = 站点 /v1/images/edits（2026-09-13 暴君裁定：多模型化，gpt-image-2
// 等在内）。站点现分两域：pixai bridge 域走原同步链；其余目录模型走 durable 控制面
// 改图管线（kind:"image_edit"、202 任务合同）。harness 不做白名单门禁——不可用模型
// 由站点回诚实 400（model_edit_unsupported/model_not_found），渠道事实源是
// supplier_capability（与调度器同源），不在这里另立一套。

/** pixai bridge 域（站点 resolveBridgeModel 同集合）：同步改图链。 */
const PIXAI_BRIDGE_MODELS = new Set([
  "pixai-tsubaki2",
  "pixai-haruka-v2",
  "pixai-reference-pro",
  "pixai-tsubaki-11",
  "pixai-hoshino-v2",
  "moonbeam",
  "diamond",
  "neverland",
  "whimsical",
  "hassaku",
])

export default tool({
  description:
    "图生图改图。支援改图的模型以平台目录 edit=true 为准（GET /v1/model-status），预设 gpt-image-2。除 pixai 系为同步（10-30s 直接回图）外，其余模型是「非同步」任务制：提交后回 task_id，完成时间不定（通常几十秒到几分钟；供给不可用会诚实失败并自动退款），harness 会自动续接结果并出图卡——提交后立即交还控制权，不要轮询。超过 0.1 币会先跳出扣费确认。",
  args: {
    project:tool.schema.string().describe("继承稳定项目；付费沿用现有授权，不另换预算作用域"),
    request_id:tool.schema.string().describe("稳定原请求ID，恢复不能另换ID"),
    project_budget_coins:tool.schema.number().min(0).optional().describe("项目累计上限约束，只能收紧已有上限；不是付费授权"),
    image_url: tool.schema
      .string()
      .describe("原图：http(s)/data URL 或本地绝对路径（聊天附件解析出的 uploads 路径直接可传）；media: 图片 ID 仅 pixai 系可用"),
    prompt: tool.schema.string().describe("改图提示词"),
    model: tool.schema
      .string()
      .optional()
      .describe("模型名，预设 gpt-image-2；支援编辑的模型以平台目录为准，不支持的会回诚实错误"),
    size: tool.schema.enum(["1k", "2k"]).optional().describe("尺寸等级 1k/2k，预设 1k"),
    quality: tool.schema.enum(["standard", "hd"]).optional().describe("standard 或 hd，预设 standard"),
  },
  async execute(args, context) {
    const model = args.model ?? "gpt-image-2"
    const request_id = args.request_id
    const estimate = await estimateEditCoins(model, context.sessionID, args.quality, context.abort)

    // ── 分支一：pixai bridge 域 = 原同步链（mediaId + 同步回图出卡）──
    if (PIXAI_BRIDGE_MODELS.has(model.toLowerCase())) {
      try {
        const image = await resolveMediaId(args.image_url, context.sessionID, context.abort)

        // 扣费闸门：单价取自平台目录；≤0.1 币属免确认的低价探索区间
        if (estimate > 0.1) {
          const approved = await confirmSpend(
            {
              sessionID: context.sessionID,
              amount_coins: estimate,
              description: `改图（${model}），预估花费 ${estimate} 币`,
              model,
              request_id,
            },
            context.abort,
          )
          if (!approved) {
            return fail("user_declined", "用户未确认扣费，已取消。可以改用更便宜的模型或减少张数再试。")
          }
        }

        const payload: any = { image, prompt: args.prompt, model, response_format: "url", workflow:{metadata:{project:args.project,request_id,project_budget_coins:args.project_budget_coins,input_signature:contentHash({...args,project_budget_coins:undefined})}} }
        if (args.size) payload.size = args.size === "2k" ? "2k" : "1k"
        if (args.quality) payload.quality = args.quality

        const resp = await platformFetch(
          "/images/edits",
          {
            method: "POST",
            headers: { "idempotency-key": request_id }, // PRD §152：重试不重复扣费
            body: JSON.stringify(payload),
          },
          context.sessionID,
          context.abort,
        )
        const body = await resp.json().catch(() => ({}))
        if (!resp.ok) {
          const err = await classifyError(resp, body)
          return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms, title: "改图失败" })
        }

        const url = body?.data?.[0]?.url || body?.result_url || body?.url
        const cost_coins = body?.cost_coins ?? body?.x_cost_coins ?? estimate
        // 同步回图，立即推前端图片卡；fire-and-forget，失败不影响 tool
        emitEvent(context.sessionID, "image.done", { url, cost_coins, task_id: request_id }, context.abort).catch(
          () => {},
        )
        return ok({ title: "改图完成", url, cost_coins })
      } catch (e: any) {
        const err = await classifyError(null, e)
        return fail(err.code, err.hint, { title: "改图失败" })
      }
    }

    // ── 分支二：durable 多模型改图（2026-09-13）= 任务制，同 image_generate 轮子 ──
    try {
      const image = await publicImageUrl(args.image_url, context.sessionID, context.abort)

      if (estimate > 0.1) {
        const approved = await confirmSpend(
          {
            sessionID: context.sessionID,
            amount_coins: estimate,
            description: `改图（${model}），预估花费 ${estimate} 币`,
            model,
            request_id,
          },
          context.abort,
        )
        if (!approved) {
          return fail("user_declined", "用户未确认扣费，已取消。可以改用更便宜的模型或减少张数再试。")
        }
      }

      const payload: any = { image, prompt: args.prompt, model, response_format: "url", workflow:{metadata:{project:args.project,request_id,project_budget_coins:args.project_budget_coins,input_signature:contentHash({...args,project_budget_coins:undefined})}} }
      if (args.size) payload.size = args.size === "2k" ? "2k" : "1k"
      if (args.quality) payload.quality = args.quality

      const resp = await platformFetch(
        "/images/edits",
        {
          method: "POST",
          headers: { "idempotency-key": request_id },
          body: JSON.stringify(payload),
        },
        context.sessionID,
        context.abort,
      )
      const data = await resp.json().catch(() => ({}))
      const task_id = data?.task_id ?? data?.id ?? null

      if (resp.status === 202 || (resp.ok && task_id)) {
        if (task_id) {
          // 注册给 poller 自动轮询续接（同 image_generate 轮子）；best-effort。
          const reg = await registerTask(task_id, context.sessionID, "image", context.abort, {
            dedup_hash: dedupHash({ model, prompt: args.prompt, image, size: args.size }),
            model, project:args.project,request_id,
            cost_coins: estimate,
          })
          if(!reg.durable)return fail("registration_pending","原任务已接受，登记仍待恢复；不得新生成。",{task_id,request_id,recoverable:true})
          return ok(
            {
              task_id,
              kind: "image_edit",
              model,
              estimated_cost_coins: estimate,
              note: "改图任务已提交。完成时间不定：通常几十秒到几分钟；若供给不可用会诚实失败并自动退款——对用户报耗时不要编造「高峰排队」，不要报精确秒数。harness 会自动续接结果并出图卡。不要轮询。回报 task_id 给用户时必须原样照抄完整 UUID（36 字符含连字符），严禁截断成前 8 位——短 id 在平台查不到任务。",
            },
            { poller_ok: reg.ok, poller_error: reg.error },
          )
        }
        return fail("bad_response", `平台回 202 但无 task_id（response=${JSON.stringify(data).slice(0, 200)}）`)
      }

      // 兼容：若站点日后恢复同步回图，直接出卡。
      if (resp.ok) {
        const url = data?.data?.[0]?.url || data?.result_url || data?.url
        if (url) {
          const cost_coins = data?.cost_coins ?? data?.x_cost_coins ?? estimate
          emitEvent(context.sessionID, "image.done", { url, cost_coins, task_id: request_id }, context.abort).catch(
            () => {},
          )
          return ok({ title: "改图完成", url, cost_coins, model })
        }
      }

      const err = await classifyError(resp, data)
      return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms, title: "改图失败" })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "改图失败" })
    }
  },
})
