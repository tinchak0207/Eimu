import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { gatewayReadSnapshot } from "../lib/canvas-flow"

// 交付包聚合（2026-08-31 片1 实装）：成品清单（画布 node_ids 或直给 urls）→ 交付 URI 清单。
// 读画布快照经 gateway internal 端点（轮子 canvas_get_state 同通道，直接用 canvas-flow export）。
// 按类型归档（image/video/audio/film），多格式栏位只聚合 metadata 中真实存在的
// （original/upscaled/thumbnail），缺的诚实标 null，绝不编造 URL。

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

function classifyUrl(url: string): string {
  const clean = url.split(/[?#]/)[0].toLowerCase()
  if (/\.(mp4|mov|webm|mkv|avi)$/.test(clean)) return "video"
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/.test(clean)) return "audio"
  if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(clean)) return "image"
  return "unknown"
}

function firstStr(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return null
}

async function listSucceededTaskUrls(sessionID: string): Promise<string[]> {
  try {
    const resp = await fetch(`${GATEWAY}/internal/session-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionID }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!resp.ok) return []
    const body = (await resp.json().catch(() => ({}))) as { tasks?: Array<{ status?: string; url?: string }> }
    return (Array.isArray(body.tasks) ? body.tasks : [])
      .filter((t) => t?.status === "succeeded" && typeof t.url === "string" && t.url)
      .map((t) => t.url as string)
  } catch {
    return []
  }
}

export default tool({
  description:
    "交付包聚合（纯读取，零扣费）。node_ids 填画布成品节点 id JSON 阵列字串（可省略：两者皆不填时自动扫描整张画布；经 gateway 画布快照聚合各节点 metadata 的真实 URL 与多格式栏位），或 urls 填成品 URL JSON 阵列字串直给。输出交付清单：按 image/video/audio/film 归档，每项含 original/upscaled/thumbnail 格式栏位——metadata 没有的格式诚实标 null，不编造。交付/打包/发群前用它拿最终 URI 清单。画布未上报状态时回 ok:false 并提示让用户打开画布。",
  args: {
    node_ids: tool.schema.string().optional().describe("画布节点 id 清单：JSON 阵列字串，如 [\"shot1\",\"kv\"]"),
    urls: tool.schema.string().optional().describe("成品 URL 清单：JSON 阵列字串"),
    package_title: tool.schema.string().optional().describe("交付包标题（给用户看）"),
  },
  async execute(_args, context) {
    const nodeIds: string[] = []
    const urls: string[] = []
    if (_args.node_ids) {
      try {
        const j = JSON.parse(_args.node_ids)
        if (Array.isArray(j)) nodeIds.push(...j.filter((x): x is string => typeof x === "string" && x.trim()))
      } catch {
        return fail("invalid_node_ids", "node_ids 必须是 JSON 阵列字串", { title: "输入非法" })
      }
    }
    if (_args.urls) {
      try {
        const j = JSON.parse(_args.urls)
        if (Array.isArray(j)) urls.push(...j.filter((x): x is string => typeof x === "string" && x.trim()))
      } catch {
        return fail("invalid_urls", "urls 必须是 JSON 阵列字串", { title: "输入非法" })
      }
    }
    // H11：零参数不再要求「先跑 canvas_get_state」（鸡生蛋）——自行取画布快照，
    // 把所有已有成品 URL 的节点纳入；画布无快照时回退读本轮任务清单（/internal/session-tasks）的 succeeded URL。
    let autoDiscover = false
    if (!nodeIds.length && !urls.length) {
      autoDiscover = true
      const snap = await gatewayReadSnapshot(GATEWAY, context.sessionID)
      if (snap.has_state && snap.state !== null) {
        const st = snap.state as Record<string, unknown>
        const ns = (Array.isArray(st.nodes) ? st.nodes : []) as Record<string, unknown>[]
        for (const n of ns) if (n && typeof n.id === "string" && n.id) nodeIds.push(n.id)
      }
      if (!nodeIds.length) {
        for (const t of await listSucceededTaskUrls(context.sessionID)) urls.push(t)
      }
      if (!nodeIds.length && !urls.length) {
        return fail("nothing_to_deliver", "画布尚无节点且本轮无已完成任务：没有可交付资产（本工具已自行读取画布与任务清单，无需先呼叫其他工具）", { title: "交付为空" })
      }
    }

    const items: Record<string, unknown>[] = []
    const missing: string[] = []

    if (nodeIds.length) {
      const snap = await gatewayReadSnapshot(GATEWAY, context.sessionID)
      if (!snap.has_state || snap.state === null) {
        return fail("no_canvas_state", "画布尚未上报状态，请让用户打开画布工作台后重试（或改用 urls 直给）", { title: "无画布状态" })
      }
      const state = snap.state as Record<string, unknown>
      const nodes = (Array.isArray(state.nodes) ? state.nodes : []) as Record<string, unknown>[]
      const byId = new Map(nodes.map((n) => [String(n.id ?? ""), n]))
      for (const id of nodeIds) {
        const n = byId.get(id)
        if (!n) {
          missing.push(id)
          continue
        }
        const meta = (n.metadata && typeof n.metadata === "object" ? n.metadata : {}) as Record<string, unknown>
        const url = firstStr(meta, ["content", "url", "result_url", "videoUrl"]) || firstStr(n as Record<string, unknown>, ["url"])
        const kind = firstStr(meta, ["kind"]) || String(n.type || "unknown")
        if (!url) {
          missing.push(`${id}（节点存在但无成品 URL，可能未完成生成）`)
          continue
        }
        items.push({
          source: "canvas_node",
          node_id: id,
          title: typeof n.title === "string" ? n.title : id,
          kind,
          formats: {
            original: url,
            upscaled: firstStr(meta, ["upscaled_url", "upscale_url", "hd_url"]),
            thumbnail: firstStr(meta, ["thumbnail", "thumb_url", "preview_url"]),
          },
        })
      }
    }

    for (const u of urls) {
      items.push({
        source: "direct_url",
        kind: classifyUrl(u),
        formats: { original: u, upscaled: null, thumbnail: null },
      })
    }

    const counts: Record<string, number> = {}
    for (const it of items) counts[String(it.kind)] = (counts[String(it.kind)] || 0) + 1

    if (!items.length) {
      return fail("nothing_to_deliver", `清单内无可交付资产：${missing.join("; ") || "空"}`, { title: "交付为空" })
    }

    return ok({
      title: `${_args.package_title || "交付包"}：${items.length} 项`,
      package_title: _args.package_title || "交付包",
      items,
      counts_by_kind: counts,
      auto_discovered: autoDiscover,
      missing,
      note: "upscaled/thumbnail 仅在画布节点 metadata 真实存在时填充；null=该格式未产出，需另跑 image_upscale 等工具，本工具不代生成。",
    })
  },
})
