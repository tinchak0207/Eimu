import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, siteFetch, ok, fail } from "../lib/client"

// 角色卡五值 kind（与站点 src/lib/character-cards.ts 的 CHARACTER_CARD_KIND_VALUES 同尺）。
const KINDS = ["character", "scene", "style", "prop", "audio"] as const

/** 卡视图：只暴露 agent 引用卡需要的栏位（id/名称/种类/锁定描述片段/参考图网网址）。 */
function cardView(c: any) {
  const urls: string[] = Array.isArray(c?.reference_urls)
    ? c.reference_urls.filter((u: unknown): u is string => typeof u === "string" && !!u)
    : Array.isArray(c?.references)
      ? c.references
          .map((r: any) => (typeof r === "string" ? r : r?.url))
          .filter((u: unknown): u is string => typeof u === "string" && !!u)
      : []
  return {
    id: typeof c?.id === "string" ? c.id : "",
    name: typeof c?.name === "string" ? c.name : "",
    kind: typeof c?.kind === "string" ? c.kind : "character",
    prompt: typeof c?.prompt === "string" ? c.prompt : "",
    reference_urls: urls,
  }
}

export default tool({
  description:
    "查当前用户已有的角色卡清单（卡是按用户存的，与站点画布上的角色卡是同一个卡库、同一份数据）。建立或引用角色前先查这张清单，不要凭记忆猜卡名。回传每张卡的 id/名称/种类/参考图网网址；拿到卡名后即可在生图 prompt 里写 `@[角色:卡名]` 引用同一张脸。",
  args: {
    kind: tool.schema
      .string()
      .optional()
      .describe("按种类过滤：character(角色)|scene(场景)|style(风格)|prop(道具)|audio(音频)；不填则返回全部"),
    q: tool.schema.string().optional().describe("按名称关键字过滤；不填则不过滤"),
    limit: tool.schema.number().optional().describe("返回数量上限，默认 20，最大 50"),
  },
  async execute(args, context) {
    try {
      const rawLimit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : 20
      const limit = Math.max(1, Math.min(50, rawLimit))
      const kind = typeof args.kind === "string" ? args.kind.trim().toLowerCase() : ""
      if (kind && !(KINDS as readonly string[]).includes(kind)) {
        return fail(
          "bad_kind",
          `kind 只能是 ${KINDS.join("/")} 之一，收到「${args.kind}」；不填则返回全部种类的卡。`,
          { title: "参数错误" },
        )
      }
      const params = new URLSearchParams()
      if (kind) params.set("kind", kind)
      const q = typeof args.q === "string" ? args.q.trim() : ""
      if (q) params.set("q", q)
      params.set("limit", String(limit))

      // 打站點本體 /api/biz/*（不經 /v1 控制面改寫：控制面那棵樹沒有角色卡路由）。
      const resp = await siteFetch(
        `/api/biz/character-cards?${params.toString()}`,
        { method: "GET" },
        context.sessionID,
        context.abort,
      )
      const body = await resp.json().catch(() => ({}))

      if (!resp.ok) {
        const err = await classifyError(resp, body)
        return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms, title: "查询角色卡失败" })
      }

      const raw: any[] = Array.isArray(body?.cards)
        ? body.cards
        : Array.isArray(body)
          ? body
          : Array.isArray(body?.data)
            ? body.data
            : []

      if (raw.length === 0) {
        // 空卡库必须明说，不能让 agent 把空清单误判成工具坏了。
        return ok({
          title: "角色卡清单（空）",
          cards: [],
          count: 0,
          note: "该用户目前没有任何角色卡。不要假设某张卡已存在，也不要凭记忆猜卡名；需要固定形象时先用 character_card_save 存一张卡，再在 prompt 里用 `@[角色:卡名]` 引用。",
        })
      }

      const cards = raw
        .filter((c) => c && typeof c === "object")
        .map(cardView)
      return ok({
        title: `角色卡清单（${cards.length} 张）`,
        cards,
        count: cards.length,
      })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "查询角色卡失败" })
    }
  },
})
