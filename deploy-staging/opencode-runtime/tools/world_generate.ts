import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { fetchInputImage, storeAsset } from "../lib/asset3d"
import { safeFetch } from "../lib/sandbox"

// world_generate — 一张概念图／一段文字 → 可走进去的 3D 世界（World Labs Marble API）。
//
// 上游：POST https://api.worldlabs.ai/marble/v1/worlds:generate（头 WLT-Api-Key）→ operation_id，
//       轮询 GET /marble/v1/operations/{id}，done 后 response 即 World：
//       assets.splats.spz_urls（Gaussian splat）、assets.mesh.collider_mesh_url（碰撞网格）、
//       assets.imagery.pano_url（全景）、thumbnail_url、caption、world_marble_url（官方查看器）。
// 定价（docs.worldlabs.ai/api/pricing，2026-11-10 读）：1250 credits = $1；
//       图片输入 draft 230 credits，marble-1.0/1.1 1580 credits；HQ 网格导出另计 3500 credits（本工具不做）。
// 币价：1 币 = ¥0.05；美元汇率按 EIMU_USD_CNY（预设 7.2）。报价先于提交，cap_coins 不够就不提交。
// 上游签名链接会过期 ⇒ splat／碰撞网格／全景一律转存平台存储。

const API = process.env.WORLDLABS_API_BASE || "https://api.worldlabs.ai"
const CREDITS_PER_USD = 1250
const COIN_CNY = 0.05
const USD_CNY = Number(process.env.EIMU_USD_CNY || "7.2")
const MAX_ASSET_BYTES = 180 * 1024 * 1024
const POLL_MS = 5_000
const MAX_WAIT_MS = 15 * 60_000

/** 生成本身的 credits（文字输入未在定价页单列 ⇒ 按同档图片输入的上限报价，回执写实付）。 */
const GENERATE_CREDITS: Record<string, number> = {
  "marble-1.0-draft": 230,
  "marble-1.0": 1580,
  "marble-1.1": 1580,
  "marble-1.1-plus": 1580,
}

function creditsToCoins(credits: number): number {
  return Math.ceil(((credits / CREDITS_PER_USD) * USD_CNY) / COIN_CNY)
}

async function wl(path: string, key: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "WLT-Api-Key": key, "Content-Type": "application/json", ...(init.headers || {}) },
  })
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text.slice(0, 300) }
  }
  if (!res.ok) {
    const msg = String(data?.detail ?? data?.message ?? data?.error ?? data?.raw ?? "").slice(0, 400)
    const code = res.status === 402 ? "upstream_insufficient_credits" : res.status === 401 || res.status === 403 ? "upstream_auth_failed" : res.status === 422 || res.status === 400 ? "upstream_rejected" : "upstream_error"
    throw Object.assign(new Error(`Marble HTTP ${res.status}${msg ? `：${msg}` : ""}`), { code })
  }
  return data
}

async function rehost(url: string | undefined | null, filename: string, sessionID: string, signal?: AbortSignal): Promise<string | null> {
  if (!url) return null
  const res = await safeFetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000) })
  if (!res.ok) throw new Error(`下载 ${filename} 失败 HTTP ${res.status}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength > MAX_ASSET_BYTES) throw new Error(`${filename} 超过 180MB`)
  return (await storeAsset(buf, filename, sessionID)).url
}

// 描述随开通状态如实变化（同 model3d_generate）：没 key 时不让模型对用户承诺「能走进去的场景能先做出来」。
const CONFIGURED = !!(process.env.WORLDLABS_API_KEY || process.env.WLT_API_KEY)
const STATUS = CONFIGURED ? "" : "【当前未开通：平台没配置 WORLDLABS_API_KEY，调用只会返回 upstream_not_configured。对用户如实说可走进去的 3D 世界暂时做不了，不要承诺能先做出来。】"

export default tool({
  description:
    STATUS +
    "造世界：一张环境概念图（或一段场景描述）→ 可走进去的 3D 世界（World Labs Marble）：Gaussian splat（.spz）＋碰撞网格（.glb）＋全景图，全部转存平台。" +
    "整片环境／关卡底图用它；单个道具、角色用 model3d_generate。优先给图（构图、光线、色调更可控），先用 image_generate 出一张 16:9 广角环境概念图再喂进来。" +
    "会真实扣上游费用：先报价，cap_coins 低于报价不提交（draft 约 " + creditsToCoins(230) + " 币，标准约 " + creditsToCoins(1580) + " 币）。单次约 5 分钟。",
  args: {
    image_url: tool.schema.string().optional().describe("环境概念图公网 URL（png/jpg/webp），广角、地平线清楚、无人物特写最好。"),
    prompt: tool.schema.string().max(2000).optional().describe("场景描述；有图时作为补充说明，无图时作为唯一输入。"),
    is_pano: tool.schema.boolean().optional().describe("输入图本身就是 360° 等距柱状全景时填 true。"),
    model: tool.schema.enum(["marble-1.0-draft", "marble-1.1", "marble-1.1-plus"]).optional().describe("draft 便宜快速出草样；marble-1.1（预设）正式版；plus 最高品质。"),
    seed: tool.schema.number().int().min(0).max(2147483647).optional(),
    display_name: tool.schema.string().max(64).optional().describe("世界名（≤64 字）。"),
    project: tool.schema.string().optional().describe("项目名（写进回执，供 game_asset_manifest 归档）。"),
    cap_coins: tool.schema.number().min(0).describe("本次最多可花的币；低于报价直接回报价、不提交。"),
  },
  async execute(args, context) {
    if (!args.image_url && !args.prompt?.trim()) return fail("bad_request", "image_url 与 prompt 至少给一个。")
    const model = args.model ?? "marble-1.1"
    const quoteCredits = GENERATE_CREDITS[model]
    const quoteCoins = creditsToCoins(quoteCredits)
    const quote = { model, credits: quoteCredits, usd: +(quoteCredits / CREDITS_PER_USD).toFixed(3), coins: quoteCoins, basis: args.image_url ? "定价页图片输入单价" : "文字输入未单列，按同档图片输入上限报价" }
    if (args.cap_coins < quoteCoins) {
      return fail("budget_exceeded", `这次世界生成报价 ${quoteCoins} 币（${model}，${quoteCredits} credits），超过 cap_coins=${args.cap_coins}，未提交。`, { quote })
    }
    const key = process.env.WORLDLABS_API_KEY || process.env.WLT_API_KEY || ""
    if (!key) {
      return fail(
        "upstream_not_configured",
        "世界生成走 World Labs Marble API，平台尚未配置 WORLDLABS_API_KEY；如实告诉使用者这一步还没开通，不要用 Blender 白模或一张图冒充可走进去的世界。",
        { quote },
      )
    }
    const started = Date.now()
    try {
      const worldPrompt: Record<string, unknown> = args.image_url
        ? await (async () => {
            const img = await fetchInputImage(args.image_url!, context.abort)
            return {
              type: "image",
              image_prompt: { source: "data_base64", data_base64: Buffer.from(img.bytes).toString("base64"), extension: img.ext },
              ...(args.is_pano ? { is_pano: true } : {}),
              ...(args.prompt?.trim() ? { text_prompt: args.prompt.trim() } : {}),
            }
          })()
        : { type: "text", text_prompt: args.prompt!.trim() }
      const body: Record<string, unknown> = { world_prompt: worldPrompt, model, display_name: (args.display_name || args.project || "Eimu world").slice(0, 64) }
      if (args.seed !== undefined) body.seed = args.seed
      const op = await wl("/marble/v1/worlds:generate", key, { method: "POST", body: JSON.stringify(body), signal: context.abort })
      const opId = String(op?.operation_id ?? "")
      if (!opId) throw Object.assign(new Error("Marble 没回 operation_id"), { code: "upstream_bad_response" })
      let done = op
      while (!done?.done) {
        if (Date.now() - started > MAX_WAIT_MS) {
          return fail("upstream_timeout", `Marble 15 分钟未完成，operation_id=${opId}（已提交，费用以上游为准；勿重复提交）。`, { operation_id: opId, quote })
        }
        await new Promise((r) => setTimeout(r, POLL_MS))
        done = await wl(`/marble/v1/operations/${encodeURIComponent(opId)}`, key, { signal: context.abort })
      }
      if (done.error) throw Object.assign(new Error(`Marble 生成失败：${JSON.stringify(done.error).slice(0, 400)}`), { code: "upstream_failed" })
      const world = done.response?.assets ? done.response : await wl(`/marble/v1/worlds/${encodeURIComponent(String(done.response?.world_id ?? ""))}`, key, { signal: context.abort })
      const assets = world?.assets ?? {}
      const spzEntries = Object.entries((assets.splats?.spz_urls ?? {}) as Record<string, string>)
      const splats: Record<string, string> = {}
      for (const [res, url] of spzEntries) {
        const stored = await rehost(url, `world-${res}.spz`, context.sessionID, context.abort)
        if (stored) splats[res] = stored
      }
      const collider = await rehost(assets.mesh?.collider_mesh_url, "world-collider.glb", context.sessionID, context.abort)
      const pano = await rehost(assets.imagery?.pano_url, "world-pano.png", context.sessionID, context.abort)
      const thumb = await rehost(assets.thumbnail_url, "world-thumb.png", context.sessionID, context.abort)
      const name = args.display_name || world?.display_name || "3D 世界"
      return ok({
        title: `3D 世界：${name}`,
        world_id: world?.world_id ?? null,
        viewer_url: world?.world_marble_url ?? null,
        splat_urls: splats,
        collider_mesh_url: collider,
        pano_url: pano,
        thumbnail_url: thumb,
        caption: assets.caption ?? null,
        markdown_links: [
          ...Object.entries(splats).map(([res, url]) => `[${name} splat ${res}（SPZ）](${url})`),
          ...(collider ? [`[${name} 碰撞网格（GLB）](${collider})`] : []),
          ...(pano ? [`[${name} 全景](${pano})`] : []),
        ],
        quote,
        upstream_cost: done.cost ?? world?.cost ?? null,
        operation_id: opId,
        project: args.project ?? null,
        seconds: Math.round((Date.now() - started) / 1000),
        note: "splat 与碰撞网格已转存平台。进 UE：碰撞网格当地形碰撞、splat 用 UE 的 Gaussian splat 插件或官方查看器预览；交付文写 markdown_links。",
      })
    } catch (e: any) {
      return fail(e?.code ?? "world_failed", String(e?.message ?? e).slice(0, 600), { quote, seconds: Math.round((Date.now() - started) / 1000) })
    }
  },
})
