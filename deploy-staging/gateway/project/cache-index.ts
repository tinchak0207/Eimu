// ===== project/cache-index.ts — 签名→产物缓存索引（设计文档 §3.2 第 6 条，S1）=====
// 位置：$WORKSPACE_DIR/projects/<sid>/cache.json。命中必须复核产物文件还在（sha 对得上），否则当未命中。
// GC：只留 当前图所有节点签名 ∪ pinned 节点的 signatureAtPin ∪ 7 天内墓碑；
// 非 live 条目先转墓碑（付费产物可撤销回滚：签名重新 live 或被查询时原样复活），过期墓碑才真删。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { LIMITS } from "./constants"
import { computeSignature, type CacheLookup } from "./signature"
import type { FingerprintResolver, Iso, NodeSpecLite, NodeType, Output, ProjectGraph } from "./types"

export interface CacheEntry { outputs: Output[]; costCoins: number; at: Iso }
export interface Tombstone extends CacheEntry { deletedAt: Iso }
interface CacheFile { schema: 1; entries: Record<string, CacheEntry>; tombstones: Record<string, Tombstone> }

const DAY_MS = 86_400_000
let tmpSeq = 0

const emptyFile = (): CacheFile => ({ schema: 1, entries: {}, tombstones: {} })
const validEntry = (e: unknown): e is CacheEntry =>
  !!e && typeof e === "object" && Array.isArray((e as CacheEntry).outputs) && typeof (e as CacheEntry).costCoins === "number"

export async function outputsStillPresent(outs: readonly Output[], fp: FingerprintResolver): Promise<boolean> {
  if (!outs.length) return false
  try {
    const shas = await Promise.all(outs.map((o) => fp.fileSha256(o.artifactId)))
    return outs.every((o, i) => shas[i] === o.sha256)
  } catch { return false }
}

export class CacheIndex implements CacheLookup {
  private data: CacheFile | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(readonly file: string, private readonly now: () => number = Date.now) {}

  static forProject(workspaceDir: string, sessionId: string, now?: () => number): CacheIndex {
    return new CacheIndex(join(workspaceDir, "projects", sessionId, "cache.json"), now)
  }

  // 所有改动串行进入；读盘失败/损坏当空索引（缓存丢了只会多重跑，不会错用）
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }
  private async ensure(): Promise<CacheFile> {
    if (this.data) return this.data
    const d = emptyFile()
    try {
      const j = JSON.parse(await readFile(this.file, "utf8"))
      for (const [k, v] of Object.entries(j?.entries ?? {})) if (validEntry(v)) d.entries[k] = v
      for (const [k, v] of Object.entries(j?.tombstones ?? {})) {
        if (validEntry(v) && typeof (v as Tombstone).deletedAt === "string") d.tombstones[k] = v as Tombstone
      }
    } catch { /* 缺失或损坏 → 空索引 */ }
    this.data = d
    return d
  }
  private async save(d: CacheFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${++tmpSeq}.tmp`
    await writeFile(tmp, JSON.stringify(d))
    await rename(tmp, this.file)
  }

  put(signature: string, outputs: Output[], costCoins: number): Promise<void> {
    return this.serial(async () => {
      const d = await this.ensure()
      d.entries[signature] = { outputs, costCoins, at: new Date(this.now()).toISOString() }
      delete d.tombstones[signature]
      await this.save(d)
    })
  }

  // 命中=条目在且全部产物文件 sha 复核通过。墓碑条目同样可命中并复活（撤销回滚）。
  lookup(signature: string, fp: FingerprintResolver): Promise<{ outputs: Output[]; costCoins: number } | null> {
    return this.serial(async () => {
      const d = await this.ensure()
      const live = d.entries[signature]
      if (live) return (await outputsStillPresent(live.outputs, fp)) ? { outputs: live.outputs, costCoins: live.costCoins } : null
      const tomb = d.tombstones[signature]
      if (tomb && await outputsStillPresent(tomb.outputs, fp)) {
        d.entries[signature] = { outputs: tomb.outputs, costCoins: tomb.costCoins, at: tomb.at }
        delete d.tombstones[signature]
        await this.save(d)
        return { outputs: tomb.outputs, costCoins: tomb.costCoins }
      }
      return null
    })
  }

  // live 之外的条目转墓碑；live 的墓碑复活；过期（>TOMBSTONE_DAYS）且非 live 的墓碑删除。返回统计。
  gc(live: ReadonlySet<string>): Promise<{ kept: number; tombstoned: number; revived: number; dropped: number }> {
    return this.serial(async () => {
      const d = await this.ensure()
      const nowMs = this.now()
      const stat = { kept: 0, tombstoned: 0, revived: 0, dropped: 0 }
      for (const [sig, e] of Object.entries(d.entries)) {
        if (live.has(sig)) { stat.kept++; continue }
        d.tombstones[sig] = { ...e, deletedAt: new Date(nowMs).toISOString() }
        delete d.entries[sig]
        stat.tombstoned++
      }
      for (const [sig, t] of Object.entries(d.tombstones)) {
        if (live.has(sig)) {
          if (!d.entries[sig]) d.entries[sig] = { outputs: t.outputs, costCoins: t.costCoins, at: t.at }
          delete d.tombstones[sig]
          stat.revived++
        } else if (nowMs - Date.parse(t.deletedAt) > LIMITS.TOMBSTONE_DAYS * DAY_MS) {
          delete d.tombstones[sig]
          stat.dropped++
        }
      }
      await this.save(d)
      return stat
    })
  }

  // 只读快照（测试与诊断用）
  async snapshot(): Promise<{ entries: string[]; tombstones: string[] }> {
    return this.serial(async () => {
      const d = await this.ensure()
      return { entries: Object.keys(d.entries), tombstones: Object.keys(d.tombstones) }
    })
  }
}

// live 集合 = 当前图所有可算出签名的节点签名 ∪ pinned 节点的 signatureAtPin
export async function liveSignatures(
  graph: Readonly<ProjectGraph>, fp: FingerprintResolver, specs: Readonly<Record<NodeType, NodeSpecLite>>,
): Promise<Set<string>> {
  const live = new Set<string>()
  for (const id of Object.keys(graph.nodes)) {
    const n = graph.nodes[id]
    if (n.pinned) live.add(n.pinned.signatureAtPin)
    const r = await computeSignature(graph, id, fp, specs)
    if (r.ok) live.add(r.signature)
  }
  return live
}

export async function gcCache(
  index: CacheIndex, graph: Readonly<ProjectGraph>, fp: FingerprintResolver, specs: Readonly<Record<NodeType, NodeSpecLite>>,
) {
  return index.gc(await liveSignatures(graph, fp, specs))
}
