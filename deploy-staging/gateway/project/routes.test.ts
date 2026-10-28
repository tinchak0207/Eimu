// S9 路由与工具契约测试（真实 store + 临时 WORKSPACE_DIR；执行器/价目/上游全为 fake）。
// 判准：三种 view 的回执形状与字节上限、wait_sec 早返回、patch 走 Actor=user、非工程会话 context 404、
// 内部 token 缺失 403、他人会话 404、dry_run 不调执行器、启动恢复用同 idemKey（fake 计数）。
// 另含三工具 schema 与 contract-fixtures.json 的双向往返（工具 schema 由运行时同一 zod 实例校验）。
import { afterAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = mkdtempSync(join(tmpdir(), "pg-s9-routes-"))
const TOKEN = "s9-test-token"
process.env.HARNESS_INTERNAL_TOKEN = TOKEN
// 子会话身份解析（byChildOc / recentChildParent TTL / generation_consumers 耐久绑定）要一个可写的库。
process.env.SESSIONS_DB_PATH = join(ROOT, "sessions.db")

const routes = await import("./routes.ts")
const { ensureProject } = await import("./store.ts")
const { registerExecutor, clearExecutors } = await import("./executor-registry.ts")
const { computeSignature } = await import("./signature.ts")
const { NODE_SPECS_LITE } = await import("./specs.ts")
const { idempotencyKeyOf } = await import("./submit-generation.ts")
const { reopenSessionsDbForTest } = await import("../job-store.ts")
reopenSessionsDbForTest()
const { resetCatalogCacheForTest } = await import("../pricing-gateway.ts")
resetCatalogCacheForTest()
const { LIMITS } = await import("./constants.ts")

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8")

let workDir = ""
let seq = 0

beforeEach(() => {
  workDir = mkdtempSync(join(ROOT, "w-"))
  process.env.WORKSPACE_DIR = workDir
  routes.resetProjectStores()
  clearExecutors()
})

afterAll(() => {
  // 临时目录整体删除（mock 全在内存，无遗留服务）。
  import("node:fs").then(({ rmSync }) => rmSync(ROOT, { recursive: true, force: true }))
})

function nextSession(tag: string): string {
  seq += 1
  return `s9_${tag}_${seq}`
}

function makeState(sessionId: string, over: Record<string, unknown> = {}): any {
  return {
    sessionId,
    apiKey: "sk-test",
    opencodeSessionId: `oc-${sessionId}`,
    pendingConfirms: new Map(),
    resolvedConfirms: new Map(),
    pendingQuestions: new Map(),
    projectMode: true,
    ...over,
  }
}

interface CallLog {
  submits: unknown[]
  ledger: unknown[]
}

function makeDeps(state: any, log: CallLog): any {
  return {
    session: state,
    ledger: { write: async (e: unknown) => { log.ledger.push(e) } },
    submitGeneration: async (req: unknown) => {
      log.submits.push(req)
      return { ok: true, taskId: "task-1", urls: [], costCoins: 0, requestId: "req-1", executedModel: "m" }
    },
    execBridge: {
      call: async () => ({ ok: false, code: "bridge_unavailable", message: "fake bridge", retryable: false }),
      result: async () => ({ state: "unknown" }),
    },
    now: () => new Date(),
  }
}

function installHost(state: any, log: CallLog, over: Partial<Parameters<typeof routes.configureProjectRoutes>[0]> = {}): () => void {
  return routes.configureProjectRoutes({
    owned: (key: string, id: string) => (key === "sk-owner" && id === state.sessionId ? state : undefined),
    state: (id: string) => (id === state.sessionId ? state : undefined),
    actor: () => ({ kind: "agent" }) as any,
    deps: () => makeDeps(state, log),
    confirm: () => ({ request: async () => "approved", status: async () => "approved" }) as any,
    authorized: async () => true,
    ...over,
  })
}

function internal(pathname: string, body: unknown, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers["x-internal-token"] = token
  return routes.handleProjectInternal(
    new Request(`http://127.0.0.1${pathname}`, { method: "POST", headers, body: JSON.stringify(body) }),
    pathname,
  )
}

function publicRoute(key: string, sid: string, method: string, suffix = "", body?: unknown): Promise<Response> {
  const [tail, query] = suffix.split("?")
  const pathname = `/agent/v1/sessions/${sid}/project${tail}`
  const url = `http://127.0.0.1${pathname}${query !== undefined ? `?${query}` : ""}`
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" }
    init.body = JSON.stringify(body)
  }
  return routes.handleProjectSessionRoute(key, sid, new Request(url, init), pathname)
}

async function projectWithNodes(sid: string, nodes: Array<Record<string, unknown>>): Promise<any> {
  const { store } = await ensureProject(sid)
  if (nodes.length) {
    const res = await store.applyPatches({ ops: nodes.map((node) => ({ op: "add_node", node })) as never }, { kind: "agent" })
    expect(res.receipt.ok).toBe(true)
  }
  return store
}

function fakeKeyframe(run: (ctx: any) => Promise<unknown>, estimate = 2): void {
  registerExecutor({
    type: "keyframe",
    specVersion: NODE_SPECS_LITE.keyframe.specVersion,
    estimate: async () => estimate,
    run: run as never,
  })
}

const OK_OUTPUT = {
  port: "out",
  artifactId: `art_${"a".repeat(16)}`,
  sha256: "a".repeat(64),
  path: "/tmp/fake.png",
  mime: "image/png",
  bytes: 1,
  origin: "generated" as const,
}

describe("内部路由鉴权与 context", () => {
  test("内部 token 缺失 → 403", async () => {
    const sid = nextSession("token")
    const state = makeState(sid)
    installHost(state, { submits: [], ledger: [] })
    const res = await internal("/internal/project/context", { session_id: sid, messages: [] }, null)
    expect(res.status).toBe(403)
  })

  test("非工程会话 / 工程不存在 → 404（插件回旧路径）", async () => {
    const sid = nextSession("ctx404")
    const restore = installHost(makeState(sid, { projectMode: false }), { submits: [], ledger: [] })
    try {
      const res = await internal("/internal/project/context", { session_id: sid, messages: [] })
      expect(res.status).toBe(404)
      expect((await res.json() as any).error.code).toBe("not_project_session")
    } finally {
      restore()
    }
    // projectMode=true 但工程目录不存在 → 也是 404
    const sid2 = nextSession("ctx404b")
    const restore2 = installHost(makeState(sid2), { submits: [], ledger: [] })
    try {
      const res = await internal("/internal/project/context", { session_id: sid2, messages: [] })
      expect(res.status).toBe(404)
      expect((await res.json() as any).error.code).toBe("project_not_found")
    } finally {
      restore2()
    }
  })

  test("工程会话 context 回 projectContextResponse 的 snake_case 形状", async () => {
    const sid = nextSession("ctx")
    await projectWithNodes(sid, [{ id: "k1", type: "keyframe", params: { prompt: "雨夜站台" } }])
    const restore = installHost(makeState(sid), { submits: [], ledger: [] })
    try {
      const res = await internal("/internal/project/context", {
        session_id: sid,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "做一支咖啡广告" }] }],
      })
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.project_mode).toBe(true)
      for (const key of ["keep_ids", "synthetic", "replacements", "drop_parts", "steps", "bytes", "tokens"]) {
        expect(key in body).toBe(true)
      }
      expect(body.keep_ids).toContain("m1")
      expect(String(body.synthetic)).toContain("状态计数")
    } finally {
      restore()
    }
  })

  test("context 的 synthetic 承接授权模式/环境可用性/最近事件（S14 停注入后不再有第二来源）", async () => {
    const sid = nextSession("ctxd")
    const store = await projectWithNodes(sid, [{ id: "k1", type: "keyframe", params: { prompt: "雨夜站台" } }])
    await store.appendEvents([{ kind: "node_status", node: "k1", data: { status: "running" } }])
    const restore = installHost(makeState(sid), { submits: [], ledger: [] }, { authorized: async () => true })
    try {
      const res = await internal("/internal/project/context", {
        session_id: sid,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "继续把 k1 跑完" }] }],
      })
      expect(res.status).toBe(200)
      const synthetic = String(((await res.json()) as any).synthetic)
      // 授权事实：没有 digestInputs 时这一段只有预算行，不会出现「授权 …」后缀。
      expect(synthetic).toContain("## 预算与授权")
      expect(synthetic).toContain("授权 auto/full：持续授权")
      // 环境事实：没有 digestInputs 时是「（未上报）」。
      expect(synthetic).toContain("## 环境可用性")
      expect(synthetic).toContain("exec-bridge")
      expect(synthetic).not.toContain("（未上报）")
      // 最近事件：读自 events.jsonl。
      expect(synthetic).toContain("## 最近事件")
      expect(synthetic).toContain("k1")
    } finally {
      restore()
    }
  })

  test("context 的授权段随 authorized 判定变化（非持续授权＝逐次确认）", async () => {
    const sid = nextSession("ctxa")
    await projectWithNodes(sid, [{ id: "k1", type: "keyframe", params: { prompt: "雨夜站台" } }])
    const restore = installHost(makeState(sid), { submits: [], ledger: [] }, { authorized: async () => false })
    try {
      const res = await internal("/internal/project/context", {
        session_id: sid,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "继续" }] }],
      })
      const synthetic = String(((await res.json()) as any).synthetic)
      expect(synthetic).toContain("逐次确认")
      expect(synthetic).not.toContain("授权 auto/full")
    } finally {
      restore()
    }
  })
})

describe("GET 三种 view", () => {
  test("digest/node/events 回执形状与字节上限", async () => {
    const sid = nextSession("get")
    const store = await projectWithNodes(sid, [
      { id: "k1", type: "keyframe", params: { prompt: "第一帧" } },
      { id: "k2", type: "keyframe", params: { prompt: "第二帧" } },
    ])
    await store.appendEvents([{ kind: "node_status", node: "k1", data: { status: "running" } }])
    const restore = installHost(makeState(sid), { submits: [], ledger: [] })
    try {
      const digest = await (await internal("/internal/project/get", { session_id: sid, view: "digest" })).json() as any
      expect(digest.ok).toBe(true)
      expect(typeof digest.version).toBe("number")
      expect(typeof digest.cursor).toBe("number")
      expect(typeof digest.digest).toBe("string")
      expect(digest.digest).toContain("状态计数")
      expect(bytes(digest)).toBeLessThanOrEqual(LIMITS.DIGEST_BYTES)

      const node = await (await internal("/internal/project/get", { session_id: sid, view: "node", node: "k1" })).json() as any
      expect(node.ok).toBe(true)
      expect(node.node.id).toBe("k1")
      expect(node.node.type).toBe("keyframe")
      expect(node.node.params.prompt).toBe("第一帧")
      expect(bytes(node)).toBeLessThanOrEqual(LIMITS.NODE_VIEW_BYTES)

      const events = await (await internal("/internal/project/get", { session_id: sid, view: "events", since: 0 })).json() as any
      expect(events.ok).toBe(true)
      expect(Array.isArray(events.events)).toBe(true)
      expect(events.events.length).toBeLessThanOrEqual(20)
      expect(events.events.some((line: string) => /^#\d+ node_status k1 status=running$/.test(line))).toBe(true)
      expect(bytes(events)).toBeLessThanOrEqual(LIMITS.EVENTS_BYTES)

      // 公开 GET（会话主人）同样回 digest，并按 query 支持 node 视图
      const pub = await publicRoute("sk-owner", sid, "GET")
      expect(pub.status).toBe(200)
      expect(((await pub.json()) as any).digest).toContain("状态计数")
      const pubNode = await publicRoute("sk-owner", sid, "GET", "?view=node&node=k2")
      const pubNodeBody = await pubNode.json() as any
      expect(pubNodeBody.node.id).toBe("k2")
      expect(pubNodeBody.node.params.prompt).toBe("第二帧")
    } finally {
      restore()
    }
  })

  test("wait_sec 事件到达即返回（不睡满）", async () => {
    const sid = nextSession("wait")
    const store = await projectWithNodes(sid, [{ id: "k1", type: "keyframe", params: { prompt: "x" } }])
    const restore = installHost(makeState(sid), { submits: [], ledger: [] })
    try {
      const before = await (await internal("/internal/project/get", { session_id: sid, view: "events", since: 0 })).json() as any
      const started = Date.now()
      const pending = internal("/internal/project/get", { session_id: sid, view: "events", since: before.cursor, wait_sec: 5 })
      await new Promise((r) => setTimeout(r, 300))
      await store.appendEvents([{ kind: "node_status", node: "k1", data: { status: "done" } }])
      const res = await (await pending).json() as any
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(4000)
      expect(res.events.length).toBeGreaterThanOrEqual(1)
      expect(res.cursor).toBeGreaterThan(before.cursor)
    } finally {
      restore()
    }
  })

  test("wait_sec 超过 90 被钳制（不拒绝请求、只缩短等待）", async () => {
    expect(routes.clampWaitSec(5000)).toBe(90)
    expect(routes.clampWaitSec(90)).toBe(90)
    expect(routes.clampWaitSec(60.9)).toBe(60)
    expect(routes.clampWaitSec(0)).toBe(0)
    expect(routes.clampWaitSec(-5)).toBe(0)
    expect(routes.clampWaitSec("30")).toBe(0)
  })
})

describe("PATCH 鉴权与 Actor", () => {
  test("公开 patch 走 Actor=user；内部 patch 同一 op 被 ACTOR_FORBIDDEN", async () => {
    const sid = nextSession("patch")
    const store = await projectWithNodes(sid, [
      { id: "k1", type: "keyframe", params: { prompt: "a" } },
      { id: "k2", type: "keyframe", params: { prompt: "b" } },
    ])
    const art = await store.artifacts.putBytes("png-bytes", { port: "out", origin: "user", ext: ".png" })
    const restore = installHost(makeState(sid), { submits: [], ledger: [] })
    try {
      const res = await publicRoute("sk-owner", sid, "POST", "/patch", { ops: [{ op: "replace_output", node: "k1", artifactId: art.artifactId }] })
      expect(res.status).toBe(200)
      const receipt = await res.json() as any
      expect(receipt.ok).toBe(true)
      expect(bytes(receipt)).toBeLessThanOrEqual(LIMITS.PATCH_RECEIPT_BYTES)
      // replace_output 仅 Actor=user 可用：公开面成功本身证明 Actor=user（内部 agent 面同一 op 下面被拒）。
      const view = await (await internal("/internal/project/get", { session_id: sid, view: "node", node: "k1" })).json() as any
      expect(view.node.pinned).toBe(true)
      expect(view.node.status).toBe("done")

      const denied = await (await internal("/internal/project/patch", {
        session_id: sid,
        ops: [{ op: "replace_output", node: "k2", artifactId: art.artifactId }],
      })).json() as any
      expect(denied.ok).toBe(false)
      expect(denied.rejected[0].code).toBe("ACTOR_FORBIDDEN")
    } finally {
      restore()
    }
  })

  test("他人会话 → 404", async () => {
    const sid = nextSession("own")
    await projectWithNodes(sid, [])
    const restore = installHost(makeState(sid), { submits: [], ledger: [] })
    try {
      const res = await publicRoute("sk-someone-else", sid, "GET")
      expect(res.status).toBe(404)
    } finally {
      restore()
    }
  })

  test("满量补丁回执 ≤1024B", async () => {
    const sid = nextSession("feereceipt")
    await projectWithNodes(sid, [])
    const restore = installHost(makeState(sid), { submits: [], ledger: [] })
    try {
      const ops = Array.from({ length: 60 }, (_, i) => ({ op: "add_node", node: { id: `n${i}`, type: "keyframe", params: { prompt: `p${i}` } } }))
      const receipt = await (await internal("/internal/project/patch", { session_id: sid, ops })).json() as any
      expect(receipt.ok).toBe(true)
      expect(receipt.changed.length).toBeLessThanOrEqual(12)
      expect(bytes(receipt)).toBeLessThanOrEqual(LIMITS.PATCH_RECEIPT_BYTES)
    } finally {
      restore()
    }
  })
})

describe("子代理 Actor 与 lane（真 applyPatch，不 mock 引擎）", () => {
  /** 子会话 opcode id → 父 state；actor 不覆盖 = 走生产的 defaultActor 解析。 */
  function installChildHost(parentState: any, childOcId: string, log: CallLog): () => void {
    return routes.configureProjectRoutes({
      owned: (key: string, id: string) => (key === "sk-owner" && (id === parentState.sessionId || id === childOcId) ? parentState : undefined),
      state: (id: string) => (id === parentState.sessionId || id === childOcId ? parentState : undefined),
      deps: () => makeDeps(parentState, log),
      confirm: () => ({ request: async () => "approved", status: async () => "approved" }) as any,
      authorized: async () => true,
    })
  }

  const patch = (sessionId: string, body: Record<string, unknown>) => internal("/internal/project/patch", { session_id: sessionId, ...body })

  test("lane 内可写、越界 LANE_VIOLATION；空 lane 只读；主席位 agent；请求体伪造身份被忽略", async () => {
    const sid = nextSession("lane")
    const store = await projectWithNodes(sid, [
      { id: "sl1", type: "shotlist", params: { kind: "shots", rows: [] } },
      { id: "sl2", type: "shotlist", params: { kind: "shots", rows: [] } },
      { id: "k1", type: "keyframe", params: { prompt: "x" } },
    ])
    const parent = makeState(sid)
    const child = `oc-child-${sid}`
    const { byChildOc } = await import("../subagent-runs.ts")
    const restore = installChildHost(parent, child, { submits: [], ledger: [] })
    const setOn = (node: string, value: string) => ({ ops: [{ op: "set", node, path: "intent", value }] })
    try {
      // S16 派工时写入的 run.lane = ["sl1"]
      byChildOc.set(child, { id: "sub_1", lane: ["sl1"] } as any)

      // lane 内：write_result / set 都成功
      const wr = await (await patch(child, { ops: [{ op: "write_result", node: "sl1", value: { kind: "shots", rows: [{ id: "r1" }] } }] })).json() as any
      expect(wr.ok).toBe(true)
      const inside = await (await patch(child, setOn("sl1", "镜头表"))).json() as any
      expect(inside.ok).toBe(true)
      expect(inside.applied).toBe(1)

      // 越界：同类型的 sl2、以及别的类型 k1 → LANE_VIOLATION
      const outside = await (await patch(child, setOn("sl2", "越界"))).json() as any
      expect(outside.ok).toBe(false)
      expect(outside.rejected[0].code).toBe("LANE_VIOLATION")
      const otherType = await (await patch(child, { ops: [{ op: "write_result", node: "k1", value: { text: "x" } }] })).json() as any
      expect(otherType.rejected[0].code).toBe("LANE_VIOLATION")

      // 空 lane = 只读：任何写都被拒
      byChildOc.set(child, { id: "sub_1", lane: [] } as any)
      const empty = await (await patch(child, setOn("sl1", "只读"))).json() as any
      expect(empty.rejected[0].code).toBe("LANE_VIOLATION")

      // 请求体伪造 lane 不能放行（身份只由网关解析）
      const forgedLane = await (await patch(child, { ...setOn("sl1", "伪造"), lane: ["sl1"], actor: { kind: "user" } })).json() as any
      expect(forgedLane.rejected[0].code).toBe("LANE_VIOLATION")

      // 主席位（byChildOc 无记录）= agent：照常可写，请求体 lane 不影响
      byChildOc.delete(child)
      const main = await (await patch(sid, { ...setOn("k1", "主代理写入"), lane: ["sl1"] })).json() as any
      expect(main.ok).toBe(true)

      // 伪造 actor:"user" 不能提权：replace_output 仍是 ACTOR_FORBIDDEN（agent）
      const art = await store.artifacts.putBytes("lane-png", { port: "out", origin: "user", ext: ".png" })
      const forgedActor = await (await patch(sid, {
        actor: { kind: "user" },
        ops: [{ op: "replace_output", node: "k1", artifactId: art.artifactId }],
      })).json() as any
      expect(forgedActor.ok).toBe(false)
      expect(forgedActor.rejected[0].code).toBe("ACTOR_FORBIDDEN")
    } finally {
      byChildOc.delete(child)
      restore()
    }
  })

  test("收尾后的子会话仍只读（byChildOc 已删、TTL 记录在）→ LANE_VIOLATION，绝不升格主席位", async () => {
    const sid = nextSession("late")
    await projectWithNodes(sid, [
      { id: "sl1", type: "shotlist", params: { kind: "shots", rows: [] } },
      { id: "k1", type: "keyframe", params: { prompt: "x" } },
    ])
    const parent = makeState(sid)
    const child = `oc-late-${sid}`
    const { byChildOc, rememberChildParent, subagentMailboxMemberName, subagentParentState } = await import("../subagent-runs.ts")
    const restore = installChildHost(parent, child, { submits: [], ledger: [] })
    const setOn = (node: string, value: string) => ({ ops: [{ op: "set", node, path: "intent", value }] })
    try {
      // S16 派工时写 recentChildParent（TTL 2h）+ generation_consumers 耐久行；run 收尾把 byChildOc 删掉。
      rememberChildParent(child, {
        id: "sub_late",
        parentGatewaySessionId: sid,
        parentOpencodeSessionId: parent.opencodeSessionId,
        opencodeSessionId: child,
        agent: "editor",
        mailboxName: "editor",
      } as any)
      expect(byChildOc.has(child)).toBe(false)

      // 迟到的工具调用：任意节点写都必须回 LANE_VIOLATION（不是 ACTOR_FORBIDDEN，更不能成功）。
      const late = await (await patch(child, setOn("sl1", "迟到写"))).json() as any
      expect(late.ok).toBe(false)
      expect(late.rejected[0].code).toBe("LANE_VIOLATION")
      const lateKf = await (await patch(child, setOn("k1", "迟到写"))).json() as any
      expect(lateKf.rejected[0].code).toBe("LANE_VIOLATION")

      // TTL 过期：recentChildParent 被 lazy prune（独立 oracle：邮箱身份变 null）。
      setSystemTime(new Date(Date.now() + 3 * 60 * 60 * 1000))
      subagentParentState(child)
      expect(subagentMailboxMemberName(child)).toBe(null)
      // 耐久 consumer 绑定仍在：继续只读（比只靠 TTL 更严，不会中途升格）。
      const afterTtl = await (await patch(child, setOn("sl1", "TTL 后"))).json() as any
      expect(afterTtl.rejected[0].code).toBe("LANE_VIOLATION")

      // 耐久行也消失（模拟库清理）→ 该 id 不再是已知子会话，回落 agent。
      const { Database } = await import("bun:sqlite")
      const db = new Database(process.env.SESSIONS_DB_PATH as string)
      db.query("DELETE FROM generation_consumers WHERE child_oc = ?").run(child)
      db.close()
      const freed = await (await patch(child, setOn("sl1", "无绑定"))).json() as any
      expect(freed.ok).toBe(true)
      expect(freed.applied).toBe(1)
    } finally {
      setSystemTime()
      byChildOc.delete(child)
      restore()
    }
  })
})

describe("RUN 准入与执行", () => {
  test("dry_run 只报价，不调执行器", async () => {
    const sid = nextSession("dryrun")
    await projectWithNodes(sid, [{ id: "k1", type: "keyframe", params: { prompt: "x" } }])
    let runs = 0
    fakeKeyframe(async () => { runs += 1; return { ok: true, outputs: [OK_OUTPUT], costCoins: 2 } }, 2)
    const restore = installHost(makeState(sid), { submits: [], ledger: [] })
    try {
      const receipt = await (await internal("/internal/project/run", { session_id: sid, dry_run: true })).json() as any
      expect(receipt.status).toBe("quoted")
      expect(receipt.quote.coins).toBe(2)
      expect(receipt.quote.run).toBe(1)
      expect(runs).toBe(0)
      expect(bytes(receipt)).toBeLessThanOrEqual(LIMITS.RUN_RECEIPT_BYTES)
    } finally {
      restore()
    }
  })

  test("project_patch 写入 capCoins 后，跨轮已花费超限不再调用执行；未超限仍跑", async () => {
    const sid = nextSession("cap")
    await projectWithNodes(sid, [{ id: "k1", type: "keyframe", params: { prompt: "x", model: "m" } }])
    let runs = 0
    fakeKeyframe(async () => { runs += 1; return { ok: true, outputs: [OK_OUTPUT], costCoins: 2 } }, 2)
    const { createProjectBudget } = await import("./ledger.ts")
    const budget = createProjectBudget({ capOf: async () => null })
    const log = { submits: [] as unknown[], ledger: [] as unknown[] }
    const restore = installHost(makeState(sid), log, {
      deps: () => ({ ...makeDeps(makeState(sid), log), budget }),
    })
    try {
      const patched = await (await internal("/internal/project/patch", {
        session_id: sid,
        ops: [{ op: "set", node: "k1", path: "budget.capCoins", value: 3 }],
      })).json() as { ok?: boolean }
      expect(patched.ok).toBe(true)
      const { openProject } = await import("./store.ts")
      expect((await (await openProject(sid)).read()).budget.capCoins).toBe(3)
      const first = await (await internal("/internal/project/run", { session_id: sid, mode: "force", wait_sec: 10 })).json() as { status?: string }
      expect(first.status).toBe("done")
      expect(runs).toBe(1)
      const second = await (await internal("/internal/project/run", { session_id: sid, mode: "force", wait_sec: 10 })).json() as { status?: string; reason?: string }
      expect(second.status).toBe("rejected")
      expect(second.reason ?? "").toContain("预算不足")
      expect(runs).toBe(1)
    } finally {
      restore()
    }
  })

  test("未设 capCoins 的运行仍发得出去", async () => {
    const sid = nextSession("nocap")
    await projectWithNodes(sid, [{ id: "k1", type: "keyframe", params: { prompt: "x", model: "m" } }])
    let runs = 0
    fakeKeyframe(async () => { runs += 1; return { ok: true, outputs: [OK_OUTPUT], costCoins: 2 } }, 2)
    const { createProjectBudget } = await import("./ledger.ts")
    const budget = createProjectBudget({ capOf: async () => null })
    const log = { submits: [] as unknown[], ledger: [] as unknown[] }
    const restore = installHost(makeState(sid), log, {
      deps: () => ({ ...makeDeps(makeState(sid), log), budget }),
    })
    try {
      const receipt = await (await internal("/internal/project/run", { session_id: sid, wait_sec: 10 })).json() as { status?: string }
      expect(receipt.status).toBe("done")
      expect(runs).toBe(1)
    } finally {
      restore()
    }
  })

  test("实跑走 fake 执行器并回 done；回执 ≤1024B", async () => {
    const sid = nextSession("run")
    await projectWithNodes(sid, [{ id: "k1", type: "keyframe", params: { prompt: "x" } }])
    let runs = 0
    fakeKeyframe(async () => { runs += 1; return { ok: true, outputs: [OK_OUTPUT], costCoins: 2 } }, 2)
    const restore = installHost(makeState(sid), { submits: [], ledger: [] })
    try {
      const receipt = await (await internal("/internal/project/run", { session_id: sid, wait_sec: 10 })).json() as any
      expect(receipt.status).toBe("done")
      expect(receipt.done).toBe(1)
      expect(runs).toBe(1)
      expect(bytes(receipt)).toBeLessThanOrEqual(LIMITS.RUN_RECEIPT_BYTES)
    } finally {
      restore()
    }
  })

  test("崩溃遗留的 activeRun 不再挡死后续 run", async () => {
    const sid = nextSession("stale")
    const store = await projectWithNodes(sid, [{ id: "k1", type: "keyframe", params: { prompt: "x" } }])
    await store.update((g) => { g.activeRun = "pg_deadbeef" })
    let runs = 0
    fakeKeyframe(async () => { runs += 1; return { ok: true, outputs: [OK_OUTPUT], costCoins: 0 } }, 1)
    const restore = installHost(makeState(sid), { submits: [], ledger: [] })
    try {
      const receipt = await (await internal("/internal/project/run", { session_id: sid, wait_sec: 10 })).json() as any
      expect(receipt.status).toBe("done")
      expect(runs).toBe(1)
    } finally {
      restore()
    }
  })

  test("大批失败时 run 回执仍 ≤1024B（failed 列表被截断）", async () => {
    const sid = nextSession("runbig")
    const side = (i: number) => `node_${"x".repeat(40)}_${i}`
    const nodes = Array.from({ length: 40 }, (_, i) => ({ id: side(i), type: "keyframe", params: { prompt: `p${i}` } }))
    await projectWithNodes(sid, nodes)
    fakeKeyframe(async () => ({ ok: false, code: "provider_error", message: "fake upstream failed", retryable: false }), 1)
    const restore = installHost(makeState(sid), { submits: [], ledger: [] })
    try {
      const receipt = await (await internal("/internal/project/run", { session_id: sid, wait_sec: 20 })).json() as any
      expect(receipt.status).toBe("failed")
      expect(receipt.failed.length).toBeLessThan(40)
      expect(bytes(receipt)).toBeLessThanOrEqual(LIMITS.RUN_RECEIPT_BYTES)
    } finally {
      restore()
    }
  }, 30_000)
})

describe("确认卡（非阻塞）", () => {
  test("request 立即回 pending，不 await 用户；答复后重入拿 approved", async () => {
    const state = makeState("s9_confirm", { eventCounter: 0, replayBuffer: [], clients: new Set() })
    const port = routes.projectConfirmPort(state)
    const started = Date.now()
    const first = await port.request({ sessionId: state.sessionId, requestId: "pgrun_abc", amountCoins: 42, description: "工程报价" })
    expect(first).toBe("pending")
    expect(Date.now() - started).toBeLessThan(500)
    expect(state.pendingConfirms.has("pgrun_abc")).toBe(true)
    expect(await port.status!("pgrun_abc")).toBe("pending")

    // 模拟用户答复（settleConfirm 的状态迁移；计费副作用不在本测范围）：
    clearTimeout(state.pendingConfirms.get("pgrun_abc").timer)
    state.pendingConfirms.delete("pgrun_abc")
    state.resolvedConfirms.set("pgrun_abc", { outcome: "approved", resolvedAt: Date.now() })
    expect(await port.status!("pgrun_abc")).toBe("approved")
    // 同一 requestId 重入：复用上次答复，不重弹卡
    expect(await port.request({ sessionId: state.sessionId, requestId: "pgrun_abc", amountCoins: 42, description: "工程报价" })).toBe("approved")
  })
})

describe("启动恢复（同 idemKey，不盲重投）", () => {
  test("inflight key 与当前签名一致 → 用同一 key 重提交一次", async () => {
    const sid = nextSession("recover")
    const store = await projectWithNodes(sid, [{ id: "k1", type: "keyframe", params: { prompt: "x" } }])
    const g = await store.read()
    const sig = await computeSignature(g, "k1", store.artifacts, NODE_SPECS_LITE)
    expect(sig.ok).toBe(true)
    const signature = (sig as unknown as { signature: string }).signature
    const inflightKey = idempotencyKeyOf({ projectId: sid, signature, take: 0, attempt: 0 })
    await store.update((gg) => {
      const n = gg.nodes.k1
      n.status = "running"
      n.inflight = { idemKey: inflightKey, since: "2026-10-28T00:00:00.000Z" }
    })

    const seen: string[] = []
    fakeKeyframe(async (ctx: any) => {
      seen.push(idempotencyKeyOf({ projectId: ctx.project.id, signature: ctx.signature, take: ctx.take, attempt: ctx.attempt }))
      return { ok: true, outputs: [OK_OUTPUT], costCoins: 0 }
    }, 1)
    const state = makeState(sid)
    routes.resetProjectStores()
    const out = await routes.recoverAllProjects(() => makeDeps(state, { submits: [], ledger: [] }))
    const mine = out.find((o) => o.sessionId === sid)
    expect(mine?.outcome?.resumed[0]?.result).toBe("done")
    expect(seen).toEqual([inflightKey])
  })

  test("图已变（key 不再匹配）→ 转人工，不重投", async () => {
    const sid = nextSession("recover2")
    const store = await projectWithNodes(sid, [{ id: "k1", type: "keyframe", params: { prompt: "x" } }])
    const g = await store.read()
    const sig = await computeSignature(g, "k1", store.artifacts, NODE_SPECS_LITE)
    const signature = (sig as unknown as { signature: string }).signature
    const staleKey = idempotencyKeyOf({ projectId: sid, signature, take: 0, attempt: 0 })
    await store.update((gg) => {
      const n = gg.nodes.k1
      n.status = "running"
      n.inflight = { idemKey: staleKey, since: "2026-10-28T00:00:00.000Z" }
    })
    // 用户改了参数（签名/幂等键都会变）
    await store.applyPatches({ ops: [{ op: "set", node: "k1", path: "params.prompt", value: "改过的提示词" }] as never }, { kind: "agent" })

    let runs = 0
    fakeKeyframe(async () => { runs += 1; return { ok: true, outputs: [OK_OUTPUT], costCoins: 0 } }, 1)
    routes.resetProjectStores()
    const out = await routes.recoverAllProjects(() => makeDeps(makeState(sid), { submits: [], ledger: [] }))
    const mine = out.find((o) => o.sessionId === sid)
    expect(mine?.outcome?.manual).toContain("k1")
    expect(runs).toBe(0)
  })
})

describe("三工具 schema 与契约 fixtures 双向一致", () => {
  // 以本档位置为基准：从仓库根或 deploy-staging/gateway 跑都指向同一份工具 schema（process.cwd() 会随 run-tests.sh 改变）。
  const runtime = join(import.meta.dir, "..", "..", "opencode-runtime", "tools")
  const fixtures = JSON.parse(readFileSync(join(import.meta.dir, "contract-fixtures.json"), "utf8")) as any

  test("PatchOp 全部 16 种 + dsl 都被工具 schema 接受；未知 op 被拒", async () => {
    const mod = await import(pathToFileURL(join(runtime, "project_patch.ts")).href)
    const schema = (mod as any).projectPatchArgsSchema
    const ops = Object.values(fixtures.patchOps as Record<string, { op: unknown }>).map((v) => v.op)
    expect(ops.length).toBe(16)
    for (const op of ops) {
      const parsed = schema.safeParse({ ops: [op] })
      expect(parsed.success).toBe(true)
    }
    expect(schema.safeParse({ ops: [{ op: "dsl", source: { workflow: "x", steps: [] } }] }).success).toBe(true)
    expect(schema.safeParse({ ops: [{ op: "not_an_op" }] }).success).toBe(false)
    expect(schema.safeParse({ ops: [] }).success).toBe(false)
  })

  test("get/run 参数上限与契约一致（wait_sec ≤90）", async () => {
    const get = await import(pathToFileURL(join(runtime, "project_get.ts")).href)
    const run = await import(pathToFileURL(join(runtime, "project_run.ts")).href)
    const getSchema = (get as any).projectGetArgsSchema
    const runSchema = (run as any).projectRunArgsSchema
    expect(getSchema.safeParse({ view: "digest", wait_sec: 90, detail: "full" }).success).toBe(true)
    expect(getSchema.safeParse({ wait_sec: 91 }).success).toBe(false)
    expect(getSchema.safeParse({ view: "graph" }).success).toBe(false)
    expect(runSchema.safeParse({ targets: ["k1"], mode: "force", dry_run: true, budget_coins: 3, wait_sec: 90 }).success).toBe(true)
    expect(runSchema.safeParse({ wait_sec: 91 }).success).toBe(false)
    expect(runSchema.safeParse({ mode: "turbo" }).success).toBe(false)
  })
})
