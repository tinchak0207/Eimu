import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, platformFetch, ok, fail } from "../lib/client"

// ---- 輪子來源：client.ts resolveKey（L136-170）打網關迴環的 base URL 常數與請求寫法，逐字複製 ----
const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

interface TaskEntry {
  task_id: string
  label?: string
  status: "queued" | "running" | "succeeded" | "failed"
  url?: string
  submitted_at: number
}

/**
 * 向網關迴環取本輪 session 的全部任務清單。
 * 契約（網關側 POST /internal/session-tasks，由另一 agent 同步實裝）：
 *   { ok: boolean, tasks: Array<{ task_id; label?; status; url?; submitted_at }> }
 * 端點尚未上線／網路錯 → 回空陣列，不讓工具整個炸掉。
 */
async function listTasks(sessionID: string, signal?: AbortSignal): Promise<TaskEntry[]> {
  try {
    const resp = await fetch(`${GATEWAY}/internal/session-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionID }),
      signal,
    })
    if (resp.ok) {
      const body = await resp.json().catch(() => ({}))
      if (Array.isArray(body?.tasks)) return body.tasks as TaskEntry[]
    }
  } catch {
    // gateway loopback unavailable -> empty list
  }
  return []
}

const isFullUuid = (id: string): boolean => id.length >= 36 && id.includes("-")

async function fetchOnce(id: string, context: any) {
  let resp = await platformFetch(`/images/${id}`, {}, context.sessionID, context.abort)
  let body = await resp.json().catch(() => ({}))
  // 影片作業 id 不在 /images 命名空間（404）：回落 /videos/{id}，同一把 key 同一張帳。
  // 否則已完成的影片（submit_only 提交的）永遠取不回，用戶看不到成品。
  if (resp.status === 404) {
    const vresp = await platformFetch(`/videos/${id}`, {}, context.sessionID, context.abort)
    const vbody = await vresp.json().catch(() => ({}))
    if (vresp.ok) {
      resp = vresp
      body = vbody
    }
  }
  return { resp, body }
}

/** succeeded / failed / 未就緒 三分支渲染（保留原 ok()/fail() 契約；result_not_ready 文案改為不誘導重試） */
function renderResult(body: any, id: string, correctedFrom?: string) {
  const status = body?.status || body?.data?.[0]?.status
  // 公網直鏈優先；result_url 是需 Bearer 的相對路徑（直接取 = 401），僅絕對 URL 才採用
  const absResult = typeof body?.result_url === "string" && /^https?:\/\//.test(body.result_url) ? body.result_url : undefined
  const url = body?.data?.[0]?.url || body?.data?.[0]?.videoUrl || absResult || body?.url

  if (status === "succeeded" || url) {
    return ok({
      title: "任務完成",
      url,
      cost_coins: body?.cost_coins ?? body?.x_cost_coins ?? null,
      task_id: id,
      ...(correctedFrom ? { id_corrected_from: correctedFrom } : {}),
    })
  }

  if (status === "failed") {
    return fail("generation_failed", body?.error?.message || body?.message || "生成失敗", {
      title: "生成失敗",
    })
  }

  // queued / running / pending / processing
  return fail(
    "result_not_ready",
    "任务仍在生成中，harness 会自动续接，请勿重复查询；可先处理清单里其他已就绪的任务。",
    { title: "尚未就緒" },
  )
}

export default tool({
  description:
    "查詢生圖/生影片結果（succeeded 後用，免費不扣費）。帶 task_id 查單筆；不帶 task_id 可取回本輪全部任務清單（真實 task_id 與 URL）。task_id 不完整時會依清單前綴自動糾錯。禁止憑記憶猜 ID：不確定就不帶參數先取清單。任務仍在進行時回 result_not_ready，harness 會自動續接。",
  args: {
    task_id: tool.schema.string().optional().describe("generate 回傳的任務 ID；省略則回本輪全部任務清單"),
  },
  async execute(args, context) {
    try {
      const tasks = await listTasks(context.sessionID, context.abort)
      const listNote =
        tasks.length === 0
          ? "任務清單暫不可用（網關迴環 /internal/session-tasks 未回應）。"
          : ""

      // 零參數 → 回本輪全部任務清單
      if (!args.task_id) {
        if (tasks.length === 0) {
          return fail(
            "no_tasks",
            listNote + "請以 generate 回傳的完整 task_id 查詢，或稍後重試。",
            { title: "尚無任務" },
          )
        }
        return ok({ title: "本轮任务清单", tasks })
      }

      const rawId = args.task_id
      let id = rawId
      let correctedFrom: string | undefined

      // 不像完整 UUID → 先在清單做前綴匹配糾錯
      if (!isFullUuid(id)) {
        const matches = tasks.filter(
          (t) => typeof t?.task_id === "string" && t.task_id.startsWith(id),
        )
        if (matches.length > 1) {
          return fail("ambiguous_task_id", "前缀匹配到多筆，請從清單選完整 ID", {
            title: "ID 不唯一",
            candidates: matches,
          })
        }
        if (matches.length === 1) {
          correctedFrom = id
          id = matches[0].task_id
        }
        // 0 筆 → 照原樣打平台，由下面 404 分支誠實糾錯
      }

      const { resp, body } = await fetchOnce(id, context)
      if (!resp.ok) {
        const err = await classifyError(resp, body)
        if (err.code === "task_not_found") {
          // 最後防線：以傳入 ID 前 8 碼在清單找「不一樣的」真實 ID，唯一一筆 → 自動重試一次
          const prefix = rawId.slice(0, 8)
          const matches = tasks.filter(
            (t) =>
              typeof t?.task_id === "string" &&
              t.task_id.startsWith(prefix) &&
              t.task_id !== id,
          )
          if (matches.length === 1) {
            const retry = await fetchOnce(matches[0].task_id, context)
            if (retry.resp.ok) {
              return renderResult(retry.body, matches[0].task_id, rawId)
            }
            const retryErr = await classifyError(retry.resp, retry.body)
            return fail(retryErr.code, retryErr.hint, {
              retry_after_ms: retryErr.retry_after_ms,
              title: "查詢失敗",
              tasks,
            })
          }
          // 找不到 → 把完整清單附在錯誤裡，讓模型一次糾錯而非連猜
          return fail("task_not_found", err.hint, {
            title: "查詢失敗",
            tasks,
            ...(tasks.length === 0 ? { note: listNote } : {}),
          })
        }
        return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms, title: "查詢失敗" })
      }

      return renderResult(body, id, correctedFrom)
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "查詢失敗" })
    }
  },
})
