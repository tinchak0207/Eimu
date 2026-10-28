// 测试内起的假计费平台（127.0.0.1:随机端口）。记录每个生成 POST 的原始请求，
// 供 I5 直接对「上游收到的字节」判账（不读账本实现）。
//
// 必须在被测模组之前 import：constants-gateway.ts 的 PLATFORM_BASE 是模组载入常量。
import "./env.ts"

export interface PlatformPost {
  path: string
  key: string | null
  auth: string | null
  /** 原始请求体（JSON 解析后的对象；判 Idempotency-Key / node_id 用）。 */
  body: any
}

export interface PlatformCatalogModel {
  id: string
  x_coins_per_image?: Record<string, number>
  x_coins_per_second?: Record<string, number>
  x_capabilities?: Record<string, unknown>
  x_billing?: Record<string, unknown>
}

const VIDEO_PRICES = Object.fromEntries(
  Array.from({ length: 60 }, (_, i) => [String(i + 1), Math.round(0.3 * (i + 1) * 1e6) / 1e6]),
)

/** 测试目录：图片 0.5 币/张；视频 720p 0.3 币/秒（整条价档位，与站点 billing 同形）。 */
export const CATALOG: { data: PlatformCatalogModel[] } = {
  data: [
    { id: "gpt-image-2.5-flare", x_coins_per_image: { standard: 0.5, hd: 1 } },
    {
      id: "vid-test",
      x_coins_per_second: { "720p": 0.3 },
      x_capabilities: { defaultResolution: "720p", defaultAudio: false, audio: true },
      x_billing: {
        currency: "coins",
        unit: "per_video",
        prices: { "720p": VIDEO_PRICES },
        prices_with_audio: { "720p": Object.fromEntries(Object.entries(VIDEO_PRICES).map(([k, v]) => [k, v + 0.5])) },
      },
    },
  ],
}

export type PostMode = "ok" | "reject400" | "no_task_id" | "http502"
export type TaskOutcome = "succeed" | "fail" | "hang"

const state = {
  posts: [] as PlatformPost[],
  deletes: [] as string[],
  tasksByKey: new Map<string, string>(),
  taskKinds: new Map<string, "image" | "video">(),
  taskN: new Map<string, number>(),
  polls: new Map<string, number>(),
  postMode: "ok" as PostMode,
  taskOutcome: "succeed" as TaskOutcome,
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export const platformServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const base = `http://127.0.0.1:${platformServer.port}`
    if (req.method === "GET" && url.pathname === "/v1/models") return json(CATALOG)
    if (req.method === "GET" && url.pathname === "/v1/model-status") return json({}, 404)
    if (req.method === "DELETE" && url.pathname.startsWith("/api/generation-jobs/")) {
      state.deletes.push(url.pathname.split("/").pop() || "")
      return json({ previous_status: "queued", refund: { coins: 1 } })
    }
    const gen = /^\/v1\/(images|videos)\/generations$/.exec(url.pathname)
    if (req.method === "POST" && gen) {
      const body = (await req.json().catch(() => ({}))) as any
      const key = req.headers.get("idempotency-key")
      state.posts.push({ path: url.pathname, key, auth: req.headers.get("authorization"), body })
      if (state.postMode === "reject400") return json({ error: { message: "bad size" } }, 400)
      if (state.postMode === "http502") return json({}, 502)
      if (state.postMode === "no_task_id") return json({ ok: true })
      let id = key ? state.tasksByKey.get(key) : undefined // 平台契约：同 key 回同一任务
      if (!id) {
        id = crypto.randomUUID()
        if (key) state.tasksByKey.set(key, id)
        state.taskKinds.set(id, gen[1] === "videos" ? "video" : "image")
        state.taskN.set(id, typeof body.n === "number" ? body.n : 1)
      }
      return json({ task_id: id, status: "queued" }, 202)
    }
    const poll = /^\/v1\/(images|videos)\/([0-9a-f-]{36})$/.exec(url.pathname)
    if (req.method === "GET" && poll) {
      const id = poll[2]
      const count = (state.polls.get(id) || 0) + 1
      state.polls.set(id, count)
      if (state.taskOutcome === "hang" || count < 2) return json({ status: "running" })
      if (state.taskOutcome === "fail") return json({ status: "failed", error: { message: "boom" } })
      const n = state.taskN.get(id) || 1
      const kind = state.taskKinds.get(id) === "video" ? "mp4" : "png"
      return json({
        status: "succeeded",
        cost_coins: 0.9 * n,
        data: Array.from({ length: n }, (_, i) => ({ url: `${base}/files/${id}-${i}.${kind}` })),
      })
    }
    return json({}, 404)
  },
})

process.env.PLATFORM_BASE = `http://127.0.0.1:${platformServer.port}`

export const platform = {
  posts: state.posts,
  deletes: state.deletes,
  tasksByKey: state.tasksByKey,
  polls: state.polls,
  get postMode(): PostMode {
    return state.postMode
  },
  set postMode(v: PostMode) {
    state.postMode = v
  },
  get taskOutcome(): TaskOutcome {
    return state.taskOutcome
  },
  set taskOutcome(v: TaskOutcome) {
    state.taskOutcome = v
  },
  reset(): void {
    state.posts.length = 0
    state.deletes.length = 0
    state.tasksByKey.clear()
    state.taskKinds.clear()
    state.taskN.clear()
    state.polls.clear()
    state.postMode = "ok"
    state.taskOutcome = "succeed"
  },
}

/** 违规统计：生成 POST 缺 Idempotency-Key 或 workflow.metadata.node_id 的条数。 */
export function directCallViolations(posts: readonly PlatformPost[]): PlatformPost[] {
  return posts.filter((p) => !p.key || typeof p.body?.workflow?.metadata?.node_id !== "string" || !p.body.workflow.metadata.node_id)
}
