// cache-index.ts 行为测试（S1）：真文件 + 真 sha256 的 resolver；时间用注入的假时钟。
import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CacheIndex, gcCache } from "./cache-index"
import { computeSignature } from "./signature"
import type { FingerprintResolver, NodeSpecLite, NodeType, Output, ProjectGraph, ProjectNode } from "./types"

const DIR = mkdtempSync(join(tmpdir(), "cache-index-test-"))
afterAll(() => rmSync(DIR, { recursive: true, force: true }))
const DAY = 86_400_000

// 产物文件落在 DIR/art/<artifactId>；resolver 读真文件算 sha256，缺文件即抛
const fp: FingerprintResolver = {
  async fileSha256(id) { return createHash("sha256").update(readFileSync(join(DIR, "art", id))).digest("hex") },
}
mkdirSync(join(DIR, "art"), { recursive: true })
function makeOutput(artifactId: string, content: string): Output {
  writeFileSync(join(DIR, "art", artifactId), content)
  return { port: "out", artifactId, sha256: createHash("sha256").update(content).digest("hex"), path: join(DIR, "art", artifactId), mime: "text/plain", bytes: content.length, origin: "generated" }
}
let n = 0
const fresh = (clock = { t: Date.parse("2026-10-28T00:00:00Z") }) => {
  const file = join(DIR, `case${++n}`, "projects", "s1", "cache.json")
  return { clock, file, idx: new CacheIndex(file, () => clock.t) }
}

describe("CacheIndex", () => {
  test("put→lookup 命中，且落盘后新实例仍能读回（崩溃重启）", async () => {
    const { idx, file, clock } = fresh()
    const o = makeOutput("a1", "hello")
    await idx.put("sig_a", [o], 3)
    expect(await idx.lookup("sig_a", fp)).toEqual({ outputs: [o], costCoins: 3 })
    expect(await new CacheIndex(file, () => clock.t).lookup("sig_a", fp)).toEqual({ outputs: [o], costCoins: 3 })
    expect(await idx.lookup("sig_none", fp)).toBeNull()
  })
  test("⑦ 命中但产物文件被删 → 不命中；文件内容被改（sha 不符）→ 不命中", async () => {
    const { idx } = fresh()
    const o = makeOutput("b1", "v1")
    await idx.put("sig_b", [o], 1)
    writeFileSync(join(DIR, "art", "b1"), "tampered")
    expect(await idx.lookup("sig_b", fp)).toBeNull()
    rmSync(join(DIR, "art", "b1"))
    expect(await idx.lookup("sig_b", fp)).toBeNull()
  })
  test("多输出只要一个文件没了就整条不命中", async () => {
    const { idx } = fresh()
    const o1 = makeOutput("c1", "x"), o2 = makeOutput("c2", "y")
    await idx.put("sig_c", [o1, o2], 1)
    expect(await idx.lookup("sig_c", fp)).not.toBeNull()
    rmSync(join(DIR, "art", "c2"))
    expect(await idx.lookup("sig_c", fp)).toBeNull()
  })
  test("损坏的 cache.json → 当空索引，不抛错", async () => {
    const { file, idx } = fresh()
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "{ not json")
    expect(await idx.lookup("x", fp)).toBeNull()
    await idx.put("sig_d", [makeOutput("d1", "z")], 0)
    expect((await idx.snapshot()).entries).toEqual(["sig_d"])
  })
  test("并发 30 次 put 不丢条目，落盘文件是合法 JSON 且无残留临时文件", async () => {
    const { idx, file } = fresh()
    await Promise.all(Array.from({ length: 30 }, (_, i) => idx.put(`sig_p${i}`, [makeOutput(`p${i}`, `c${i}`)], i)))
    expect((await idx.snapshot()).entries.length).toBe(30)
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).entries).length).toBe(30)
    expect(existsSync(`${file}.${process.pid}.1.tmp`)).toBe(false)
  })
})

describe("⑧ GC 与墓碑", () => {
  test("非 live 条目转墓碑：7 天内仍在（可复活），超过 7 天消失", async () => {
    const { idx, clock } = fresh()
    await idx.put("sig_keep", [makeOutput("g1", "k")], 1)
    await idx.put("sig_gone", [makeOutput("g2", "g")], 1)
    const r1 = await idx.gc(new Set(["sig_keep"]))
    expect(r1).toMatchObject({ kept: 1, tombstoned: 1 })
    expect(await idx.snapshot()).toEqual({ entries: ["sig_keep"], tombstones: ["sig_gone"] })

    clock.t += 6.9 * DAY
    await idx.gc(new Set(["sig_keep"]))
    expect((await idx.snapshot()).tombstones).toEqual(["sig_gone"])

    clock.t += 0.2 * DAY // 累计 7.1 天
    const r3 = await idx.gc(new Set(["sig_keep"]))
    expect(r3.dropped).toBe(1)
    expect((await idx.snapshot()).tombstones).toEqual([])
  })
  test("墓碑期内被查询（回滚后签名又对上）→ 原样复活", async () => {
    const { idx } = fresh()
    const o = makeOutput("h1", "paid")
    await idx.put("sig_h", [o], 9)
    await idx.gc(new Set())
    expect((await idx.snapshot()).entries).toEqual([])
    expect(await idx.lookup("sig_h", fp)).toEqual({ outputs: [o], costCoins: 9 })
    expect(await idx.snapshot()).toEqual({ entries: ["sig_h"], tombstones: [] })
  })
  test("gc 时墓碑签名重新 live → 复活", async () => {
    const { idx } = fresh()
    await idx.put("sig_i", [makeOutput("i1", "i")], 1)
    await idx.gc(new Set())
    const r = await idx.gc(new Set(["sig_i"]))
    expect(r.revived).toBe(1)
    expect((await idx.snapshot()).entries).toEqual(["sig_i"])
  })
  test("gcCache：live=当前图所有节点签名 ∪ pinned 的 signatureAtPin；旧图签名进墓碑", async () => {
    const specs = {
      keyframe: { type: "keyframe", specVersion: 1, signedParams: ["prompt"], pinnable: true, fingerprintMode: "structural" },
    } as unknown as Record<NodeType, NodeSpecLite>
    const mk = (id: string, prompt: string): ProjectNode => ({
      id, type: "keyframe", intent: "", params: { prompt }, inputs: {}, refs: [], pinned: null, status: "pending", signature: null, lastRun: null, outputs: [], rev: 1,
    })
    const g = { schema: 1, id: "p", sessionId: "p", version: 1, createdAt: "", updatedAt: "", brief: [], decisions: [], targets: null, defaults: {},
      nodes: { a: mk("a", "新"), b: mk("b", "钉住的"), }, order: ["a", "b"], budget: { capCoins: null, spentCoins: 0, savedCoins: 0 }, activeRun: null, seq: 0 } as ProjectGraph
    g.nodes.b.pinned = { by: "user", at: "", outputsSha: ["x"], signatureAtPin: "sig_pinned_old" }
    const sigA = (await computeSignature(g, "a", fp, specs)) as { signature: string }
    const { idx } = fresh()
    await idx.put(sigA.signature, [makeOutput("j1", "a")], 1)
    await idx.put("sig_pinned_old", [makeOutput("j2", "b")], 1)
    await idx.put("sig_from_old_graph", [makeOutput("j3", "c")], 1)
    await gcCache(idx, g, fp, specs)
    const snap = await idx.snapshot()
    expect(snap.entries.sort()).toEqual([sigA.signature, "sig_pinned_old"].sort())
    expect(snap.tombstones).toEqual(["sig_from_old_graph"])
  })
})
