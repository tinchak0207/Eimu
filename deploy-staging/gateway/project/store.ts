// S2 工程图持久化（设计文档 §3.4）。
// 位置与目录习惯照抄 timeline.ts:32-33,174-190：$WORKSPACE_DIR/projects/<sessionId>/ + project.json + versions/<n>.json + events.jsonl。
// 并发：网关单进程，每个工程一条 promise 链互斥锁，所有图写（补丁、引擎状态、run 边界）串行进入。
// 提交顺序：版本快照 → 追加事件 → 原子写 project.json（graph.seq 是提交点）。崩溃后事件多出的行在 open 时按 graph.seq 截断。
// 教训来源：记忆 2026-10-18-canvas-snapshot-overwrite-no-rev（整份覆盖 + 零校验 = 旧标签页吃掉新状态）；
// 这里不提供「整图覆盖」写入口，所有变更必须过 patch 引擎，并带 version 乐观并发。
import { randomBytes } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { acknowledgeGeneration, markProjectSession } from "../job-store.ts"
import { ArtifactStore, type IngestHint } from "./artifacts.ts"
import { EventLog, type EventDraft } from "./events.ts"
import { applyPatch, type PatchEngineOptions, type PatchOutcome } from "./patch.ts"
import { PROJECT_SCHEMA_VERSION } from "./types.ts"
import type {
  Actor, Iso, NodeId, NodeType, Output, PatchRequest, ProjectDefaults, ProjectEvent, ProjectGraph, ProjectNode,
} from "./types.ts"

/** 与 timeline.ts:32 同一取值方式与默认值。 */
export function workspaceDir(): string {
  return process.env.WORKSPACE_DIR || "/opt/agent-harness/workspace"
}
export function projectsRoot(): string {
  return path.join(workspaceDir(), "projects")
}
export function projectDirFor(sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) throw new Error(`非法 sessionId：${JSON.stringify(sessionId)}`)
  return path.join(projectsRoot(), sessionId)
}

/**
 * $WORKSPACE_DIR 下除工程目录外的默认入库来源（S8a/S7 的真实产物落点）：
 *  - uploads/：reference 的用户上传素材（router ingress 的落盘目录）
 *  - tts-audio/：voice 执行器的产物目录（TTS_AUDIO_DIR 的默认值）
 * 必须用本文件的 workspaceDir()（每次读 env），不能 import constants-gateway.ts 的模块级硬编码，
 * 否则测试临时目录与生产路径分叉。
 */
export function defaultIngestRoots(): string[] {
  const root = workspaceDir()
  return [path.join(root, "uploads"), path.join(root, "tts-audio")]
}

/** 配方注册表的进程级缺省：组合根（routes.ts）注入一次，ensureProject/openProject 等所有入口都带上。 */
let defaultRecipes: PatchEngineOptions["recipes"] | undefined
export function setDefaultRecipes(recipes: PatchEngineOptions["recipes"] | undefined): void {
  defaultRecipes = recipes
}

export const KEEP_VERSIONS = 50
export const PROJECT_INITIAL_VERSION = 0

export class ProjectNotFoundError extends Error {
  readonly code = "project_not_found"
}
export class ProjectCorruptError extends Error {
  readonly code = "project_corrupt"
}

export interface ProjectStoreOptions {
  now?: () => Date
  /** 新工程图创建时的 defaults；已有工程读盘为准。 */
  defaults?: ProjectDefaults
  templateId?: string
  recipes?: PatchEngineOptions["recipes"]
  isSignedParam?: PatchEngineOptions["isSignedParam"]
  /** 注入产物库（测试用）；缺省按工程目录创建。 */
  artifacts?: ArtifactStore
  allowedPathRoots?: string[]
  maxArtifactBytes?: number
  keepVersions?: number
  /** 仅测试：在 project.json 的 rename 之前触发，用来模拟「临时文件写好了、进程崩了」。 */
  crashBeforeRename?: () => void | Promise<void>
}

export interface ProjectPaths {
  dir: string
  project: string
  versions: string
  events: string
  cache: string
  artifacts: string
}

export interface ProjectRecoveryItem {
  node: NodeId
  type: NodeType
  status: "queued" | "running"
  idemKey: string
  taskId?: string
  since: Iso
  /** poll_task=有平台任务可轮询；confirm_unknown=提交结果未知须先确认；resubmit=只有 idemKey（同 key 重提交，上游去重）。 */
  action: "poll_task" | "confirm_unknown" | "resubmit"
}

export interface RecoveryScan {
  /** status 为 queued/running 且有 inflight 的节点（S6 按 action 接续；本档不调度）。 */
  resumable: ProjectRecoveryItem[]
  /** queued/running 但没有 inflight：进程死在上报之前，状态不可信（S6 按签名重跑或人工确认）。 */
  lost: NodeId[]
}

export interface EnsureProjectOptions extends ProjectStoreOptions {
  /** 网关侧会话 id：用于 job-store 的工程会话标记（S5 的无 node_id 409 闸）。 */
  parentGw?: string
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/** 原子写：同目录临时文件 + rename（跨设备 rename 不成立，故临时文件必须同目录）。 */
async function writeJsonAtomic(file: string, value: unknown, onBeforeRename?: () => void | Promise<void>): Promise<void> {
  const dir = path.dirname(file)
  await mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`)
  await writeFile(tmp, JSON.stringify(value), "utf-8")
  await onBeforeRename?.()
  await rename(tmp, file)
}

function newGraph(sessionId: string, nowIso: Iso, opts: EnsureProjectOptions): ProjectGraph {
  const g: ProjectGraph = {
    schema: PROJECT_SCHEMA_VERSION,
    id: sessionId,
    sessionId,
    version: PROJECT_INITIAL_VERSION,
    createdAt: nowIso,
    updatedAt: nowIso,
    brief: [],
    decisions: [],
    targets: null,
    defaults: { ...(opts.defaults ?? {}) },
    nodes: {},
    order: [],
    budget: { capCoins: null, spentCoins: 0, savedCoins: 0 },
    activeRun: null,
    seq: 0,
  }
  if (opts.templateId) g.templateId = opts.templateId
  return g
}

function parseGraph(raw: string, file: string): ProjectGraph {
  let g: unknown
  try {
    g = JSON.parse(raw)
  } catch (e) {
    throw new ProjectCorruptError(`${file} 不是合法 JSON：${(e as Error).message}`)
  }
  if (!isPlainObject(g) || g.schema !== PROJECT_SCHEMA_VERSION || typeof g.sessionId !== "string" || !isPlainObject(g.nodes) || !Array.isArray(g.order)) {
    throw new ProjectCorruptError(`${file} 不是 v${PROJECT_SCHEMA_VERSION} 工程图（schema/sessionId/nodes/order 不符）`)
  }
  if (!Number.isInteger(g.version) || (g.version as number) < 0) throw new ProjectCorruptError(`${file} 的 version 不是非负整数`)
  if (!Number.isInteger(g.seq) || (g.seq as number) < 0) g.seq = 0
  return g as unknown as ProjectGraph
}

export class ProjectStore {
  readonly paths: ProjectPaths
  readonly artifacts: ArtifactStore
  readonly log: EventLog
  private readonly opts: ProjectStoreOptions
  private graph: ProjectGraph | null = null
  private tail: Promise<void> = Promise.resolve()

  constructor(readonly sessionId: string, dir: string, opts: ProjectStoreOptions = {}) {
    this.opts = opts
    this.paths = {
      dir,
      project: path.join(dir, "project.json"),
      versions: path.join(dir, "versions"),
      events: path.join(dir, "events.jsonl"),
      cache: path.join(dir, "cache.json"),
      artifacts: path.join(dir, "artifacts"),
    }
    this.log = new EventLog(this.paths.events)
    this.artifacts = opts.artifacts ?? new ArtifactStore({
      projectDir: dir,
      // 默认根（uploads/tts-audio）与调用方额外 root 取并集；ArtifactStore 自己再加 projectDir。
      allowedPathRoots: [...new Set([...defaultIngestRoots(), ...(opts.allowedPathRoots ?? [])])],
      maxBytes: opts.maxArtifactBytes,
      now: opts.now,
    })
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date()
  }

  private nowIso(): Iso {
    return this.now().toISOString()
  }

  /** 每个工程一条 promise 链：调用顺序即执行顺序；前一个失败不阻断后续。 */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  private engineOptions(): PatchEngineOptions {
    return {
      now: this.opts.now,
      artifacts: this.artifacts,
      recipes: this.opts.recipes ?? defaultRecipes,
      isSignedParam: this.opts.isSignedParam,
    }
  }

  /** 创建或接上已有工程（幂等）。created=true 时写首个版本（versions/0.json）。 */
  async ensure(): Promise<boolean> {
    return this.withLock(async () => {
      if (this.graph) return false
      if (await exists(this.paths.project)) {
        await this.loadLocked()
        return false
      }
      const staleVersions = await this.listVersions()
      const staleEvents = (await this.fileSize(this.paths.events)) > 0
      if (staleVersions.length || staleEvents) {
        throw new ProjectCorruptError(`${this.paths.dir} 有历史文件但没有 project.json：拒绝用空图覆盖旧版本（人工确认后再删目录）`)
      }
      const g = newGraph(this.sessionId, this.nowIso(), this.opts)
      await mkdir(this.paths.dir, { recursive: true })
      await writeFile(this.paths.events, "", "utf-8")
      await this.writeProjectFile(g)
      await this.writeVersionFile(g) // 首个版本：versions/0.json
      this.graph = g
      return true
    })
  }

  /** 图快照（深拷贝）：调用方改不到内部状态。 */
  async read(): Promise<ProjectGraph> {
    return this.withLock(async () => structuredClone(await this.loadLocked()))
  }

  async version(): Promise<number> {
    return this.withLock(async () => (await this.loadLocked()).version)
  }

  /** 在锁内读-改-写。mutator 只能改传入的副本；抛错则不落盘。 */
  async update<T>(mutator: (g: ProjectGraph) => T | Promise<T>): Promise<T> {
    return this.withLock(async () => {
      const g = await this.loadLocked()
      const copy = structuredClone(g)
      const result = await mutator(copy)
      copy.updatedAt = this.nowIso()
      await this.writeProjectFile(copy)
      this.graph = copy
      return result
    })
  }

  /**
   * 补丁入口：唯一改图路径。baseVersion 不符由引擎整批拒绝（VERSION_CONFLICT）；
   * 提交顺序=版本快照→事件→project.json（提交点）。
   */
  async applyPatches(req: PatchRequest, actor: Actor): Promise<PatchOutcome> {
    return this.withLock(async () => {
      const g = await this.loadLocked()
      const outcome = await applyPatch(g, req, actor, this.engineOptions())
      if (!outcome.committed) return { ...outcome, graph: structuredClone(g) }
      const next = outcome.graph
      next.seq = g.seq
      try {
        const events = await this.appendLocked(next, outcome.events)
        await this.writeVersionFile(next)
        await this.writeProjectFile(next)
        this.graph = next
        return { ...outcome, events, graph: structuredClone(next) }
      } catch (e) {
        await this.rollbackPartialLocked(g)
        throw e
      }
    })
  }

  /** 引擎侧事件（S6 状态流）：只追加事件并把 seq 提交进 project.json，不 bump version、不改图内容。 */
  async appendEvents(drafts: EventDraft[]): Promise<ProjectEvent[]> {
    return this.withLock(async () => {
      const g = await this.loadLocked()
      if (!drafts.length) return []
      const copy = structuredClone(g)
      try {
        const events = await this.appendLocked(copy, drafts)
        copy.updatedAt = this.nowIso()
        await this.writeProjectFile(copy)
        this.graph = copy
        return events
      } catch (e) {
        await this.rollbackPartialLocked(g)
        throw e
      }
    })
  }

  /** run 边界快照（§3.4：versions/<n>.json 另加每次 run 起止各一份）。同一 version 覆盖同一文件。 */
  async snapshot(_reason: string): Promise<string> {
    return this.withLock(async () => {
      const g = await this.loadLocked()
      const file = await this.writeVersionFile(g)
      return file
    })
  }

  async beginRun(runId: string): Promise<ProjectEvent[]> {
    return this.withLock(async () => {
      const g = await this.loadLocked()
      const copy = structuredClone(g)
      copy.activeRun = runId
      copy.updatedAt = this.nowIso()
      try {
        const events = await this.appendLocked(copy, [{ kind: "run_started", run: runId, data: {} }])
        await this.writeVersionFile(copy) // run 起点快照（§3.4）
        await this.writeProjectFile(copy)
        this.graph = copy
        return events
      } catch (e) {
        await this.rollbackPartialLocked(g)
        throw e
      }
    })
  }

  async finishRun(runId: string): Promise<ProjectEvent[]> {
    return this.withLock(async () => {
      const g = await this.loadLocked()
      const copy = structuredClone(g)
      if (copy.activeRun === runId) copy.activeRun = null
      copy.updatedAt = this.nowIso()
      try {
        const events = await this.appendLocked(copy, [{ kind: "run_finished", run: runId, data: {} }])
        await this.writeVersionFile(copy) // run 终点快照（§3.4）
        await this.writeProjectFile(copy)
        this.graph = copy
        return events
      } catch (e) {
        await this.rollbackPartialLocked(g)
        throw e
      }
    })
  }

  /** 产物入库（下载/拷贝→sha256→artifact-store）。与图写互不阻塞：产物是内容寻址、自带原子 rename。 */
  async putArtifact(src: { path: string } | { url: string }, hint: IngestHint & { url?: string; signal?: AbortSignal }): Promise<Output> {
    const out = await this.artifacts.ingest(src, hint, { signal: hint.signal })
    if (hint.url) out.url = hint.url
    return out
  }

  /** 一批生成产物入库后记 S5 的 downloaded ACK（同一任务的全部产物必须一次 ACK，job-store 按 url 全量对齐）。 */
  async ingestGenerationResults(
    taskId: string,
    items: readonly { src: { path: string } | { url: string }; hint: IngestHint & { url?: string; signal?: AbortSignal } }[],
  ): Promise<Output[]> {
    const outputs: Output[] = []
    for (const it of items) outputs.push(await this.putArtifact(it.src, it.hint))
    ackProjectArtifacts(taskId, outputs)
    return outputs
  }

  /** 崩溃恢复扫描（只读）：返回 queued/running 且有 inflight 的节点。 */
  async scanRecovery(): Promise<RecoveryScan> {
    return this.withLock(async () => scanGraph(await this.loadLocked()))
  }

  // ───────────────────────────── 内部（均须在锁内调用） ─────────────────────────────

  private async loadLocked(): Promise<ProjectGraph> {
    if (this.graph) return this.graph
    if (!(await exists(this.paths.project))) throw new ProjectNotFoundError(`工程 ${this.sessionId} 不存在：${this.paths.project}`)
    const g = parseGraph(await readFile(this.paths.project, "utf-8"), this.paths.project)
    // 崩溃对账：事件行数 > graph.seq 的行属于未提交批次。
    if ((await this.log.count()) > g.seq) await this.log.truncateToSeq(g.seq)
    // 崩溃对账：version 快照先于 project.json 写，超前的是未提交的。
    for (const n of await this.listVersions()) if (n > g.version) await rm(path.join(this.paths.versions, `${n}.json`), { force: true })
    await this.cleanTempFiles()
    this.graph = g
    return g
  }

  private async appendLocked(g: ProjectGraph, drafts: EventDraft[]): Promise<ProjectEvent[]> {
    if (!drafts.length) return []
    const events = await this.log.append(drafts, g.seq + 1, this.nowIso())
    g.seq = events[events.length - 1].seq
    return events
  }

  private async writeProjectFile(g: ProjectGraph): Promise<void> {
    await writeJsonAtomic(this.paths.project, g, this.opts.crashBeforeRename)
  }

  /** 提交中途失败：事件截回已提交的 seq、删掉超前的版本快照，保持内存图不变。 */
  private async rollbackPartialLocked(committed: ProjectGraph): Promise<void> {
    try {
      if ((await this.log.count()) > committed.seq) await this.log.truncateToSeq(committed.seq)
      for (const n of await this.listVersions()) if (n > committed.version) await rm(path.join(this.paths.versions, `${n}.json`), { force: true })
    } catch {
      // 回滚本身失败时保持原错误上抛；下次 open 的对账会补做（事件超 seq / 版本超前）。
    }
  }

  private async writeVersionFile(g: ProjectGraph): Promise<string> {
    const file = path.join(this.paths.versions, `${g.version}.json`)
    await writeJsonAtomic(file, g)
    await this.pruneVersions()
    return file
  }

  private async listVersions(): Promise<number[]> {
    try {
      return (await readdir(this.paths.versions))
        .map((n) => (/^\d+\.json$/.test(n) ? Number(n.slice(0, -5)) : NaN))
        .filter((n) => Number.isInteger(n))
        .sort((a, b) => a - b)
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return []
      throw e
    }
  }

  /** 保留最近 keepVersions 份（按版本号，不是 mtime）。 */
  private async pruneVersions(): Promise<void> {
    const keep = this.opts.keepVersions ?? KEEP_VERSIONS
    const nums = await this.listVersions()
    for (const n of nums.slice(0, Math.max(0, nums.length - keep))) {
      await rm(path.join(this.paths.versions, `${n}.json`), { force: true })
    }
  }

  private async cleanTempFiles(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.paths.dir)
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return
      throw e
    }
    for (const n of names) if (n.startsWith(".project.json.") && n.endsWith(".tmp")) await rm(path.join(this.paths.dir, n), { force: true })
  }

  private async fileSize(file: string): Promise<number> {
    try {
      return (await stat(file)).size
    } catch {
      return 0
    }
  }
}

/** §3.4 崩溃恢复分类。纯读，不改状态、不发提交。 */
export function scanGraph(g: Pick<ProjectGraph, "nodes">): RecoveryScan {
  const resumable: ProjectRecoveryItem[] = []
  const lost: NodeId[] = []
  for (const n of Object.values(g.nodes) as ProjectNode[]) {
    if (n.status !== "queued" && n.status !== "running") continue
    const inflight = n.inflight
    if (!inflight) {
      lost.push(n.id)
      continue
    }
    const item: ProjectRecoveryItem = { node: n.id, type: n.type, status: n.status, idemKey: inflight.idemKey, since: inflight.since, action: "resubmit" }
    if (inflight.taskId) item.taskId = inflight.taskId
    item.action = inflight.submitUnknown ? "confirm_unknown" : inflight.taskId ? "poll_task" : "resubmit"
    resumable.push(item)
  }
  resumable.sort((a, b) => (a.since === b.since ? (a.node < b.node ? -1 : 1) : a.since < b.since ? -1 : 1))
  lost.sort()
  return { resumable, lost }
}

export interface ProjectRecoveryEntry extends RecoveryScan {
  sessionId: string
  dir: string
  /** 坏档（project.json 不可解析等）：不阻塞其它工程，由调用方告警。 */
  error?: string
}

/** 网关启动扫描 projects/*（只读；坏档跳过并把错误留在条目上，由调用方决定告警方式）。 */
export async function scanProjectRecoveries(rootDir = projectsRoot()): Promise<ProjectRecoveryEntry[]> {
  let names: string[]
  try {
    names = (await readdir(rootDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return []
    throw e
  }
  const out: ProjectRecoveryEntry[] = []
  for (const sessionId of names) {
    const store = new ProjectStore(sessionId, path.join(rootDir, sessionId))
    try {
      const g = await store.read()
      out.push({ sessionId, dir: store.paths.dir, ...scanGraph(g) })
    } catch (e) {
      out.push({ sessionId, dir: store.paths.dir, resumable: [], lost: [], error: (e as Error).message })
    }
  }
  return out
}

/** S5 job-store 的 downloaded ACK：stage 名沿用 job-delivery.ts:187 的真实用法（"downloaded"）。 */
export function ackProjectArtifacts(taskId: string, outputs: readonly Pick<Output, "url" | "path" | "sha256" | "bytes">[]): void {
  if (!outputs.length) throw new Error("downloaded ACK 需要至少一个产物")
  for (const o of outputs) {
    if (typeof o.url !== "string" || !/^https?:\/\//.test(o.url)) throw new Error(`产物 ${o.sha256.slice(0, 12)} 没有来源 url：downloaded ACK 按 url 与权威 artifacts 对齐`)
  }
  acknowledgeGeneration(taskId, "downloaded", {
    local_path: outputs[0].path,
    artifact_urls: outputs.map((o) => o.url),
    downloaded_artifacts: outputs.map((o) => ({ url: o.url, path: o.path, sha256: o.sha256, bytes: o.bytes })),
    consumed_by: "project-engine",
  })
}

/**
 * 进程内每个工程目录只有一个 ProjectStore：锁（withLock）与内存图都挂在实例上，
 * 两个实例各自缓存图、各自编 seq，后写的会用旧图覆盖先写的（简报丢失、事件 seq 撞号）。
 * 所有入口（ingress、工具路由、画布、导入）都从这里取实例；opts 只在首次创建时生效。
 */
const SHARED_STORES = new Map<string, ProjectStore>()

export function sharedProjectStore(sessionId: string, opts: ProjectStoreOptions = {}): ProjectStore {
  const dir = projectDirFor(sessionId)
  let store = SHARED_STORES.get(dir)
  if (!store) {
    store = new ProjectStore(sessionId, dir, opts)
    SHARED_STORES.set(dir, store)
  }
  return store
}

/** 仅测试：丢掉进程内共享的 store 实例。 */
export function resetSharedProjectStores(): void {
  SHARED_STORES.clear()
}

/** 工程入口：不存在则建（写 versions/0.json + project.json + events.jsonl），并标记 job-store 的工程会话。 */
export async function ensureProject(sessionId: string, opts: EnsureProjectOptions = {}): Promise<{ store: ProjectStore; created: boolean }> {
  const store = sharedProjectStore(sessionId, opts)
  const created = await store.ensure()
  if (opts.parentGw) markProjectSession(opts.parentGw)
  return { store, created }
}

/** 接上已有工程（不创建）。 */
export async function openProject(sessionId: string, opts: ProjectStoreOptions = {}): Promise<ProjectStore> {
  const store = sharedProjectStore(sessionId, opts)
  await store.read() // 不存在会抛 ProjectNotFoundError
  return store
}
