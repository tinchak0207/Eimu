import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, platformFetch, ok, fail } from "../lib/client"

// ---- 轮子来源：client.ts resolveKey（L136-170）打网关回环的 base URL 常数与请求写法，逐字复制 ----
const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

interface TaskEntry {
  task_id: string
  label?: string
  status: "queued" | "running" | "succeeded" | "failed"
  url?: string
  submitted_at: number
}

/**
 * 向网关回环取本轮 session 的全部任务清单。
 * 契约（网关侧 POST /internal/session-tasks，由另一 agent 同步实装）：
 *   { ok: boolean, tasks: Array<{ task_id; label?; status; url?; submitted_at }> }
 * 端点尚未上线／网路错 → 回空阵列，不让工具整个炸掉。
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
  // 404 回落 /videos/{id}（保留：兼容旧版站点）。根因更正 2026-10-02，原假设已推翻：
  // 站点 /v1/images/{id} 与 /v1/videos/{id} 共用同一条 tenant-scoped 查询
  // (getGenerationJobForTenant(id,"biz:"+key.id) → SELECT ... WHERE id=? AND tenant_id=? LIMIT 1，
  // 无 kind 过滤)，故同一把 key 的影片 id 打 /images 一样回 200；真正的 404 来自 tenant
  // 不匹配（换了 key／fallback HARNESS_API_KEY），不是命名空间。此回落在现行站点不会被触发。
  // 本轮真正修好的那一半在 poller：成功事件名 image.done → video.done，否则 .mp4 进 <img> 变破图。
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

/** succeeded / failed / 未就绪 三分支渲染（保留原 ok()/fail() 契约；result_not_ready 文案改为不诱导重试） */
function renderResult(body: any, id: string, correctedFrom?: string) {
  const status = body?.status || body?.data?.[0]?.status
  // 公网直链优先；result_url 是需 Bearer 的相对路径（直接取 = 401），仅绝对 URL 才采用
  const absResult = typeof body?.result_url === "string" && /^https?:\/\//.test(body.result_url) ? body.result_url : undefined
  const url = body?.data?.[0]?.url || body?.data?.[0]?.videoUrl || absResult || body?.url

  if (status === "succeeded" || url) {
    return ok({
      title: "任务完成",
      url,
      cost_coins: body?.cost_coins ?? body?.x_cost_coins ?? null,
      task_id: id,
      ...(correctedFrom ? { id_corrected_from: correctedFrom } : {}),
    })
  }

  if (status === "failed") {
    return fail("generation_failed", body?.error?.message || body?.message || "生成失败", {
      title: "生成失败",
    })
  }

  // queued / running / pending / processing
  return fail(
    "result_not_ready",
    "任务仍在生成中，harness 会自动续接，请勿重复查询；可先处理清单里其他已就绪的任务。",
    { title: "尚未就绪" },
  )
}

export default tool({
  description:
    "查询生图/生影片结果（succeeded 后用，免费不扣费）。带 task_id 查单笔；不带 task_id 可取回本轮全部任务清单（真实 task_id 与 URL）。task_id 不完整时会依清单前缀自动纠错。禁止凭记忆猜 ID：不确定就不带参数先取清单。任务仍在进行时回 result_not_ready，harness 会自动续接。",
  args: {
    task_id: tool.schema.string().optional().describe("generate 回传的任务 ID；省略则回本轮全部任务清单"),
  },
  async execute(args, context) {
    try {
      const tasks = await listTasks(context.sessionID, context.abort)
      const listNote =
        tasks.length === 0
          ? "任务清单暂不可用（网关回环 /internal/session-tasks 未回应）。"
          : ""

      // 零参数 → 回本轮全部任务清单
      if (!args.task_id) {
        if (tasks.length === 0) {
          return fail(
            "no_tasks",
            listNote + "请以 generate 回传的完整 task_id 查询，或稍后重试。",
            { title: "尚无任务" },
          )
        }
        return ok({ title: "本轮任务清单", tasks })
      }

      const rawId = args.task_id
      let id = rawId
      let correctedFrom: string | undefined

      // 不像完整 UUID → 先在清单做前缀匹配纠错
      if (!isFullUuid(id)) {
        const matches = tasks.filter(
          (t) => typeof t?.task_id === "string" && t.task_id.startsWith(id),
        )
        if (matches.length > 1) {
          return fail("ambiguous_task_id", "前缀匹配到多笔，请从清单选完整 ID", {
            title: "ID 不唯一",
            candidates: matches,
          })
        }
        if (matches.length === 1) {
          correctedFrom = id
          id = matches[0].task_id
        }
        // 0 笔 → 照原样打平台，由下面 404 分支诚实纠错
      }

      const { resp, body } = await fetchOnce(id, context)
      if (!resp.ok) {
        const err = await classifyError(resp, body)
        if (err.code === "task_not_found") {
          // 最后防线：以传入 ID 前 8 码在清单找「不一样的」真实 ID，唯一一笔 → 自动重试一次
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
              title: "查询失败",
              tasks,
            })
          }
          // 找不到 → 把完整清单附在错误里，让模型一次纠错而非连猜
          return fail("task_not_found", err.hint, {
            title: "查询失败",
            tasks,
            ...(tasks.length === 0 ? { note: listNote } : {}),
          })
        }
        return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms, title: "查询失败" })
      }

      return renderResult(body, id, correctedFrom)
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "查询失败" })
    }
  },
})
