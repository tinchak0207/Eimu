import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, platformFetch, ok, fail } from "../lib/client"
import { gatewayReadSnapshot } from "../lib/canvas-flow"

// 证物链归档（2026-08-31 片1 实装）：物料清单 → 每资产来源 prompt/模型/seed/时间/
// 版本/关联 job 的归档 JSON。聚合两路：画布快照 metadata（经 gateway internal 端点，
// 轮子 canvas_get_state 同通道）+ 站点 job 记录（platformFetch GET /images/{task_id}，
// 轮子 image_get_result 同调法）。缺栏位诚实标 "missing"，不编造。

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
    "证物链归档（纯读取聚合，零扣费）。node_ids 填画布物料节点 id JSON 阵列字串（从画布快照 metadata 聚合 prompt/model/seed/时间/版本/task_id），或 urls 填资产 URL JSON 阵列字串。metadata 带 task_id 时顺带查站点 job 记录（GET /images/{id}：status/花费/结果 URL）补全证物。输出归档 JSON：每资产 provenance{prompt,model,seed,created_at,version,related_job}，缺的栏位标 \"missing\"——查不到就说查不到，绝不编造来源。合规存证/交付覆核/版本追溯用它。",
  args: {
    node_ids: tool.schema.string().optional().describe("画布节点 id 清单：JSON 阵列字串"),
    urls: tool.schema.string().optional().describe("资产 URL 清单：JSON 阵列字串"),
    include_job_records: tool.schema.boolean().optional().describe("是否查站点 job 记录补全（默认 true）"),
  },
  async execute(args, context) {
    const nodeIds: string[] = []
    const urls: string[] = []
    if (args.node_ids) {
      try {
        const j = JSON.parse(args.node_ids)
        if (Array.isArray(j)) nodeIds.push(...j.filter((x): x is string => typeof x === "string" && x.trim()))
      } catch {
        return fail("invalid_node_ids", "node_ids 必须是 JSON 阵列字串", { title: "输入非法" })
      }
    }
    if (args.urls) {
      try {
        const j = JSON.parse(args.urls)
        if (Array.isArray(j)) urls.push(...j.filter((x): x is string => typeof x === "string" && x.trim()))
      } catch {
        return fail("invalid_urls", "urls 必须是 JSON 阵列字串", { title: "输入非法" })
      }
    }
    if (!nodeIds.length && !urls.length) {
      return fail("empty_input", "node_ids 与 urls 至少填一个", { title: "输入缺失" })
    }

    const entries: Record<string, unknown>[] = []
    const warnings: string[] = []

    if (nodeIds.length) {
      const snap = await gatewayReadSnapshot(GATEWAY, context.sessionID)
      if (!snap.has_state || snap.state === null) {
        warnings.push("画布快照不可用（未上报/断线），node_ids 项全部降为 urls 级证物或标 missing")
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
        note: "直给 URL 无画布 metadata 可聚合；如需证物请用 node_ids 或带 task_id 的资产",
      })
    }

    const complete = entries.filter((e) => e.provenance && (e.missing_fields as string[]).length === 0).length

    return ok({
      title: `证物链归档：${entries.length} 项（完整 ${complete}）`,
      archived_at: new Date().toISOString(),
      entries,
      integrity_note: "missing=来源不可考，非本工具遗漏；job_record.query_failed 原因已逐项标注。",
      warnings,
    })
  },
})
