import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, platformFetch, ok, fail } from "../lib/client"

// 視頻作業結果查取（2026-10-02 S02 預覽轉存事故後立）：唯讀、免費、帶平台鑑權。
// 事故史：/v1/videos/<id>/result 與 /v1/videos/<id> 都要 B 端 key＋租戶隔離，匿名拉取
// 一律 401——video_upload(url)/video_evidence/video_fetch(yt-dlp) 三路匿名下載全滅，
// 提交鏈 last_frame_video_chain 又只掛在 video-director 域，其他域拿不到成品 URL。
// 本工具用 platformFetch（與提交鏈同一把鑰匙）即時查終態，一次 GET /videos/{id} 即回
// status＋artifacts（succeeded 時 artifacts 內含 store.tinchak0207.xyz 公網直達 URL，
// 之後全域通用：預覽出卡、video_upload 轉存、剪輯取材）。絕不輪詢等待（等 15 鏡輪詢
// 曾吃滿 30 分鐘硬超時被殺）、絕不觸發任何生成動作（零扣費）。

const MAX_JOBS = 30

function parseJobIds(raw: string): string[] {
  const s = (raw ?? "").trim()
  if (!s) return []
  try {
    const j = JSON.parse(s)
    if (Array.isArray(j)) return j.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim())
    if (typeof j === "string") return [j.trim()]
  } catch {
    // 落到逗號分隔解析
  }
  return s.split(",").map((x) => x.trim()).filter(Boolean)
}

export default tool({
  description:
    "按 job_id 查視頻生成作業終態與成品公網 URL（唯讀、免費、零扣費、不輪詢不等待）。輸入 job_ids（JSON 陣列、逗號分隔或單個 id，一次最多 30 個）。回 {task_id, status, video_url, cost_coins, error}：status ∈ queued/running/succeeded/failed/cancelled/refunded/unknown；succeeded 時 video_url 是 store.tinchak0207.xyz 公網直達 URL，可直接出預覽卡、交 video_upload 轉存或供剪輯取材（此 URL 匿名可達，與 result 端點不同）；failed 時帶 error.code/message。要等未完成作業請稍後再查一次，本工具不會阻塞等待。",
  args: {
    job_ids: tool.schema.string().describe("視頻作業 id（即提交時返回的 task_id/job_id）。支援 JSON 陣列字串、逗號分隔或單個 id，一次最多 30 個。"),
  },
  async execute(args, context) {
    const ids = parseJobIds(args.job_ids)
    if (!ids.length) return fail("bad_request", "job_ids 未解析到任何 id（接受 JSON 陣列、逗號分隔或單個 id）。")
    if (ids.length > MAX_JOBS) return fail("bad_request", `一次最多 ${MAX_JOBS} 個 job（收到 ${ids.length} 個），請分批。`)
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
      title: `視頻作業查取：${results.length} 個（成功 ${succeeded}、失敗/退款 ${failed}、其他 ${results.length - succeeded - failed}）`,
      jobs: results,
      note: "唯讀查詢，零扣費。succeeded 的 video_url 為公網直達 URL，可直接出卡/轉存/取材。",
    })
  },
})
