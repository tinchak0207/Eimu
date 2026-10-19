import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, platformFetch, ok, fail } from "../lib/client"

export default tool({
  description:
    "激活资产包——把包内提示词/LoRA/参考图解析成可直接送 image_generate/image_edit 的参数契约 {prompt?, loraModelVersionIds?, referenceImageUrls?, digest?}。生成时用本工具解析后把这些字段传给 image_generate（LoRA 只能 1 个，取第一个 lora item；参考图只能走 image_edit/参考通道）。",
  args: {
    pack_id: tool.schema.string().describe("资产包 ID（必填）"),
  },
  async execute(args, context) {
    try {
      const resp = await platformFetch(
        `/assets?id=${encodeURIComponent(args.pack_id)}`,
        {},
        context.sessionID,
        context.abort,
      )
      const body = await resp.json().catch(() => ({}))

      if (!resp.ok) {
        const err = await classifyError(resp, body)
        return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms, title: "查询失败" })
      }

      const p = body?.packs?.[0]
      if (!p) {
        return fail("asset_pack_not_found", "未找到该资产包，请先用 asset_search 确认 pack_id", {
          title: "未找到资产包",
        })
      }

      const items: any[] = Array.isArray(p.items) ? p.items : []
      const activation: Record<string, unknown> = {
        packId: p.id,
        title: p.title,
      }

      // prompt = 第一个 kind=prompt|recipe 且有 content 的 item.content（没有就省略）
      const promptItem = items.find(
        (it: any) =>
          (it.kind === "prompt" || it.kind === "recipe") &&
          typeof it.content === "string" &&
          it.content,
      )
      if (promptItem) activation.prompt = promptItem.content

      // loraModelVersionIds = lora items 的 loraVersionId 取第一个（单选铁律，数组长度 1）
      const loraItems = items.filter((it: any) => it.kind === "lora" && it.loraVersionId)
      if (loraItems.length > 0) activation.loraModelVersionIds = [loraItems[0].loraVersionId]

      // referenceImageUrls = kind=reference|image 且有 imageUrl 的不重复列表（最多 5 个）
      const refUrls = Array.from(
        new Set(
          items
            .filter((it: any) => (it.kind === "reference" || it.kind === "image") && it.imageUrl)
            .map((it: any) => it.imageUrl),
        ),
      ).slice(0, 5)
      if (refUrls.length > 0) activation.referenceImageUrls = refUrls

      // digest = p.digest（有才带）
      if (typeof p.digest === "string" && p.digest) activation.digest = p.digest

      return ok({ title: "资产包已激活", activation })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "查询失败" })
    }
  },
})