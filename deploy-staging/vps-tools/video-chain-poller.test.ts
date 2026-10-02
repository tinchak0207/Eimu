// 影片作業提交後自動註冊 poller ＋ emitEvent 白名單（video.done / audio.done）行為測試。
//
// 兩條真實行為斷言：
//  1. last_frame_video_chain 的 submit_only 分支，每個提交成功的 job 都真發了一筆註冊到 poller
//     （假 poller = Bun.serve 隨機埠，收 JSON 記錄），且 kind/session_id/task_id 正確、不帶 cost_coins；
//     輪詢分支（已拿終態）則 0 筆註冊（negative）。
//  2. emitEvent 對 video.done / audio.done 真發出到 gateway，對白名單外事件（video.bogus）不發。
//
// client.ts 在模組載入時讀 process.env.POLLER_URL / GATEWAY_URL，故兩個假服務埠決定後才動態 import。
import { afterAll, describe, expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface Hit {
  path: string
  body: any
}
const gatewayHits: Hit[] = []
const pollerHits: Hit[] = []

const gatewayServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = await req.json().catch(() => null)
    gatewayHits.push({ path: new URL(req.url).pathname, body })
    return Response.json({ ok: true })
  },
})
const pollerServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = await req.json().catch(() => null)
    pollerHits.push({ path: new URL(req.url).pathname, body })
    return Response.json({ ok: true })
  },
})

process.env.GATEWAY_URL = `http://127.0.0.1:${gatewayServer.port}`
process.env.POLLER_URL = `http://127.0.0.1:${pollerServer.port}/`

// 真 client（emitEvent / registerTask 的真行為本體）。
const client: any = await import("../opencode-runtime/lib/client.ts")

// ── 工具 harness：複製既有 delivery_assets.test.ts 的沙盒法（臨時目錄 + ../lib 樁 + plugin 樁）──
const root = mkdtempSync(join(tmpdir(), "vcp-"))
mkdirSync(join(root, "tools"))
mkdirSync(join(root, "lib"))
mkdirSync(join(root, "node_modules/@opencode-ai/plugin"), { recursive: true })
writeFileSync(
  join(root, "node_modules/@opencode-ai/plugin/package.json"),
  '{"name":"@opencode-ai/plugin","exports":{"./tool":"./tool.js"}}',
)
// schema 樁須支援 min/max/int（last_frame_video_chain 的 args 全用到）。
writeFileSync(
  join(root, "node_modules/@opencode-ai/plugin/tool.js"),
  "const c=()=>({optional:()=>c(),describe:()=>c(),min:()=>c(),max:()=>c(),int:()=>c()});const t=(d)=>d;t.schema={string:c,number:c,boolean:c};export const tool=t",
)
const REAL_CLIENT = join(import.meta.dir, "..", "opencode-runtime", "lib", "client.ts")
// 樁只覆寫 platformFetch（生成提交/輪詢走注入替身），registerTask/ok/fail/classifyError 仍是真本體，
// 所以 poller 註冊與前端事件都是真行為斷言，不是原始碼字串斷言。
writeFileSync(
  join(root, "lib/client.ts"),
  `import { ok, fail, classifyError, registerTask } from ${JSON.stringify(REAL_CLIENT)}\n` +
    `export { ok, fail, classifyError, registerTask }\n` +
    `export const platformFetch = (...a: any[]) => (globalThis as any).__platformFetch(...a)\n`,
)
copyFileSync(
  join(import.meta.dir, "..", "opencode-runtime", "tools", "last_frame_video_chain.ts"),
  join(root, "tools/last_frame_video_chain.ts"),
)
const tool: any = (await import(join(root, "tools/last_frame_video_chain.ts"))).default

// ── 生成鏈替身：/models 目錄、/videos/generations 提交、/videos/{id} 輪詢 ──
let nextJob = 0
const platformCalls: Array<{ path: string; method: string; sessionID: string; body: any }> = []
;(globalThis as any).__platformFetch = async (path: string, init: any, sessionID: string) => {
  platformCalls.push({
    path,
    method: init?.method ?? "GET",
    sessionID,
    body: init?.body ? JSON.parse(init.body) : null,
  })
  if (path === "/models") {
    return Response.json({ data: [{ id: "seedance-test", x_coins_per_second: { "720": 1 } }] })
  }
  if (path === "/videos/generations") {
    nextJob += 1
    return Response.json({ task_id: `job-${nextJob}` })
  }
  if (path.startsWith("/videos/")) {
    return Response.json({ status: "succeeded", data: [{ url: "https://store.example/v.mp4" }], cost_coins: 1 })
  }
  return Response.json({})
}

const SHOTS = JSON.stringify([
  { prompt: "shot one", model: "seedance-test", duration_seconds: 5 },
  { prompt: "shot two", model: "seedance-test", duration_seconds: 5 },
])
const ctx = (sessionID: string) => ({ sessionID, abort: undefined })

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now()
  while (!pred() && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 20))
  return pred()
}

afterAll(() => {
  gatewayServer.stop(true)
  pollerServer.stop(true)
})

describe("last_frame_video_chain × poller 註冊", () => {
  test("submit_only：恰好 2 筆註冊，kind=video / session_id / task_id 對得上 / 不帶 cost_coins", async () => {
    pollerHits.length = 0
    platformCalls.length = 0
    const res = await tool.execute({ shots: SHOTS, submit_only: true, model: "seedance-test" }, ctx("sess-video-1"))
    const out = JSON.parse(res.output)
    const jobIds: string[] = out.shots.map((s: any) => s.job_id)
    expect(jobIds).toHaveLength(2)

    // registerTask 是 fire-and-forget（void），給它時間把 POST 送到假 poller。
    expect(await waitFor(() => pollerHits.length >= 2, 3000)).toBe(true)
    expect(pollerHits).toHaveLength(2)
    expect(new Set(pollerHits.map((h) => h.body.task_id))).toEqual(new Set(jobIds))
    for (const h of pollerHits) {
      expect(h.body.kind).toBe("video")
      expect(h.body.session_id).toBe("sess-video-1")
      expect(jobIds).toContain(h.body.task_id)
      expect(h.body.cost_coins).toBeUndefined()
    }
    expect(out.shots.every((s: any) => s.status === "submitted")).toBe(true)
  })

  test("負向：輪詢分支（已拿 succeeded 終態）0 筆註冊", async () => {
    pollerHits.length = 0
    platformCalls.length = 0
    const res = await tool.execute({ shots: SHOTS, submit_only: false, model: "seedance-test" }, ctx("sess-video-2"))
    // 留一段時間：若輪詢分支誤註冊，這期間就會到假 poller。
    await new Promise((r) => setTimeout(r, 300))
    expect(pollerHits).toHaveLength(0)
    const out = JSON.parse(res.output)
    expect(out.shots.every((s: any) => s.status === "succeeded")).toBe(true)
  })
})

describe("emitEvent 白名單", () => {
  test("video.done 真發出到 gateway", async () => {
    gatewayHits.length = 0
    await client.emitEvent("sess-e", "video.done", { url: "https://store.example/v.mp4" })
    expect(gatewayHits).toHaveLength(1)
    expect(gatewayHits[0].path).toBe("/internal/emit")
    expect(gatewayHits[0].body.event).toBe("video.done")
    expect(gatewayHits[0].body.session_id).toBe("sess-e")
  })

  test("audio.done 真發出到 gateway", async () => {
    gatewayHits.length = 0
    await client.emitEvent("sess-e", "audio.done", { url: "https://store.example/a.mp3" })
    expect(gatewayHits).toHaveLength(1)
    expect(gatewayHits[0].body.event).toBe("audio.done")
  })

  test("既有 image.done 仍放行（無回歸）", async () => {
    gatewayHits.length = 0
    await client.emitEvent("sess-e", "image.done", { url: "https://store.example/i.png" })
    expect(gatewayHits).toHaveLength(1)
    expect(gatewayHits[0].body.event).toBe("image.done")
  })

  test("負向：白名單外 video.bogus 不發出（白名單沒被放寬）", async () => {
    gatewayHits.length = 0
    await client.emitEvent("sess-e", "video.bogus", { url: "x" })
    expect(gatewayHits).toHaveLength(0)
  })
})
