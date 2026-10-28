// S2 存储判准测试（设计文档 §3.4）：原子写、版本快照、事件 seq、并发互斥、崩溃恢复、产物入库 + S5 收据 ACK。
// 期望值独立于实现：版本号来自「每次补丁批次 +1」；事件 seq 来自 events.jsonl 行号；恢复动作来自 §3.4 的三种在途情形；
// 收据 downloaded ACK 的 stage/字段来自 job-store.ts:231 的真实用法（job-delivery.ts:187）。
import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// 沙箱：WORKSPACE_DIR / SESSIONS_DB_PATH 必须早于 store.ts（会连带 import job-store.ts）的载入。
const SANDBOX = mkdtempSync(join(tmpdir(), "s2-store-"))
process.env.WORKSPACE_DIR = join(SANDBOX, "workspace")
process.env.SESSIONS_DB_PATH = join(SANDBOX, "sessions.db")
process.env.LEDGER_PATH = join(SANDBOX, "ledger.jsonl")

const { ensureProject, openProject, projectDirFor, projectsRoot, scanProjectRecoveries, ackProjectArtifacts, defaultIngestRoots, workspaceDir, ProjectNotFoundError, KEEP_VERSIONS } = await import("./store.ts")
const jobStore = await import("../job-store.ts")
type Actor = import("./types.ts").Actor
type PatchOp = import("./types.ts").PatchOp

const AGENT: Actor = { kind: "agent" }
const USER: Actor = { kind: "user" }

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

const versionFiles = (dir: string): number[] =>
  readdirSync(join(dir, "versions"))
    .filter((n) => /^\d+\.json$/.test(n))
    .map((n) => Number(n.slice(0, -5)))
    .sort((a, b) => a - b)

const setOp = (node: string, key: string, value: unknown): PatchOp => ({ op: "set", node, path: `params.${key}`, value: value as never })
const addKeyframe = (id: string): PatchOp => ({ op: "add_node", node: { id, type: "keyframe", params: { prompt: "p" } } })

describe("工程创建（ensureProject）与 S5 工程会话标记", () => {
  test("写首个版本（versions/0.json + project.json + events.jsonl），调 markProjectSession", async () => {
    const { store, created } = await ensureProject("ses_make", { parentGw: "gw-make", defaults: { imageModel: "m-img" }, templateId: "single_image" })
    expect(created).toBe(true)
    const dir = projectDirFor("ses_make")
    expect(dir).toBe(store.paths.dir)
    expect(existsSync(join(dir, "project.json"))).toBe(true)
    expect(existsSync(join(dir, "events.jsonl"))).toBe(true)
    expect(versionFiles(dir)).toEqual([0])

    const g = await store.read()
    expect(g.version).toBe(0)
    expect(g.seq).toBe(0)
    expect(g.defaults).toEqual({ imageModel: "m-img" })
    expect(g.templateId).toBe("single_image")
    expect(g.nodes).toEqual({})

    // markProjectSession：S5 的 409 闸对该网关会话生效；带 node_id 的登记照常。
    expect(jobStore.isProjectSession("gw-make")).toBe(true)
    expect(() => jobStore.registerGenerationReceipt({ task_id: "t-nonode", parent_gw: "gw-make", producer_oc: "oc", kind: "image" }))
      .toThrow(jobStore.ProjectNodeRequiredError)
    const ok = jobStore.registerGenerationReceipt({ task_id: "t-node", parent_gw: "gw-make", producer_oc: "oc", kind: "image", node_id: "k1" })
    expect(ok.task_id).toBe("t-node")

    // 幂等：再次 ensure 不重建、不 bump 版本。
    const again = await ensureProject("ses_make", { parentGw: "gw-make" })
    expect(again.created).toBe(false)
    expect((await again.store.read()).version).toBe(0)
  })

  test("openProject 对不存在工程抛 ProjectNotFoundError", async () => {
    await expect(openProject("ses_missing")).rejects.toBeInstanceOf(ProjectNotFoundError)
  })
})

describe("补丁提交：version、事件 seq、原子写", () => {
  test("baseVersion 不匹配 → 整批 VERSION_CONFLICT，版本/事件都不动", async () => {
    const { store } = await ensureProject("ses_ver")
    await store.applyPatches({ ops: [addKeyframe("k1")] }, AGENT) // v1
    const r = await store.applyPatches({ ops: [setOp("k1", "prompt", "x")], baseVersion: 0 }, AGENT)
    expect(r.committed).toBe(false)
    expect(r.receipt.rejected[0].code).toBe("VERSION_CONFLICT")
    expect((await store.read()).version).toBe(1)
    expect((await store.read()).nodes.k1.params.prompt).toBe("p")
    expect(await store.log.count()).toBe(1)
  })

  test("重新 load 后读回同图、同 version、同事件序（seq 连续 = 行号）", async () => {
    const { store } = await ensureProject("ses_reload")
    await store.applyPatches({ ops: [addKeyframe("k1")] }, AGENT)
    for (let i = 0; i < 5; i++) await store.applyPatches({ ops: [setOp("k1", `k${i}`, i)] }, AGENT)
    const before = await store.read()
    const openEvents = await store.log.read(0)
    expect(openEvents.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])

    const reopened = await openProject("ses_reload")
    const after = await reopened.read()
    expect(after).toEqual(before)
    expect(after.version).toBe(6)
    expect((await reopened.log.read(0)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(versionFiles(projectDirFor("ses_reload"))).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  test("崩溃对账：events.jsonl 多出的未提交行（seq > graph.seq）在 open 时被截断", async () => {
    const { store } = await ensureProject("ses_reconcile")
    await store.applyPatches({ ops: [addKeyframe("k1")] }, AGENT)
    const dir = projectDirFor("ses_reconcile")
    appendFileSync(join(dir, "events.jsonl"), '{"seq":2,"at":"x","kind":"patch","data":{}}\n{"seq":3,"at":"x","kind":"patch","data":{}}\n')
    expect(await store.log.count()).toBe(3)
    const reopened = await openProject("ses_reconcile")
    expect((await reopened.read()).seq).toBe(1)
    expect((await reopened.log.read(0)).map((e) => e.seq)).toEqual([1])
  })
})

describe("并发：50 个补丁串行提交，无丢失", () => {
  test("50 并发 → version=50、每个 op 的效果都在、事件 seq=1..50", async () => {
    const { store } = await ensureProject("ses_conc")
    const calls: Promise<unknown>[] = []
    calls.push(store.applyPatches({ ops: [addKeyframe("k1")] }, AGENT))
    for (let i = 0; i < 49; i++) calls.push(store.applyPatches({ ops: [setOp("k1", `p${i}`, i)] }, AGENT))
    const receipts = (await Promise.all(calls)) as { receipt: { ok: boolean; version: number } }[]
    expect(receipts.every((r) => r.receipt.ok)).toBe(true)
    expect(receipts.map((r) => r.receipt.version).sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))

    const g = await store.read()
    expect(g.version).toBe(50)
    expect(g.order).toEqual(["k1"])
    for (let i = 0; i < 49; i++) expect(g.nodes.k1.params[`p${i}`]).toBe(i)
    expect((await store.log.read(0)).map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(g.seq).toBe(50)
  })
})

describe("崩溃模拟：临时文件写了但不 rename", () => {
  test("旧 project.json 不被破坏；事件与超前版本回滚；重启后继续可写", async () => {
    let armed = false
    const { store } = await ensureProject("ses_crash", {
      crashBeforeRename: () => {
        if (armed) {
          armed = false
          throw new Error("simulated crash before rename")
        }
      },
    })
    await store.applyPatches({ ops: [addKeyframe("k1")] }, AGENT) // v1
    const dir = projectDirFor("ses_crash")
    const before = JSON.parse(readFileSync(join(dir, "project.json"), "utf-8"))
    expect(before.version).toBe(1)

    armed = true
    await expect(store.applyPatches({ ops: [setOp("k1", "prompt", "改坏前")] }, AGENT)).rejects.toThrow("simulated crash before rename")

    const after = JSON.parse(readFileSync(join(dir, "project.json"), "utf-8"))
    expect(after.version).toBe(1) // 旧图完好
    expect(after.nodes.k1.params.prompt).toBe("p")
    expect(versionFiles(dir)).toEqual([0, 1]) // 超前的 versions/2.json 被回滚
    expect(await store.log.count()).toBe(1) // 未提交事件被截回

    // 残留的临时文件不影响 load，open 时清掉。
    writeFileSync(join(dir, ".project.json.crash.tmp"), '{"schema":1,"version":99}', "utf-8")
    const reopened = await openProject("ses_crash")
    expect((await reopened.read()).version).toBe(1)
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([])

    const next = await reopened.applyPatches({ ops: [setOp("k1", "prompt", "恢复后")] }, AGENT)
    expect(next.receipt.ok).toBe(true)
    expect((await reopened.read()).version).toBe(2)
    expect((await reopened.read()).nodes.k1.params.prompt).toBe("恢复后")
  })
})

describe("版本快照保留 50 份", () => {
  test("60 个批次后 versions 只剩最近 50 份（0..10 被删）", async () => {
    const { store } = await ensureProject("ses_prune")
    await store.applyPatches({ ops: [addKeyframe("k1")] }, AGENT)
    for (let i = 1; i <= 60; i++) await store.applyPatches({ ops: [setOp("k1", `v${i}`, i)] }, AGENT)
    const files = versionFiles(projectDirFor("ses_prune"))
    expect(KEEP_VERSIONS).toBe(50)
    expect(files).toHaveLength(50)
    expect(files[0]).toBe(12) // 首版 0 + 61 个批次 = 62 份 → 保留最近 50 份（12..61）
    expect(files[files.length - 1]).toBe(61)
  })

  test("run 起止各写一份快照（同一 version 覆盖同一文件），activeRun 随事件流切换", async () => {
    const { store } = await ensureProject("ses_run")
    await store.applyPatches({ ops: [addKeyframe("k1")] }, AGENT) // v1
    const started = await store.beginRun("run_1")
    expect(started[0].kind).toBe("run_started")
    expect((await store.read()).activeRun).toBe("run_1")
    expect(versionFiles(projectDirFor("ses_run"))).toEqual([0, 1])
    const finished = await store.finishRun("run_1")
    expect(finished[0].kind).toBe("run_finished")
    expect((await store.read()).activeRun).toBeNull()
    expect((await store.log.read(0)).map((e) => e.kind)).toEqual(["patch", "run_started", "run_finished"])
    expect(versionFiles(projectDirFor("ses_run"))).toEqual([0, 1])
  })
})

describe("崩溃恢复扫描（§3.4，只读不调度）", () => {
  test("queued/running + inflight 三种接续动作；无 inflight 归 lost", async () => {
    const { store } = await ensureProject("ses_rec")
    await store.update((g) => {
      const mk = (id: string, status: string, inflight?: Record<string, unknown>) => {
        g.nodes[id] = {
          id, type: "keyframe", intent: "", params: { prompt: "p", model: "m", seed: 1 }, inputs: {}, refs: [],
          pinned: null, status: status as never, signature: null, lastRun: null, outputs: [], rev: 1,
          ...(inflight ? { inflight: inflight as never } : {}),
        }
        g.order.push(id)
      }
      mk("poll", "running", { idemKey: "idem-poll", taskId: "task-1", since: "2026-10-28T00:00:01.000Z" })
      mk("unknown", "queued", { idemKey: "idem-unknown", taskId: "task-2", submitUnknown: true, since: "2026-10-28T00:00:02.000Z" })
      mk("resubmit", "queued", { idemKey: "idem-resubmit", since: "2026-10-28T00:00:03.000Z" })
      mk("lost", "running")
      mk("done", "done", { idemKey: "idem-done", since: "2026-10-28T00:00:00.000Z" })
    })

    const scan = await store.scanRecovery()
    expect(scan.resumable.map((r) => [r.node, r.action])).toEqual([
      ["poll", "poll_task"],
      ["unknown", "confirm_unknown"],
      ["resubmit", "resubmit"],
    ])
    expect(scan.resumable.find((r) => r.node === "poll")?.taskId).toBe("task-1")
    expect(scan.lost).toEqual(["lost"]) // done 不在扫描范围

    const all = await scanProjectRecoveries(projectsRoot())
    const entry = all.find((e) => e.sessionId === "ses_rec")
    expect(entry?.error).toBeUndefined()
    expect(entry?.resumable.map((r) => r.node)).toEqual(["poll", "unknown", "resubmit"])
    expect(entry?.lost).toEqual(["lost"])
  })
})

describe("产物入库与 S5 downloaded ACK", () => {
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")

  test("putArtifact：内容寻址 + 真 sha256；ackProjectArtifacts 记 downloaded", async () => {
    const { store } = await ensureProject("ses_art", { parentGw: "gw-art" })
    const taskId = "task-art-1"
    jobStore.registerGenerationReceipt({ task_id: taskId, parent_gw: "gw-art", producer_oc: "oc", consumer_oc: "oc", kind: "image", node_id: "k1", requested_count: 1 })
    jobStore.completeGenerationReceipt(taskId, "succeeded", [{ url: "https://cdn.test/x.png" }], {})
    expect(jobStore.generationReceipt(taskId)?.downloaded_at ?? 0).toBe(0)

    const bytes = Buffer.from("png-bytes-123")
    const src = join(store.paths.dir, "download.png")
    writeFileSync(src, bytes)
    const out = await store.putArtifact({ path: src }, { port: "out", origin: "generated", mime: "image/png", url: "https://cdn.test/x.png" })
    expect(out.sha256).toBe(sha(bytes))
    expect(out.artifactId).toBe("art_" + sha(bytes).slice(0, 16))
    expect(out.bytes).toBe(bytes.length)
    expect(out.url).toBe("https://cdn.test/x.png")
    expect(readFileSync(out.path)).toEqual(bytes)
    expect((await store.artifacts.get(out.artifactId))?.sha256).toBe(out.sha256)

    ackProjectArtifacts(taskId, [out])
    expect(jobStore.generationReceipt(taskId)?.downloaded_at).toBeGreaterThan(0)
  })

  test("ingestGenerationResults：整批入库后一次 ACK（多产物按 url 全量对齐）", async () => {
    const { store } = await ensureProject("ses_art3", { parentGw: "gw-art3" })
    const taskId = "task-art-3"
    const urls = ["https://cdn.test/a.png", "https://cdn.test/b.png"]
    jobStore.registerGenerationReceipt({ task_id: taskId, parent_gw: "gw-art3", producer_oc: "oc", consumer_oc: "oc", kind: "image", node_id: "k1", requested_count: 2 })
    jobStore.completeGenerationReceipt(taskId, "succeeded", urls.map((url) => ({ url })), {})
    const a = join(store.paths.dir, "a.png")
    const b = join(store.paths.dir, "b.png")
    writeFileSync(a, Buffer.from("A"))
    writeFileSync(b, Buffer.from("BB"))
    const outs = await store.ingestGenerationResults(taskId, [
      { src: { path: a }, hint: { port: "out", origin: "generated", mime: "image/png", url: urls[0] } },
      { src: { path: b }, hint: { port: "out", origin: "generated", mime: "image/png", url: urls[1] } },
    ])
    expect(outs.map((o) => o.sha256)).toEqual([sha(Buffer.from("A")), sha(Buffer.from("BB"))])
    expect(jobStore.generationReceipt(taskId)?.downloaded_at).toBeGreaterThan(0)
  })

  test("download ACK 与权威 artifacts 不一致时抛错（fail-closed，不静默记错）", async () => {
    const { store } = await ensureProject("ses_art2", { parentGw: "gw-art2" })
    const taskId = "task-art-2"
    jobStore.registerGenerationReceipt({ task_id: taskId, parent_gw: "gw-art2", producer_oc: "oc", consumer_oc: "oc", kind: "image", node_id: "k1", requested_count: 1 })
    jobStore.completeGenerationReceipt(taskId, "succeeded", [{ url: "https://cdn.test/real.png" }], {})
    const src = join(store.paths.dir, "d.png")
    writeFileSync(src, Buffer.from("x"))
    const out = await store.putArtifact({ path: src }, { port: "out", origin: "generated", mime: "image/png", url: "https://cdn.test/other.png" })
    expect(() => ackProjectArtifacts(taskId, [out])).toThrow()
    expect(jobStore.generationReceipt(taskId)?.downloaded_at ?? 0).toBe(0)
  })
})

describe("产物入库允许根：uploads / tts-audio / 调用方额外 root（S8a 实测暴露）", () => {
  const shaOf = (b: Buffer) => createHash("sha256").update(b).digest("hex")
  const hint = { port: "out", origin: "generated" as const }

  test("默认根由 workspaceDir() 现算（uploads、tts-audio），不是 constants-gateway 的硬编码", () => {
    expect(workspaceDir()).toBe(process.env.WORKSPACE_DIR)
    expect(defaultIngestRoots()).toEqual([join(process.env.WORKSPACE_DIR!, "uploads"), join(process.env.WORKSPACE_DIR!, "tts-audio")])
  })

  test("tts-audio 与 uploads 下的文件可 ingest，sha256/mime 正确", async () => {
    const { store } = await ensureProject("ses_roots")
    for (const dir of defaultIngestRoots()) mkdirSync(dir, { recursive: true })
    const voice = join(process.env.WORKSPACE_DIR!, "tts-audio", "v1.mp3")
    const upload = join(process.env.WORKSPACE_DIR!, "uploads", "pic.png")
    writeFileSync(voice, Buffer.from("voice-bytes"))
    writeFileSync(upload, Buffer.from("upload-bytes"))

    const a = await store.putArtifact({ path: voice }, { ...hint, mime: "audio/mpeg" })
    const b = await store.putArtifact({ path: upload }, { ...hint, origin: "user", mime: "image/png" })
    expect(a.sha256).toBe(shaOf(Buffer.from("voice-bytes")))
    expect(a.mime).toBe("audio/mpeg")
    expect(b.sha256).toBe(shaOf(Buffer.from("upload-bytes")))
    expect(b.origin).toBe("user") // hint 透传，不归到 generated
    expect(existsSync(a.path)).toBe(true)
  })

  test("根外路径仍被拒；`../` 穿越仍被拒", async () => {
    const { store } = await ensureProject("ses_roots")
    const outside = join(SANDBOX, "outside.bin")
    writeFileSync(outside, Buffer.from("nope"))
    await expect(store.putArtifact({ path: outside }, { ...hint, mime: "application/octet-stream" })).rejects.toThrow("outside allowed roots")
    // 从工程目录用 ../ 穿出去（字符串不预先 normalize，让 API 自己解析）
    const traversal = `${store.paths.dir}/../../../outside.bin`
    await expect(store.putArtifact({ path: traversal }, { ...hint, mime: "application/octet-stream" })).rejects.toThrow("outside allowed roots")
    // 反过来：uploads/../uploads 仍在根内 → 放行（证明拒的是越界，不是字符串里有 ..）
    const inside = join(process.env.WORKSPACE_DIR!, "uploads", "..", "uploads", "pic.png")
    writeFileSync(join(process.env.WORKSPACE_DIR!, "uploads", "pic.png"), Buffer.from("inside"))
    await expect(store.putArtifact({ path: inside }, { ...hint, mime: "image/png" })).resolves.toMatchObject({ sha256: shaOf(Buffer.from("inside")) })
  })

  test("调用方 allowedPathRoots 与默认根取并集（额外 root 可用，默认根仍可用）", async () => {
    const extra = join(SANDBOX, "extra-assets")
    mkdirSync(extra, { recursive: true })
    writeFileSync(join(extra, "e.bin"), Buffer.from("extra"))
    const { store } = await ensureProject("ses_roots_extra", { allowedPathRoots: [extra] })
    expect(await store.putArtifact({ path: join(extra, "e.bin") }, { ...hint, mime: "application/octet-stream" }))
      .toMatchObject({ sha256: shaOf(Buffer.from("extra")) })
    // 默认根没被额外 root 顶掉
    mkdirSync(join(process.env.WORKSPACE_DIR!, "uploads"), { recursive: true })
    writeFileSync(join(process.env.WORKSPACE_DIR!, "uploads", "u2.png"), Buffer.from("u2"))
    expect(await store.putArtifact({ path: join(process.env.WORKSPACE_DIR!, "uploads", "u2.png") }, { ...hint, mime: "image/png" }))
      .toMatchObject({ sha256: shaOf(Buffer.from("u2")) })
  })
})
