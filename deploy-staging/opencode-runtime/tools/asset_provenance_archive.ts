import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, platformFetch, ok, fail } from "../lib/client"
import { gatewayReadSnapshot } from "../lib/canvas-flow"

// 證物鏈歸檔（2026-08-31 片1 實裝）：物料清單 → 每資產來源 prompt/模型/seed/時間/
// 版本/關聯 job 的歸檔 JSON。聚合兩路：畫布快照 metadata（經 gateway internal 端點，
// 輪子 canvas_get_state 同通道）+ 站點 job 記錄（platformFetch GET /images/{task_id}，
// 輪子 image_get_result 同調法）。缺欄位誠實標 "missing"，不編造。

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

function firstStr(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return null
}
function firstNum(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === "number" && Number.isFinite(v)) return v
  }
  return null
}

export default tool({
  description:
    "證物鏈歸檔（純讀取聚合，零扣費）。node_ids 填畫布物料節點 id JSON 陣列字串（從畫布快照 metadata 聚合 prompt/model/seed/時間/版本/task_id），或 urls 填資產 URL JSON 陣列字串。metadata 帶 task_id 時順帶查站點 job 記錄（GET /images/{id}：status/花費/結果 URL）補全證物。輸出歸檔 JSON：每資產 provenance{prompt,model,seed,created_at,version,related_job}，缺的欄位標 \"missing\"——查不到就說查不到，絕不編造來源。合規存證/交付覆核/版本追溯用它。",
  args: {
    node_ids: tool.schema.string().optional().describe("畫布節點 id 清單：JSON 陣列字串"),
    urls: tool.schema.string().optional().describe("資產 URL 清單：JSON 陣列字串"),
    include_job_records: tool.schema.boolean().optional().describe("是否查站點 job 記錄補全（默認 true）"),
  },
  async execute(args, context) {
    const nodeIds: string[] = []
    const urls: string[] = []
    if (args.node_ids) {
      try {
        const j = JSON.parse(args.node_ids)
        if (Array.isArray(j)) nodeIds.push(...j.filter((x): x is string => typeof x === "string" && x.trim()))
      } catch {
        return fail("invalid_node_ids", "node_ids 必須是 JSON 陣列字串", { title: "輸入非法" })
      }
    }
    if (args.urls) {
      try {
        const j = JSON.parse(args.urls)
        if (Array.isArray(j)) urls.push(...j.filter((x): x is string => typeof x === "string" && x.trim()))
      } catch {
        return fail("invalid_urls", "urls 必須是 JSON 陣列字串", { title: "輸入非法" })
      }
    }
    if (!nodeIds.length && !urls.length) {
      return fail("empty_input", "node_ids 與 urls 至少填一個", { title: "輸入缺失" })
    }

    const entries: Record<string, unknown>[] = []
    const warnings: string[] = []

    if (nodeIds.length) {
      const snap = await gatewayReadSnapshot(GATEWAY, context.sessionID)
      if (!snap.has_state || snap.state === null) {
        warnings.push("畫布快照不可用（未上報/斷線），node_ids 項全部降為 urls 級證物或標 missing")
      }
      const state = snap.state as Record<string, unknown> | null
      const nodes = (state && Array.isArray(state.nodes) ? state.nodes : []) as Record<string, unknown>[]
      const byId = new Map(nodes.map((n) => [String(n.id ?? ""), n]))
      for (const id of nodeIds) {
        const n = byId.get(id)
        if (!n) {
          entries.push({ asset: id, source: "canvas_node", status: "node_not_found", provenance: null })
          continue
        }
        const meta = (n.metadata && typeof n.metadata === "object" ? n.metadata : {}) as Record<string, unknown>
        const url = firstStr(meta, ["content", "url", "result_url", "videoUrl"])
        const taskId = firstStr(meta, ["task_id", "taskId", "job_id", "jobId"])
        const prov: Record<string, unknown> = {
          prompt: firstStr(meta, ["prompt", "text", "description"]) || "missing",
          model: firstStr(meta, ["model", "model_id"]) || "missing",
          seed: firstNum(meta, ["seed"]) ?? "missing",
          created_at: firstStr(meta, ["created_at", "createdAt", "timestamp"]) ?? firstNum(meta, ["created_at", "createdAt", "timestamp"]) ?? "missing",
          version: firstStr(meta, ["version", "revision"]) ?? (firstNum(meta, ["version", "revision"]) ?? "missing"),
          url: url || "missing",
          related_job: taskId || "missing",
        }
        if (taskId && args.include_job_records !== false) {
          try {
            const resp = await platformFetch(`/images/${encodeURIComponent(taskId)}`, {}, context.sessionID, context.abort)
            const body = (await resp.json().catch(() => ({}))) as Record<string, any>
            if (resp.ok) {
              prov.job_record = {
                status: body?.status || body?.data?.[0]?.status || "unknown",
                result_url: body?.result_url || body?.data?.[0]?.url || body?.data?.[0]?.videoUrl || null,
                cost_coins: body?.cost_coins ?? body?.x_cost_coins ?? null,
                task_id: taskId,
              }
            } else {
              prov.job_record = { status: "query_failed", reason: `HTTP ${resp.status}` }
            }
          } catch (e) {
            prov.job_record = { status: "query_failed", reason: (e as Error)?.message || String(e) }
          }
        }
        const missingFields = Object.entries(prov)
          .filter(([, v]) => v === "missing")
          .map(([k]) => k)
        entries.push({
          asset: typeof n.title === "string" && n.title ? n.title : id,
          node_id: id,
          source: "canvas_node",
          provenance: prov,
          missing_fields: missingFields,
        })
      }
    }

    for (const u of urls) {
      entries.push({
        asset: u,
        source: "direct_url",
        provenance: {
          prompt: "missing",
          model: "missing",
          seed: "missing",
          created_at: "missing",
          version: "missing",
          url: u,
          related_job: "missing",
        },
        missing_fields: ["prompt", "model", "seed", "created_at", "version", "related_job"],
        note: "直給 URL 無畫布 metadata 可聚合；如需證物請用 node_ids 或帶 task_id 的資產",
      })
    }

    const complete = entries.filter((e) => e.provenance && (e.missing_fields as string[]).length === 0).length

    return ok({
      title: `證物鏈歸檔：${entries.length} 項（完整 ${complete}）`,
      archived_at: new Date().toISOString(),
      entries,
      integrity_note: "missing=來源不可考，非本工具遺漏；job_record.query_failed 原因已逐項標註。",
      warnings,
    })
  },
})
