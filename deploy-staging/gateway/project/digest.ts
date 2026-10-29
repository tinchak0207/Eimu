// 工程摘要（digest）：由图确定性生成（不经模型），≤ LIMITS.DIGEST_BYTES=6144 字节。
//
// 段落固定顺序（§3.7 第 3 点）：
//   状态计数 / 失败与阻塞（全列）/ 钉住与漂移（全列）/ 待决问题与用户决定 /
//   预算与授权 / 环境可用性（≤600B）/ 用户偏好（≤600B）/ 最近事件（≤10 行）
// 超限时按段内优先级截断；失败与漂移段永不被截成空（至少保留全部节点 id）。
import { LIMITS } from "./constants.ts"
import { createHash } from "node:crypto"
import type { NodeStatus, ProjectEvent, ProjectGraph, ProjectNode } from "./types.ts"

const ENV_CAP_BYTES = 600
const PREF_CAP_BYTES = 600
const EVENTS_MAX_LINES = 10
const NODE_MSG_CHARS = 120

/** 原话账本版本只用于交付前核对，不进入制作签名，不因状态询问重渲媒体。 */
export function briefLedgerRevision(graph: Readonly<ProjectGraph>): string {
  return createHash("sha256").update(JSON.stringify(graph.brief.map((b) => ({ messageId: b.messageId, text: b.text, truncated: b.truncated === true })))).digest("hex")
}

export function activeGoalInterpretations(graph: Readonly<ProjectGraph>) {
  const all = graph.goalInterpretations ?? []
  const superseded = new Set(all.flatMap((i) => i.supersedes ?? []))
  return all.filter((i) => !i.statusOnly && !superseded.has(i.id))
}

/** 生效制作版本：结构目标+实际用户决定+作者制作解释候选；解释需最终critic对照原话。 */
export function effectiveGoalRevision(graph: Readonly<ProjectGraph>): string {
  const targets = graph.targets ? {
    durationSec: graph.targets.durationSec, aspect: graph.targets.aspect, shots: graph.targets.shots,
    subtitles: graph.targets.subtitles, audio: graph.targets.audio, setBy: graph.targets.setBy,
    sources: graph.targets.sources ? Object.fromEntries(Object.entries(graph.targets.sources).map(([field, source]) => [field, source ? { kind: source.kind, messageId: source.messageId, interpretation: source.interpretation } : null])) : undefined,
  } : null
  return createHash("sha256").update(JSON.stringify({
    interpretations: activeGoalInterpretations(graph).map((i) => ({ sourceMessageIds: i.sourceMessageIds, requirements: i.requirements })),
    targets,
    decisions: graph.decisions.map((d) => ({ question: d.question, answer: d.answer, refs: d.refs })),
  })).digest("hex")
}

export interface DigestInputs {
  /** 环境可用性（工具/模型/桥是否可用），≤600B 截断。 */
  environment?: string
  /** 用户偏好（模型/尺寸/风格/语言），≤600B 截断。 */
  preferences?: string
  /** 授权事实：auto / full / 逐次确认。 */
  authorization?: string
  /** 待决问题（由 question 工具挂起、尚无 answer 的项）。 */
  pending?: { question: string; at?: string; node?: string }[]
  /** 最近事件（升序或降序皆可；取最新 ≤10）。 */
  recentEvents?: ProjectEvent[]
}

const STATUS_ORDER: NodeStatus[] = [
  "pending", "queued", "running", "done", "failed", "blocked", "stale", "skipped", "orphaned",
]

function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8")
}

function clipBytes(s: string, cap: number): { text: string; cut: boolean } {
  if (bytes(s) <= cap) return { text: s, cut: false }
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (bytes(s.slice(0, mid)) <= cap - 8) lo = mid
    else hi = mid - 1
  }
  return { text: `${s.slice(0, lo)}…（截断）`, cut: true }
}

function oneLine(s: string, cap = NODE_MSG_CHARS): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
  return t.length > cap ? `${t.slice(0, cap)}…` : t
}

function byOrder(graph: Readonly<ProjectGraph>): ProjectNode[] {
  const seen = new Set<string>()
  const out: ProjectNode[] = []
  for (const id of graph.order) {
    const n = graph.nodes[id]
    if (n) {
      out.push(n)
      seen.add(id)
    }
  }
  for (const id of Object.keys(graph.nodes)) {
    if (!seen.has(id)) out.push(graph.nodes[id])
  }
  return out
}

export function isDrifted(node: Readonly<ProjectNode>): boolean {
  return node.pinned !== null && typeof node.signature === "string" && node.signature !== node.pinned.signatureAtPin
}

export function failedNodes(graph: Readonly<ProjectGraph>): ProjectNode[] {
  return byOrder(graph).filter((n) => n.status === "failed" || n.status === "blocked")
}

export function pinnedNodes(graph: Readonly<ProjectGraph>): ProjectNode[] {
  return byOrder(graph).filter((n) => n.pinned !== null)
}

function statusCounts(graph: Readonly<ProjectGraph>): string {
  const counts = new Map<NodeStatus, number>()
  for (const n of Object.values(graph.nodes)) counts.set(n.status, (counts.get(n.status) ?? 0) + 1)
  const parts = STATUS_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => `${s} ${counts.get(s)}`)
  const total = Object.keys(graph.nodes).length
  const run = graph.activeRun ? ` run=${graph.activeRun}` : ""
  return `## 状态计数\nv${graph.version} · 节点 ${total}${run}${graph.templateId ? ` · 配方 ${graph.templateId}` : ""}${parts.length ? ` · ${parts.join(" / ")}` : ""}`
}

/**
 * 节点地图：按类型列出全部节点 id（非 pending 的附状态）。digest 是代理认识工程图的唯一入口——
 * 2026-10-29 实测：digest 只给计数不给 id，代理只好逐个猜 id（clip/clips/shots/storyboard…）连调十几次 project_get。
 * level 1＝已完成的只计数；level 2＝每类只计数。
 */
function nodesSection(graph: Readonly<ProjectGraph>, level: number): string {
  const ids = graph.order?.length ? graph.order.filter((id) => graph.nodes[id]) : Object.keys(graph.nodes)
  const byType = new Map<string, ProjectGraph["nodes"][string][]>()
  for (const id of ids) {
    const n = graph.nodes[id]!
    if (n.id.includes("#")) continue // forEach 实例跟着模板节点走，不单列
    byType.set(n.type, [...(byType.get(n.type) ?? []), n])
  }
  const rows = [...byType].map(([type, nodes]) => {
    if (level >= 2) return `- ${type} ${nodes.length}`
    const shown = level >= 1 ? nodes.filter((n) => n.status !== "done") : nodes
    const done = nodes.length - shown.length
    const list = shown.map((n) => (n.status === "pending" ? n.id : `${n.id}[${n.status}]`)).join("、")
    return `- ${type}：${list}${done ? `${list ? "；" : ""}已完成 ${done}` : ""}`
  })
  return `## 节点（view:"node" 用这些 id）\n${rows.length ? rows.join("\n") : "无"}`
}

function failedSection(graph: Readonly<ProjectGraph>, level: number): string {
  const nodes = failedNodes(graph)
  const head = `## 失败与阻塞（${nodes.length}）`
  if (nodes.length === 0) return `${head}\n无`
  const rows = nodes.map((n) => {
    if (level >= 2) return `- ${n.id}`
    const err = n.error ? ` [${n.error.code}${n.error.retryable ? "" : " 不可重试"}] ${oneLine(n.error.message)}` : ""
    if (level >= 1) return `- ${n.id} (${n.type}) ${n.status}${err}`
    return `- ${n.id} (${n.type}) ${n.status}${err}${n.inflight ? ` inflight=${n.inflight.idemKey.slice(0, 18)}` : ""}`
  })
  return [head, ...rows].join("\n")
}

function pinnedSection(graph: Readonly<ProjectGraph>, level: number): string {
  const nodes = pinnedNodes(graph)
  const drifted = nodes.filter(isDrifted)
  const head = `## 钉住与漂移（钉住 ${nodes.length} · 漂移 ${drifted.length}）`
  if (nodes.length === 0) return `${head}\n无`
  const rows = nodes.map((n) => {
    const mark = isDrifted(n) ? " ⇄漂移" : ""
    if (level >= 2) return `- ${n.id}${mark}`
    const pin = n.pinned
    const take = pin?.take !== undefined ? ` take=${pin.take}` : ""
    if (level >= 1) return `- ${n.id}${take}${mark}`
    return `- ${n.id}${take}${mark} by=${pin?.by} at=${pin?.at}${pin?.reason ? ` reason=${oneLine(pin.reason, 60)}` : ""}`
  })
  return [head, ...rows].join("\n")
}

function decisionsSection(graph: Readonly<ProjectGraph>, inputs: DigestInputs, level: number): string {
  const lines = [`## 待决问题与用户决定`]
  const pending = inputs.pending ?? []
  const decisions = graph.decisions
  const maxDecisions = level >= 2 ? 1 : level >= 1 ? 3 : 8
  if (pending.length === 0 && decisions.length === 0) {
    lines.push("无")
    return lines.join("\n")
  }
  for (const p of pending.slice(0, level >= 1 ? 1 : 4)) {
    lines.push(`- 待决：${oneLine(p.question)}${p.node ? ` (node=${p.node})` : ""}`)
  }
  const shown = decisions.slice(-maxDecisions)
  if (decisions.length > shown.length) lines.push(`（较早决定折叠 ${decisions.length - shown.length} 条）`)
  for (const d of shown) {
    lines.push(`- 决定：${oneLine(d.question, 80)} → ${level >= 2 ? oneLine(d.answer, 40) : oneLine(d.answer, 200)}`)
  }
  return lines.join("\n")
}

function budgetSection(graph: Readonly<ProjectGraph>, inputs: DigestInputs, level: number): string {
  const b = graph.budget
  const cap = b.capCoins === null ? "未设上限" : `预算 ${b.capCoins}`
  const line = `## 预算与授权\n${cap} · 已花 ${b.spentCoins} · 复用省下 ${b.savedCoins}${inputs.authorization ? ` · 授权 ${inputs.authorization}` : ""}`
  if (level >= 2) return line
  const t = graph.targets
  const targets = t
    ? [
        t.durationSec !== undefined ? `时长 ${t.durationSec}s` : "",
        t.aspect ? `比例 ${t.aspect}` : "",
        t.shots !== undefined ? `镜头 ${t.shots}` : "",
        t.subtitles !== undefined ? `字幕 ${t.subtitles ? "要" : "不要"}` : "",
        t.audio ? `音轨 ${t.audio}` : "",
        `setBy=${t.setBy?.kind ?? "?"}`,
      ].filter(Boolean).join(" / ")
    : ""
  const sources = t?.sources ? Object.entries(t.sources).map(([field, s]) => `${field}=${s?.kind ?? "unknown"}${s?.interpretation ? "（解释候选）" : ""}${s?.messageId ? ` source=${oneLine(s.messageId, 80)}` : ""}${s?.supersedes ? ` supersedes=${oneLine(s.supersedes, 80)}` : ""}`).join(" / ") : ""
  return `${line}${targets ? `\n目标：${targets}` : ""}${sources ? `\n目标字段来源：${sources}` : ""}`
}

function preferencesSection(graph: Readonly<ProjectGraph>, inputs: DigestInputs): string {
  const d = graph.defaults
  const defaults = [
    d.videoModel ? `video=${d.videoModel}` : "",
    d.imageModel ? `image=${d.imageModel}` : "",
    d.imageSize ? `size=${d.imageSize}` : "",
    d.voice ? `voice=${d.voice}` : "",
    d.style ? `style=${d.style}` : "",
  ].filter(Boolean).join(" ")
  const base = ["## 用户偏好", defaults || "（未设置）"].join("\n")
  if (!inputs.preferences?.trim()) return base
  const room = Math.max(0, PREF_CAP_BYTES - bytes(base) - 1)
  const { text } = clipBytes(inputs.preferences.trim(), room)
  return `${base}\n${text}`
}

function environmentSection(inputs: DigestInputs): string {
  const text = clipBytes(String(inputs.environment ?? "").trim(), ENV_CAP_BYTES)
  return ["## 环境可用性", text.text || "（未上报）"].join("\n")
}

function eventsSection(inputs: DigestInputs, level: number): string {
  const all = inputs.recentEvents ?? []
  const limit = level >= 2 ? 1 : level >= 1 ? 5 : EVENTS_MAX_LINES
  const tail = all.slice(-limit)
  const head = `## 最近事件（最新 ${tail.length}${all.length > tail.length ? `/${all.length}` : ""}）`
  if (tail.length === 0) return `${head}\n无`
  const rows = tail.map((e) => {
    const data = level >= 2 ? "" : ` ${oneLine(JSON.stringify(e.data ?? {}), level >= 1 ? 40 : 120)}`
    return `- #${e.seq} ${e.kind}${e.node ? ` ${e.node}` : ""}${data}`
  })
  return [head, ...rows].join("\n")
}

/**
 * 生成工程摘要。确定性：同图同输入 → 同字节。
 * 超限时从最可牺牲的段开始逐级压缩（最近事件 → 决定 → 偏好/环境 → 预算 → 计数），
 * 失败与钉住两段最后压、且至少保留全部节点 id（永不为空）。
 */
export function renderDigest(
  graph: Readonly<ProjectGraph>,
  inputs: DigestInputs = {},
  maxBytes: number = LIMITS.DIGEST_BYTES,
  opts: { nodeMap?: boolean } = {},
): string {
  // 固定顺序输出（slots 顺序 = 段落顺序）；priority 数字越小越先被压缩（越可牺牲）。
  const slots = [
    { key: "status", priority: 7, render: (l: number) => statusCounts(graph) },
    { key: "failed", priority: 10, render: (l: number) => failedSection(graph, l) },
    { key: "pinned", priority: 9, render: (l: number) => pinnedSection(graph, l) },
    // 节点地图只进 project_get 的 digest；每轮注入上下文的 digest 不带（守住 I1 的 64KB 与最近 6 步）。
    ...(opts.nodeMap ? [{ key: "nodes", priority: 3, render: (l: number) => nodesSection(graph, l) }] : []),
    { key: "decisions", priority: 2, render: (l: number) => decisionsSection(graph, inputs, l) },
    { key: "budget", priority: 6, render: (l: number) => budgetSection(graph, inputs, l) },
    { key: "env", priority: 5, render: (_l: number) => environmentSection(inputs) },
    { key: "prefs", priority: 4, render: (_l: number) => preferencesSection(graph, inputs) },
    { key: "events", priority: 1, render: (l: number) => eventsSection(inputs, l) },
  ]
  const levels = new Map<string, number>(slots.map((s) => [s.key, 0]))
  const total = () => slots.reduce((n, s) => n + bytes(s.render(levels.get(s.key) ?? 0)) + 1, 0)
  let current = total()
  // 从最可牺牲的段开始升到最小档。
  for (const prio of [1, 2, 3, 4, 5, 6, 7, 9, 10]) {
    for (const s of slots) {
      if (s.priority !== prio) continue
      while (current > maxBytes && (levels.get(s.key) ?? 0) < 2) {
        levels.set(s.key, (levels.get(s.key) ?? 0) + 1)
        current = total()
      }
      if (current <= maxBytes) break
    }
    if (current <= maxBytes) break
  }
  // 仍超限：把非保护段整段删掉（事件 → 决定 → 偏好 → 环境 → 预算 → 计数）；失败/钉住段保留。
  const PROTECTED = new Set(["failed", "pinned"])
  for (const key of ["events", "decisions", "nodes", "prefs", "env", "budget", "status"]) {
    if (current <= maxBytes) break
    if (PROTECTED.has(key)) continue
    const s = slots.find((x) => x.key === key)!
    if ((levels.get(key) ?? 0) >= 3) continue
    levels.set(key, 3)
    current = total()
  }
  const rendered = slots
    .filter((s) => (levels.get(s.key) ?? 0) < 3)
    .map((s) => s.render(levels.get(s.key) ?? 0))
  let out = rendered.join("\n\n")
  // 最后保险：只有失败/钉住两段（必留 id）仍可能超限，按行尾硬切但保留每行首字段。
  if (bytes(out) > maxBytes) {
    const lines = out.split("\n")
    const kept: string[] = []
    let used = 0
    for (const line of lines) {
      const cost = bytes(line) + 1
      if (used + cost > maxBytes) {
        if (line.startsWith("- ")) kept.push(line.split(" ").slice(0, 2).join(" "))
        continue
      }
      kept.push(line)
      used += cost
    }
    out = kept.join("\n")
    if (bytes(out) > maxBytes) {
      let lo = 0
      let hi = out.length
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        if (bytes(out.slice(0, mid)) <= maxBytes) lo = mid
        else hi = mid - 1
      }
      out = out.slice(0, lo)
    }
  }
  return out
}
