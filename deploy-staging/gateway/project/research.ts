// 研究节点（R-20）：多步配方的第一道工序。研究是工程图里的节点，不是提示词里的愿望——
// 图里没有的事模型不会做（2026-10-29 实测：配方铺 30 个生产节点、零研究，模型搜一次网就宣称「参考了获奖作品」）。
//   - 配方展开时在图首加三个窄域研究节点（research_*，script 型作者节点），剧本节点接它们；
//   - 研究由 researcher 子代理并行写，主代理不能写（旧架构的强项：开局并行派四路窄域研究，
//     单路二十多次检索；新架构主代理自己搜一次就交差——主代理能写，它就不派）；
//   - 研究写满前（每个方向 ≥3 个不同出处 + 实质结论），任何要花钱的节点都不准开跑（admission 闸）；
//   - 代理不能删研究节点，只有用户能。
import type { Json, NewNode, NodeId, ProjectGraph, ProjectNode } from "./types.ts"

/** 旧图里的单一研究节点 id（照旧认，照旧闸）。 */
export const RESEARCH_NODE: NodeId = "research"
export const RESEARCH_PREFIX = "research_"
/** 需要研究先行的配方（多步成片类）；单图／单段视频这类一句话的活不加，保住「几个字出图」。 */
export const RESEARCH_RECIPES: ReadonlySet<string> = new Set(["feature_film", "novel_film", "novel_ip", "shortdrama_visual", "ecom_launch"])
export const RESEARCH_MIN_SOURCES = 3
export const RESEARCH_MIN_CHARS = 200

/** 三个互不依赖的窄域方向：同一轮并行派三个 researcher，各写一个。 */
export const RESEARCH_DIRECTIONS: ReadonlyArray<{ id: NodeId; title: string; intent: string }> = [
  {
    id: "research_ref",
    title: "头部作品拆解",
    intent: "同类顶级作品（近三年榜单头部、获奖作品）逐部拆：结构、手法、节奏、视觉与声音语法，各自为什么成立；每条结论标出处链接。",
  },
  {
    id: "research_craft",
    title: "工艺与规格",
    intent: "这一类作品的行业制作标准与技术参数（时长、画幅、BPM、响度、镜头语言、剪辑节奏），以及 AI 生成在哪些环节会露馅、怎么规避；每条标出处链接。",
  },
  {
    id: "research_audience",
    title: "受众与传播",
    intent: "目标平台与受众的偏好、近期趋势、爆款共性与失败反例，最后转成本项目可验收的创作目标与验收标准；每条标出处链接。",
  },
]

export function researchNewNodes(): NewNode[] {
  return RESEARCH_DIRECTIONS.map((d) => ({ id: d.id, type: "script", intent: `研究·${d.title}：${d.intent}写满前不开跑任何生成。`, params: { title: `研究·${d.title}` } }))
}

export function isResearchNode(node: Pick<ProjectNode, "id" | "type"> | undefined): boolean {
  return !!node && node.type === "script" && (node.id === RESEARCH_NODE || node.id.startsWith(RESEARCH_PREFIX))
}

export function researchNodeIds(graph: Readonly<Pick<ProjectGraph, "nodes">> & { order?: readonly string[] }): NodeId[] {
  const ids = graph.order?.length ? graph.order : Object.keys(graph.nodes)
  return ids.filter((id) => isResearchNode(graph.nodes[id] as ProjectNode | undefined))
}

/** 研究正文还缺什么（空数组＝合格）。出处按不同的 http(s) 链接计。 */
export function researchIssues(text: Json | undefined): string[] {
  const body = typeof text === "string" ? text : ""
  const urls = new Set((body.match(/https?:\/\/[^\s)）\]】>"'，。、]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")))
  const prose = body.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, "")
  const issues: string[] = []
  if (urls.size < RESEARCH_MIN_SOURCES) issues.push(`出处 ${urls.size}/${RESEARCH_MIN_SOURCES} 个`)
  if ([...prose].length < RESEARCH_MIN_CHARS) issues.push(`结论 ${[...prose].length}/${RESEARCH_MIN_CHARS} 字`)
  return issues
}

/** 主代理写研究节点时的拒绝理由（研究归 researcher 子代理）。 */
export const RESEARCH_AGENT_FORBIDDEN =
  "研究节点由 researcher 子代理写：同一轮对每个 research_* 节点各派一个 subagent_dispatch（不点专家即 researcher，lane 填该节点 id），并行查完各自写回。"

/** 研究闸：图里有研究节点且没写满 → 返回拒绝理由；否则 null。 */
export function researchGate(graph: Readonly<ProjectGraph>): string | null {
  const open: string[] = []
  for (const id of researchNodeIds(graph)) {
    const issues = researchIssues((graph.nodes[id]!.params as Record<string, Json>).text)
    if (issues.length) open.push(`${id}（${issues.join("，")}）`)
  }
  if (!open.length) return null
  return `研究先行：${open.join("；")} 还没写满。同一轮并行派 researcher 子代理，每个研究节点一个（lane 填该节点 id），写满后再开跑生成。`
}

// ───────────── researcher 认领：并行派三个，各拿一个方向，不撞车 ─────────────

const CLAIM_TTL_MS = 2 * 60_000
const CLAIMS = new Map<string, Map<NodeId, number>>()

/**
 * 给本次 researcher 派发挑一个研究节点：未写满且没被在途 researcher 占用的优先，其次未被占用的；
 * 都被占用＝空（只读）。同步完成选与记，保证同一轮并发派发各拿不同节点。
 * busy＝在途子代理 lane 里的节点（调用方从运行表取）。
 */
export function claimResearchNode(sessionId: string, graph: Readonly<ProjectGraph>, busy: ReadonlySet<string> = new Set(), now = Date.now()): NodeId[] {
  const mine = CLAIMS.get(sessionId) ?? new Map<NodeId, number>()
  for (const [id, at] of mine) if (now - at > CLAIM_TTL_MS) mine.delete(id)
  const taken = (id: string) => busy.has(id) || mine.has(id)
  const ids = researchNodeIds(graph).filter((id) => !taken(id))
  const open = ids.filter((id) => researchIssues((graph.nodes[id]!.params as Record<string, Json>).text).length > 0)
  const pick = open[0] ?? ids[0]
  if (!pick) return []
  mine.set(pick, now)
  CLAIMS.set(sessionId, mine)
  return [pick]
}

export function resetResearchClaims(): void {
  CLAIMS.clear()
}

/** researcher 的任务书头：窄域、不创作、检索下限、写回格式（旧架构研究子代理的任务书形状）。 */
export function researchBriefLine(id: NodeId, graph?: { nodes: Record<string, { intent?: string }> }): string {
  const intent = graph?.nodes[id]?.intent ?? ""
  return [
    `【工程图·窄域研究】你只负责研究节点 ${id}${intent ? `：${intent}` : ""}`,
    "不做创作，只研究。先 project_get 看工程图了解项目，再动手查：",
    "1) 至少 8 次不同角度的检索（中英文都搜，换关键词、换来源），挑最权威的 3～5 篇用 webfetch 打开原文核实，不只看摘要；",
    "2) 每条结论写清「谁、做了什么、为什么成立」并附出处链接，至少 3 个不同来源；互相矛盾的说法写明分歧；",
    `3) 最后用 project_patch 的 write_result 写进 ${id}：结论 → 可借鉴做法 → 对本项目的创作目标与验收标准。`,
  ].join("\n")
}
