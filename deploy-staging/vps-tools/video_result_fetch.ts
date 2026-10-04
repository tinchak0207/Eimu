import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, platformFetch, ok, fail } from "../lib/client"

// 视频作业结果查取（2026-10-02 S02 预览转存事故后立）：唯读、免费、带平台鉴权。
// 事故史：/v1/videos/<id>/result 与 /v1/videos/<id> 都要 B 端 key＋租户隔离，匿名拉取
// 一律 401——video_upload(url)/video_evidence/video_fetch(yt-dlp) 三路匿名下载全灭，
// 提交链 last_frame_video_chain 又只挂在 video-director 域，其他域拿不到成品 URL。
// 本工具用 platformFetch（与提交链同一把钥匙）即时查终态，一次 GET /videos/{id} 即回
// status＋artifacts（succeeded 时 artifacts 内含 store.tinchak0207.xyz 公网直达 URL，
// 之后全域通用：预览出卡、video_upload 转存、剪辑取材）。绝不轮询等待（等 15 镜轮询
// 曾吃满 30 分钟硬超时被杀）、绝不触发任何生成动作（零扣费）。

const MAX_JOBS = 30

function parseJobIds(raw: string): string[] {
  const s = (raw ?? "").trim()
  if (!s) return []
  try {
    const j = JSON.parse(s)
    if (Array.isArray(j)) return j.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim())
    if (typeof j === "string") return [j.trim()]
  } catch {
    // 落到逗号分隔解析
  }
  return s.split(",").map((x) => x.trim()).filter(Boolean)
}

export default tool({
  description:
    "按 job_id 查视频生成作业终态与成品公网 URL（唯读、免费、零扣费、不轮询不等待）。输入 job_ids（JSON 阵列、逗号分隔或单个 id，一次最多 30 个）。回 {task_id, status, video_url, cost_coins, error}：status ∈ queued/running/succeeded/failed/cancelled/refunded/unknown；succeeded 时 video_url 是 store.tinchak0207.xyz 公网直达 URL，可直接出预览卡、交 video_upload 转存或供剪辑取材（此 URL 匿名可达，与 result 端点不同）；failed 时带 error.code/message。要等未完成作业请稍后再查一次，本工具不会阻塞等待。",
  args: {
    job_ids: tool.schema.string().describe("视频作业 id（即提交时返回的 task_id/job_id）。支援 JSON 阵列字串、逗号分隔或单个 id，一次最多 30 个。"),
  },
  async execute(args, context) {
    const ids = parseJobIds(args.job_ids)
    if (!ids.length) return fail("bad_request", "job_ids 未解析到任何 id（接受 JSON 阵列、逗号分隔或单个 id）。")
    if (ids.length > MAX_JOBS) return fail("bad_request", `一次最多 ${MAX_JOBS} 个 job（收到 ${ids.length} 个），请分批。`)
    const results: Record<string, unknown>[] = []
    for (const id of ids) {
      const t0 = Date.now()
      try {
        const resp = await platformFetch(`/videos/${encodeURIComponent(id)}`, { method: "GET" }, context.sessionID, context.abort)
        const body = await resp.json().catch(() => ({}))
        if (!resp.ok) {
          const err = await classifyError(resp, body)
          results.push({ task_id: id, status: "lookup_error", error: `${err.code}: ${err.hint}` })
          continue
        }
        const status = typeof body?.status === "string" ? body.status : "unknown"
        const artifacts: any[] = Array.isArray(body?.data) ? body.data : []
        const videoUrl =
          artifacts.map((a) => (typeof a?.url === "string" ? a.url : null)).find((u: string | null) => !!u) ?? null
        results.push({
          task_id: id,
          status,
          ...(videoUrl ? { video_url: videoUrl } : {}),
          ...(typeof body?.cost_coins === "number" ? { cost_coins: body.cost_coins } : {}),
          ...(body?.error ? { error: body.error } : {}),
          elapsed_ms: Date.now() - t0,
        })
      } catch (e) {
        results.push({ task_id: id, status: "lookup_error", error: e instanceof Error ? e.message : String(e) })
      }
    }
    const succeeded = results.filter((r) => r.status === "succeeded").length
    const failed = results.filter((r) => r.status === "failed" || r.status === "refunded").length
    return ok({
      title: `视频作业查取：${results.length} 个（成功 ${succeeded}、失败/退款 ${failed}、其他 ${results.length - succeeded - failed}）`,
      jobs: results,
      note: "唯读查询，零扣费。succeeded 的 video_url 为公网直达 URL，可直接出卡/转存/取材。",
    })
  },
})
