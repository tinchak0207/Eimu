import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { gatewayReadSnapshot } from "../lib/canvas-flow"

// 交付包聚合（2026-08-31 片1 實裝）：成品清單（畫布 node_ids 或直給 urls）→ 交付 URI 清單。
// 讀畫布快照經 gateway internal 端點（輪子 canvas_get_state 同通道，直接用 canvas-flow export）。
// 按類型歸檔（image/video/audio/film），多格式欄位只聚合 metadata 中真實存在的
// （original/upscaled/thumbnail），缺的誠實標 null，絕不編造 URL。

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
    "交付包聚合（純讀取，零扣費）。node_ids 填畫布成品節點 id JSON 陣列字串（可省略：兩者皆不填時自動掃描整張畫布；經 gateway 畫布快照聚合各節點 metadata 的真實 URL 與多格式欄位），或 urls 填成品 URL JSON 陣列字串直給。輸出交付清單：按 image/video/audio/film 歸檔，每項含 original/upscaled/thumbnail 格式欄位——metadata 沒有的格式誠實標 null，不編造。交付/打包/發群前用它拿最終 URI 清單。畫布未上報狀態時回 ok:false 並提示讓用戶打開畫布。",
  args: {
    node_ids: tool.schema.string().optional().describe("畫布節點 id 清單：JSON 陣列字串，如 [\"shot1\",\"kv\"]"),
    urls: tool.schema.string().optional().describe("成品 URL 清單：JSON 陣列字串"),
    package_title: tool.schema.string().optional().describe("交付包標題（給用戶看）"),
  },
  async execute(_args, context) {
    const nodeIds: string[] = []
    const urls: string[] = []
    if (_args.node_ids) {
      try {
        const j = JSON.parse(_args.node_ids)
        if (Array.isArray(j)) nodeIds.push(...j.filter((x): x is string => typeof x === "string" && x.trim()))
      } catch {
        return fail("invalid_node_ids", "node_ids 必須是 JSON 陣列字串", { title: "輸入非法" })
      }
    }
    if (_args.urls) {
      try {
        const j = JSON.parse(_args.urls)
        if (Array.isArray(j)) urls.push(...j.filter((x): x is string => typeof x === "string" && x.trim()))
      } catch {
        return fail("invalid_urls", "urls 必須是 JSON 陣列字串", { title: "輸入非法" })
      }
    }
    // H11：零參數不再要求「先跑 canvas_get_state」（雞生蛋）——自行取畫布快照，
    // 把所有已有成品 URL 的節點納入；畫布無快照時回退讀本輪任務清單（/internal/session-tasks）的 succeeded URL。
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
        return fail("nothing_to_deliver", "畫布尚無節點且本輪無已完成任務：沒有可交付資產（本工具已自行讀取畫布與任務清單，無需先呼叫其他工具）", { title: "交付為空" })
      }
    }

    const items: Record<string, unknown>[] = []
    const missing: string[] = []

    if (nodeIds.length) {
      const snap = await gatewayReadSnapshot(GATEWAY, context.sessionID)
      if (!snap.has_state || snap.state === null) {
        return fail("no_canvas_state", "畫布尚未上報狀態，請讓用戶打開畫布工作台後重試（或改用 urls 直給）", { title: "無畫布狀態" })
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
          missing.push(`${id}（節點存在但無成品 URL，可能未完成生成）`)
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
      return fail("nothing_to_deliver", `清單內無可交付資產：${missing.join("; ") || "空"}`, { title: "交付為空" })
    }

    return ok({
      title: `${_args.package_title || "交付包"}：${items.length} 項`,
      package_title: _args.package_title || "交付包",
      items,
      counts_by_kind: counts,
      auto_discovered: autoDiscover,
      missing,
      note: "upscaled/thumbnail 僅在畫布節點 metadata 真實存在時填充；null=該格式未產出，需另跑 image_upscale 等工具，本工具不代生成。",
    })
  },
})
