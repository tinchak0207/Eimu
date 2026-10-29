// S19 旧工作流只读导入器（设计文档 §7「迁移与回滚」）。
//
// 作用：把旧 `workflowSnapshot`（workflow-gw-submit.ts:117 `workflowSnapshotOf` 的形态：
// graph.nodes[{id,kind,title,role,metadata}] + nodeStatus + nodeContent + nodeCost）里**已有产物**
// 的节点，变成新工程图里 `pinned` 的 `reference` 节点，产物下载/拷贝进工程 artifact-store 并
// **实算 sha256**（artifact-store 流式哈希实际字节，不沿用旧快照里的任何指纹）；取不回来
// （下载失败/路径不可读）的节点只进 `stale` 报告，不入图、不钉。
//
// 边界（S19 明文）：
//   - 「只读」= 不回写旧 workflow、不删旧快照、不自动迁移、不接 UI 入口（无 router 挂载）；
//   - 零上游生成：本档只 import 存储与签名模组，没有任何提交/生成路径；导入一个节点最多
//     产生一次产物下载（旧产物本身），不产生任何模型调用；
//   - 写入唯一走 store.applyPatches（add_node + replace_output），不整图覆盖（§3.4）。
import path from "node:path"
import { NODE_SPECS_LITE } from "./specs.ts"
import { computeSignature } from "./signature.ts"
import { ensureProject, type ProjectStore } from "./store.ts"
import { effectiveGoalRevision, briefLedgerRevision } from "./digest.ts"
import type { Actor, Json, NodeId, PatchOp, ProjectNode, Sha256 } from "./types.ts"

/** 已知电影配方原位接最终候选链。用户制作节点、锁、资产和目标不迁走。 */
export async function upgradeLegacyVideoCandidate(store: ProjectStore): Promise<{ upgraded: boolean; blocked?: string }> {
  const result = await store.update((graph) => {
    const legacy = Object.values(graph.nodes).filter((n) => n.type === "export" && n.params.preset !== "image_pack" && !n.params.stage)
    for (const final of legacy) {
      if (final.locked || final.pinned) {
        return { upgraded: false, blocked: `需要保留人工锁的评审接线确认：${final.id} 被锁定，不覆盖锁或产物。` }
      }
    }
    let upgraded = false
    for (const final of legacy) {
      const candidateId = final.id === "export" ? "candidate" : `${final.id.slice(0, 32)}_candidate`
      if (graph.nodes[candidateId]) return { upgraded: false, blocked: `候选节点身份冲突：${candidateId} 已存在，保留原图等待明确接线。` }
      const oldMachine = graph.nodes[final.inputs.machine?.from]
      const oldCritic = graph.nodes[final.inputs.verdict?.from]
      const machineId = oldMachine?.type === "qc" && !oldMachine.locked && !oldMachine.pinned ? oldMachine.id : `${final.id.slice(0, 32)}_machine`
      const criticId = oldCritic?.type === "qc" && !oldCritic.locked && !oldCritic.pinned ? oldCritic.id : `${final.id.slice(0, 32)}_critic`
      const candidate = structuredClone(final)
      candidate.id = candidateId
      candidate.params.stage = "candidate"
      candidate.inputs = Object.fromEntries(Object.entries(final.inputs).filter(([name]) => name !== "machine" && name !== "verdict"))
      candidate.status = "stale"
      candidate.signature = null
      candidate.lastRun = null
      graph.nodes[candidateId] = candidate
      graph.order.splice(Math.max(0, graph.order.indexOf(final.id)), 0, candidate.id)
      final.params.stage = "publish"
      final.inputs = { candidate: { from: candidate.id }, jianying: { from: candidate.id, port: "jianying" }, fcpxml: { from: candidate.id, port: "fcpxml" }, machine: { from: machineId }, verdict: { from: criticId } }
      for (const [id, mode] of [[machineId, "machine"], [criticId, "critic"]] as const) {
        if (!graph.nodes[id]) {
          graph.nodes[id] = { id, type: "qc", intent: "独立核查完整最终候选与用户当前要求", params: { mode, rubric: mode === "critic" ? "film_final_critic" : "film_default" }, inputs: {}, refs: [], status: "pending", signature: null, lastRun: null, outputs: [], rev: 0, pinned: null }
          graph.order.splice(graph.order.indexOf(final.id), 0, id)
        }
        const qc = graph.nodes[id]
        qc.inputs = { final: { from: candidate.id } }
        if (qc.params.mode === "critic") qc.params.rubric = "film_final_critic"
        if (qc.params.thresholds && typeof qc.params.thresholds === "object" && !Array.isArray(qc.params.thresholds)) {
          delete qc.params.thresholds.requireAudio
          delete qc.params.thresholds.maxDurationSec
        }
        delete qc.onFail
        qc.status = "stale"
        qc.signature = null
        qc.rev++
      }
      final.status = "stale"
      final.signature = null
      final.rev++
      upgraded = true
    }
    const goalRevision = effectiveGoalRevision(graph)
    for (const node of Object.values(graph.nodes)) {
      if (node.type !== "export" || node.params.stage !== "candidate" || node.params.goalRevision === goalRevision) continue
      node.params.goalRevision = goalRevision
      node.status = "stale"
      node.signature = null
      node.rev++
      upgraded = true
    }
    const ledgerRevision = briefLedgerRevision(graph)
    for (const node of Object.values(graph.nodes)) {
      if (node.type !== "qc" || node.params.mode !== "critic" || !Object.values(node.inputs).some((ref) => graph.nodes[ref.from]?.params.stage === "candidate") || node.params.briefLedgerRevision === ledgerRevision) continue
      node.params.briefLedgerRevision = ledgerRevision
      node.status = "stale"
      node.signature = null
      node.rev++
      upgraded = true
    }
    if (upgraded) graph.version++
    return { upgraded }
  })
  if (result.upgraded) await store.appendEvents([{ kind: "patch", data: { reason: "final_candidate_upgrade", nodes: (await store.read()).order } }])
  return result
}

/** 旧快照节点（graph.nodes 是 unknown[]，逐项收窄）。 */
export interface LegacySnapshotNode {
  id?: unknown
  kind?: unknown
  title?: unknown
  role?: unknown
  metadata?: Record<string, unknown>
}

/** `PersistableWorkflow`（workflow-gw-submit.ts）的宽松只读视图：只读需要的栏位。 */
export interface LegacyWorkflowSnapshot {
  workflowId?: string
  templateId?: string
  graph?: { nodes?: LegacySnapshotNode[]; connections?: unknown }
  nodeStatus?: Record<string, string>
  nodeContent?: Record<string, string>
  nodeCost?: Record<string, number>
}

export interface LegacyImportOptions {
  /** 目标工程（v1：一个会话一个工程）。缺省取快照的 workflowId。 */
  sessionId?: string
  /** 注入已有工程（测试/调用方已 open）；缺省 ensureProject(sessionId)。 */
  store?: ProjectStore
  /** ensureProject 时标记 job-store 工程会话用（与项目创建路径一致）。 */
  parentGw?: string
  /** 写图 actor；缺省 user（导入是人触发的，不伪装成模型写入）。 */
  actor?: Actor
  /** 单次产物下载的超时；缺省 120s。只作用于旧产物下载，不涉上游生成。 */
  fetchTimeoutMs?: number
  signal?: AbortSignal
}

export interface LegacyImportedNode {
  legacyNodeId: string
  nodeId: NodeId
  kind: string
  artifactId: string
  sha256: Sha256
  bytes: number
  mime: string
  /** 旧内容是可下载 URL 时保留来源地址（画布/溯源用）。 */
  url?: string
}

export interface LegacyImportReport {
  sessionId: string
  workflowId: string | null
  /** 已变成 pinned reference 的节点。 */
  imported: LegacyImportedNode[]
  /** 有产物但取不回来：标 stale、不钉、不入图（重试由调用方再跑一次导入）。 */
  stale: { legacyNodeId: string; reason: string }[]
  /** 没产物/内容不是文件地址/text|config 壳节点/已导入过。 */
  skipped: { legacyNodeId: string; reason: string }[]
  /** 产物已入库但写图失败（补丁被拒）：节点不留残骸。 */
  failed: { legacyNodeId: string; reason: string }[]
  /** 导入后的图 version（store.version()）。 */
  graphVersion: number
}

/** 旧快照里不是「产物」的壳节点：text 是提示词、config 是参数，它们也有 nodeContent。 */
const NON_ARTIFACT_KINDS = new Set(["text", "config"])
/** reference 节点的 params.source：合法标识符（specs.ts ID_RE：^[a-z][a-z0-9_]{0,31}$）。 */
export const LEGACY_IMPORT_SOURCE = "legacy_import"
const MAX_NODE_ID = 48

export type LegacyArtifactSource = { kind: "url"; url: string } | { kind: "path"; path: string }

/** 旧 nodeContent → 可入库来源。只认 http(s) URL 或绝对路径；提示词等文本返回 null（不猜）。 */
export function legacyArtifactSource(content: unknown): LegacyArtifactSource | null {
  if (typeof content !== "string") return null
  const s = content.trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return { kind: "url", url: s }
  if (path.isAbsolute(s)) return { kind: "path", path: s }
  return null
}

/** 旧节点 id → 合法工程 NodeId（稳定映射：同 legacy id 永远得到同一 id，供去重/重导入）。 */
export function legacyNodeIdOf(legacyId: string): NodeId {
  const cleaned = legacyId
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
  const base = `legacy_${cleaned}`.slice(0, MAX_NODE_ID)
  return (base === "legacy_" ? "legacy_node" : base) as NodeId
}

function clip(s: string, n: number): string {
  const chars = [...s]
  return chars.length <= n ? s : chars.slice(0, n).join("")
}

function labelOf(node: LegacySnapshotNode, kind: string): string {
  const raw = typeof node.title === "string" && node.title.trim()
    ? node.title.trim()
    : typeof node.role === "string" && node.role.trim()
      ? node.role.trim()
      : kind
  return clip(raw, 80)
}

function intentOf(node: LegacySnapshotNode, kind: string): string {
  return clip(`旧工作流导入：${labelOf(node, kind)}（${kind}）`, 200)
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 导入旧工作流产物。逐节点失败隔离：一个节点下载失败只进 stale，不影响其它节点。
 * 幂等：同一 legacy 节点映射到固定 NodeId，已在图里则跳过（不重复入库/不重复钉）。
 */
export async function importLegacyWorkflow(
  snapshot: LegacyWorkflowSnapshot,
  opts: LegacyImportOptions = {},
): Promise<LegacyImportReport> {
  const workflowId = typeof snapshot?.workflowId === "string" && snapshot.workflowId ? snapshot.workflowId : null
  const sessionId = opts.sessionId ?? workflowId
  if (!sessionId) throw new Error("importLegacyWorkflow: 快照没有 workflowId，且未提供 sessionId")
  const store = opts.store ?? (await ensureProject(sessionId, { parentGw: opts.parentGw })).store
  const actor: Actor = opts.actor ?? { kind: "user" }
  const timeoutMs = opts.fetchTimeoutMs ?? 120_000

  const nodes = Array.isArray(snapshot?.graph?.nodes) ? snapshot.graph.nodes : []
  const nodeStatus = snapshot?.nodeStatus ?? {}
  const nodeContent = snapshot?.nodeContent ?? {}

  const graph = await store.read()
  const existing = new Set(Object.keys(graph.nodes))

  const report: LegacyImportReport = {
    sessionId,
    workflowId,
    imported: [],
    stale: [],
    skipped: [],
    failed: [],
    graphVersion: graph.version,
  }

  for (const node of nodes) {
    const legacyId = typeof node?.id === "string" ? node.id : ""
    if (!legacyId) {
      report.skipped.push({ legacyNodeId: "", reason: "节点没有 id" })
      continue
    }
    const kind = typeof node.kind === "string" ? node.kind : ""
    if (!kind || NON_ARTIFACT_KINDS.has(kind)) {
      report.skipped.push({ legacyNodeId: legacyId, reason: `非产物节点（kind=${kind || "未知"}）` })
      continue
    }
    // 「已有产物」的判据与旧引擎一致（workflow-service.ts:483）：成功状态 + nodeContent 非空。
    const status = nodeStatus[legacyId]
    if (status !== "success") {
      report.skipped.push({ legacyNodeId: legacyId, reason: `节点未成功（status=${status ?? "无"}）` })
      continue
    }
    const src = legacyArtifactSource(nodeContent[legacyId])
    if (!src) {
      report.skipped.push({ legacyNodeId: legacyId, reason: "nodeContent 不是可下载/可读的文件地址" })
      continue
    }
    const nodeId = legacyNodeIdOf(legacyId)
    if (existing.has(nodeId)) {
      report.skipped.push({ legacyNodeId: legacyId, reason: `已导入（节点 ${nodeId} 已存在）` })
      continue
    }

    // 1) 产物入库：流式读实际字节算 sha256（URL 下载 / 本地拷贝），失败即 stale、不钉。
    let output
    try {
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs)
      output = await store.putArtifact(
        src.kind === "url" ? { url: src.url } : { path: src.path },
        { port: "out", origin: "user", ...(src.kind === "url" ? { url: src.url } : {}), signal },
      )
    } catch (e) {
      report.stale.push({ legacyNodeId: legacyId, reason: clip(errorMessage(e), 200) })
      continue
    }

    // 2) 入图：reference 节点 + 挂产物（replace_output 自动 pin(origin:user)）。两 op 一批。
    const params: Record<string, Json> = {
      title: labelOf(node, kind),
      source: LEGACY_IMPORT_SOURCE,
      artifactId: output.artifactId,
    }
    const ops: PatchOp[] = [
      { op: "add_node", node: { id: nodeId, type: "reference", intent: intentOf(node, kind), params } },
      { op: "replace_output", node: nodeId, artifactId: output.artifactId },
    ]
    let applied = 0
    let failReason = ""
    try {
      const outcome = await store.applyPatches({ ops }, actor)
      applied = outcome.receipt.applied
      if (!outcome.receipt.ok || applied < ops.length) {
        const first = outcome.receipt.rejected[0]
        failReason = first ? `${first.code}: ${first.msg}` : `补丁未全应用（applied=${applied}/${ops.length}）`
      }
    } catch (e) {
      failReason = errorMessage(e)
    }
    if (applied < ops.length) {
      // 半途失败：撤掉可能已建的空 reference 节点，不留悬空残骸（产物本身留在内容寻址库里，可复用）。
      try {
        if (applied > 0) await store.applyPatches({ ops: [{ op: "remove_node", node: nodeId }] }, actor)
      } catch {
        // 清理失败不掩盖原错误；下次导入会因「已存在」跳过该 id，人工可删。
      }
      report.failed.push({ legacyNodeId: legacyId, reason: clip(failReason || "补丁写入失败", 200) })
      continue
    }

    existing.add(nodeId)
    report.imported.push({
      legacyNodeId: legacyId,
      nodeId,
      kind,
      artifactId: output.artifactId,
      sha256: output.sha256,
      bytes: output.bytes,
      mime: output.mime,
      ...(output.url ? { url: output.url } : {}),
    })
  }

  // 3) 钉住时的签名：patch 引擎的 pin 只能取 node.signature/lastRun.signature（新节点为 null），
  //    这里用真实签名算法补写 signature + signatureAtPin，否则导入节点一算签名就被判「漂移」。
  if (report.imported.length > 0) {
    await store.update(async (g) => {
      for (const item of report.imported) {
        const n: ProjectNode | undefined = g.nodes[item.nodeId]
        if (!n || !n.pinned) continue
        try {
          const sig = await computeSignature(g, item.nodeId, store.artifacts, NODE_SPECS_LITE)
          if (!sig.ok) continue
          n.signature = sig.signature
          n.pinned.signatureAtPin = sig.signature
          n.pinned.reason = clip(`legacy_import:${item.legacyNodeId}`, 200)
        } catch {
          // 签名算不出（产物不在/被改）→ 保留 pin 的 outputsSha；节点仍如实报告「已导入」，
          // 下次引擎算签名时按漂移处理，不在这里伪造一个签名。
        }
      }
    })
  }

  report.graphVersion = await store.version()
  return report
}
