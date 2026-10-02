import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, siteFetch, publicImageUrl, uploadImageBytes, ok, fail } from "../lib/client"

// 角色卡五值 kind（与站点 src/lib/character-cards.ts 的 CHARACTER_CARD_KIND_VALUES 同尺）。
const KINDS = ["character", "scene", "style", "prop", "audio"] as const
// 站点同尺上限（character-cards.ts MAX_CARD_REFERENCES = 8）。
const MAX_REFERENCE_IMAGES = 8

/**
 * 参考图来源归一成「卡能长期引用的公网 URL」：
 * - http(s) URL：原样放行（已是公网可寻址）。
 * - data:image URI：原样放行（站点 isCardImageUrl 接受内嵌图）。
 * - 本地绝对/相对路径：复用 lib/client 既有上传函数换公网 URL（禁另写上传）。
 *   uploadImageBytes 走平台 /uploads；若该端点只回 mediaId 不回 url，退回
 *   publicImageUrl（网关 /internal/media/upload）拿公网 URL，保证卡里存的是 URL 不是句柄。
 */
async function toPublicReferenceUrl(
  imageSource: string,
  sessionID: string,
  signal?: AbortSignal,
): Promise<string> {
  const src = (imageSource || "").trim()
  if (!src) throw Object.assign(new Error("参考图为空，请传 http(s) URL、data:image URI 或本地绝对路径"), { code: "bad_request" })
  if (/^https?:\/\//i.test(src)) return src
  if (/^data:image\//i.test(src)) return src
  if (src.startsWith("media:")) {
    throw Object.assign(
      new Error("media: 图片 ID 是平台内部句柄，不能当角色卡的公网参考图 URL；请传 http(s) URL、data:image URI 或本地绝对路径"),
      { code: "bad_request" },
    )
  }
  const up = await uploadImageBytes(src, sessionID, signal)
  if (up.url && /^https?:\/\//i.test(up.url)) return up.url
  return await publicImageUrl(src, sessionID, signal)
}

export default tool({
  description:
    "把一个已经生成好的角色图固化成可重复引用的角色卡（例如三视图定妆照）。卡是按用户存的，与站点画布上的角色卡是同一个卡库、同一份数据。同一个用户、同名同种类重复保存 = 更新同一张卡（站点用确定性 id 做 upsert），不会重复建卡，可以放心重存。存好之后：生图时在 prompt 里写 `@[角色:卡名]`，或把该卡的参考图网网址传给 image_generate 的 reference_images，就能让同一张脸跨图一致。",
  args: {
    name: tool.schema.string().describe("卡名（必填），之后用它引用，如 `@[角色:卡名]`"),
    kind: tool.schema
      .string()
      .optional()
      .describe("种类：character(角色，默认)|scene(场景)|style(风格)|prop(道具)|audio(音频)"),
    prompt: tool.schema
      .string()
      .optional()
      .describe("该卡锁定的描述片段（外观/场景等），生图时会在 `@[种类:卡名]` 处就地展开进 prompt；留空 = 纯参考图卡"),
    reference_images: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("参考图列表（最多 8 张）：公网 http(s) URL、data:image URI 或本地绝对路径（本地路径会先上传换公网 URL）"),
    negative_prompt: tool.schema.string().optional().describe("该卡的负面词（可选）"),
  },
  async execute(args, context) {
    try {
      const name = (args.name || "").trim()
      if (!name) {
        return fail("bad_request", "name 必填：请给这张卡一个之后能引用的名字（如「霍辞渊」）。", {
          title: "参数错误",
        })
      }
      const kind = (typeof args.kind === "string" && args.kind.trim() ? args.kind.trim() : "character").toLowerCase()
      if (!(KINDS as readonly string[]).includes(kind)) {
        return fail("bad_kind", `kind 只能是 ${KINDS.join("/")} 之一，收到「${args.kind}」。`, {
          title: "参数错误",
        })
      }

      const sources = (Array.isArray(args.reference_images) ? args.reference_images : [])
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter(Boolean)
      if (sources.length > MAX_REFERENCE_IMAGES) {
        return fail(
          "too_many_references",
          `参考图最多 ${MAX_REFERENCE_IMAGES} 张（与站点同尺），收到 ${sources.length} 张，请先精简后再存。`,
          { title: "参数错误" },
        )
      }

      const reference_urls: string[] = []
      for (const src of sources) {
        reference_urls.push(await toPublicReferenceUrl(src, context.sessionID, context.abort))
      }

      // B 端契约栏位名是 reference_urls（不是站点内部的 references 对象数组）。
      const payload: Record<string, unknown> = { name, kind, reference_urls }
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
      if (prompt) payload.prompt = prompt
      const negative = typeof args.negative_prompt === "string" ? args.negative_prompt.trim() : ""
      if (negative) payload.negative_prompt = negative

      // 打站點本體 /api/biz/*（不經 /v1 控制面改寫：控制面那棵樹沒有角色卡路由）。
      const resp = await siteFetch(
        "/api/biz/character-cards",
        { method: "POST", body: JSON.stringify(payload) },
        context.sessionID,
        context.abort,
      )
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        const err = await classifyError(resp, body)
        return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms, title: "保存角色卡失败" })
      }

      const card = body?.card ?? body?.data ?? body
      const card_id = typeof card?.id === "string" ? card.id : ""
      if (!card_id) {
        // 没回卡 id = 无法确认落库，不许谎报成功。
        return fail(
          "save_contract_mismatch",
          "站点回了成功但没带卡 id，无法确认卡已落库（B 端契约不符）。请把此现象回报道具，不要当成已保存。",
          { title: "保存结果异常" },
        )
      }
      const savedUrls: string[] = Array.isArray(card?.reference_urls)
        ? card.reference_urls.filter((u: any): u is string => typeof u === "string" && !!u)
        : reference_urls

      return ok({
        title: `角色卡已保存：${name}`,
        card_id,
        name: typeof card?.name === "string" && card.name ? card.name : name,
        kind,
        reference_urls: savedUrls,
        note: `已存成角色卡；之后在生图 prompt 写 \`@[角色:${name}]\` 或在 image_generate 带 reference_images 即可引用同一张脸`,
      })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "保存角色卡失败" })
    }
  },
})
