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

// 編輯能力後盾 = 站點 /v1/images/edits（2026-09-13 暴君裁定：多模型化，gpt-image-2
// 等在內）。站點現分兩域：pixai bridge 域走原同步鏈；其餘目錄模型走 durable 控制面
// 改圖管線（kind:"image_edit"、202 任務合同）。harness 不做白名單門禁——不可用模型
// 由站點回誠實 400（model_edit_unsupported/model_not_found），渠道事實源是
// supplier_capability（與調度器同源），不在這裡另立一套。

/** pixai bridge 域（站點 resolveBridgeModel 同集合）：同步改圖鏈。 */
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
    "圖生圖改圖。支援改圖的模型以平台目錄 edit=true 為準（GET /v1/model-status），預設 gpt-image-2。除 pixai 系為同步（10-30s 直接回圖）外，其餘模型是「非同步」任務制：提交後回 task_id，完成時間不定（空閒幾十秒到幾分鐘，高峰排隊更久、逾時自動退款），harness 會自動續接結果並出圖卡——提交後立即交還控制權，不要輪詢。超過 0.1 幣會先跳出扣費確認。",
  args: {
    image_url: tool.schema
      .string()
      .describe("原圖：http(s)/data URL 或本地絕對路徑（聊天附件解析出的 uploads 路徑直接可傳）；media: 圖片 ID 僅 pixai 系可用"),
    prompt: tool.schema.string().describe("改圖提示詞"),
    model: tool.schema
      .string()
      .optional()
      .describe("模型名，預設 gpt-image-2；支援編輯的模型以平台目錄為準，不支持的會回誠實錯誤"),
    size: tool.schema.enum(["1k", "2k"]).optional().describe("尺寸等級 1k/2k，預設 1k"),
    quality: tool.schema.enum(["standard", "hd"]).optional().describe("standard 或 hd，預設 standard"),
  },
  async execute(args, context) {
    const model = args.model ?? "gpt-image-2"
    const request_id = randomUUID()
    // 模型可用性強制探測（2026-08-15）
    const probe = await probeModelAvailable(model, context.sessionID, context.abort)
    if (probe.availability === "unavailable") {
      return fail(
        "model_unavailable",
        `改圖模型 ${model} 目前不可用（${probe.note ?? "渠道故障"}）。請改用其他可用模型，或告知用戶。`,
      )
    }
    const estimate = await estimateEditCoins(model, context.sessionID, args.quality, context.abort)

    // ── 分支一：pixai bridge 域 = 原同步鏈（mediaId + 同步回圖出卡）──
    if (PIXAI_BRIDGE_MODELS.has(model.toLowerCase())) {
      try {
        const image = await resolveMediaId(args.image_url, context.sessionID, context.abort)

        // 扣費閘門：單價取自平台目錄；≤0.1 幣屬免確認的低價探索區間
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
            return fail("user_declined", "用戶未確認扣費，已取消。可以改用更便宜的模型或減少張數再試。")
          }
        }

        const payload: any = { image, prompt: args.prompt, model, response_format: "url" }
        if (args.size) payload.size = args.size === "2k" ? "2k" : "1k"
        if (args.quality) payload.quality = args.quality

        const resp = await platformFetch(
          "/images/edits",
          {
            method: "POST",
            headers: { "idempotency-key": request_id }, // PRD §152：重試不重複扣費
            body: JSON.stringify(payload),
          },
          context.sessionID,
          context.abort,
        )
        const body = await resp.json().catch(() => ({}))
        if (!resp.ok) {
          const err = await classifyError(resp, body)
          return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms, title: "改圖失敗" })
        }

        const url = body?.data?.[0]?.url || body?.result_url || body?.url
        const cost_coins = body?.cost_coins ?? body?.x_cost_coins ?? estimate
        // 同步回圖，立即推前端圖片卡；fire-and-forget，失敗不影響 tool
        emitEvent(context.sessionID, "image.done", { url, cost_coins, task_id: request_id }, context.abort).catch(
          () => {},
        )
        return ok({ title: "改圖完成", url, cost_coins })
      } catch (e: any) {
        const err = await classifyError(null, e)
        return fail(err.code, err.hint, { title: "改圖失敗" })
      }
    }

    // ── 分支二：durable 多模型改圖（2026-09-13）= 任務制，同 image_generate 輪子 ──
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
          return fail("user_declined", "用戶未確認扣費，已取消。可以改用更便宜的模型或減少張數再試。")
        }
      }

      const payload: any = { image, prompt: args.prompt, model, response_format: "url" }
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
          // 註冊給 poller 自動輪詢續接（同 image_generate 輪子）；best-effort。
          const reg = await registerTask(task_id, context.sessionID, "image", context.abort, {
            dedup_hash: dedupHash({ model, prompt: args.prompt, image, size: args.size }),
            model,
            cost_coins: estimate,
          })
          return ok(
            {
              task_id,
              kind: "image_edit",
              model,
              estimated_cost_coins: estimate,
              note: "改图任务已提交。完成时间不定：空闲时通常几十秒到几分钟，高峰期可能排队更久，逾时会自动退款——对用户报耗时时用这个分档说法，不要报精确秒数。harness 会自动续接结果并出图卡。不要轮询。回报 task_id 给用户时必须原样照抄完整 UUID（36 字符含连字符），严禁截断成前 8 位——短 id 在平台查不到任务。",
            },
            { poller_ok: reg.ok, poller_error: reg.error },
          )
        }
        return fail("bad_response", `平台回 202 但無 task_id（response=${JSON.stringify(data).slice(0, 200)}）`)
      }

      // 兼容：若站點日後恢復同步回圖，直接出卡。
      if (resp.ok) {
        const url = data?.data?.[0]?.url || data?.result_url || data?.url
        if (url) {
          const cost_coins = data?.cost_coins ?? data?.x_cost_coins ?? estimate
          emitEvent(context.sessionID, "image.done", { url, cost_coins, task_id: request_id }, context.abort).catch(
            () => {},
          )
          return ok({ title: "改圖完成", url, cost_coins, model })
        }
      }

      const err = await classifyError(resp, data)
      return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms, title: "改圖失敗" })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "改圖失敗" })
    }
  },
})
