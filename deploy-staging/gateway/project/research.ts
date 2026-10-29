// 研究节点（R-20）：多步配方的第一道工序。研究是工程图里的节点，不是提示词里的愿望——
// 图里没有的事模型不会做（2026-10-29 实测：配方铺 30 个生产节点、零研究，模型搜一次网就宣称「参考了获奖作品」）。
//   - 配方展开时在图首加 research（script 型作者节点），剧本节点接它；
//   - 研究写满前（≥3 个不同出处 + 实质结论），任何要花钱的节点都不准开跑（admission 闸）；
//   - 代理不能删研究节点，只有用户能。
import type { Json, NewNode, NodeId, ProjectGraph, ProjectNode } from "./types.ts"

export const RESEARCH_NODE: NodeId = "research"
/** 需要研究先行的配方（多步成片类）；单图／单段视频这类一句话的活不加，保住「几个字出图」。 */
export const RESEARCH_RECIPES: ReadonlySet<string> = new Set(["feature_film", "novel_film", "novel_ip", "shortdrama_visual", "ecom_launch"])
export const RESEARCH_MIN_SOURCES = 3
export const RESEARCH_MIN_CHARS = 200

export function researchNewNode(): NewNode {
  return {
    id: RESEARCH_NODE,
    type: "script",
    intent: "研究简报：同类头部作品怎么做（结构、手法、节奏、视觉语法），每条结论标出处链接；结论转成创作目标与验收标准。写满前不开跑任何生成。",
    params: { title: "研究简报" },
  }
}

export function isResearchNode(node: Pick<ProjectNode, "id" | "type"> | undefined): boolean {
  return !!node && node.id === RESEARCH_NODE && node.type === "script"
}

/** 研究正文还缺什么（空数组＝合格）。出处按不同的 http(s) 链接计。 */
export function researchIssues(text: Json | undefined): string[] {
  const body = typeof text === "string" ? text : ""
  const urls = new Set((body.match(/https?:\/\/[^\s)）\]】>"'，。、]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")))
  const prose = body.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, "")
  const issues: string[] = []
  if (urls.size < RESEARCH_MIN_SOURCES) issues.push(`出处 ${urls.size}/${RESEARCH_MIN_SOURCES} 个（每条结论附真实链接，先 search_web 或派 researcher 去查）`)
  if ([...prose].length < RESEARCH_MIN_CHARS) issues.push(`结论 ${[...prose].length}/${RESEARCH_MIN_CHARS} 字（写清同类作品的结构、手法、节奏和可借鉴点）`)
  return issues
}

/** 研究闸：图里有研究节点且没写满 → 返回拒绝理由；否则 null。 */
export function researchGate(graph: Readonly<ProjectGraph>): string | null {
  const node = graph.nodes[RESEARCH_NODE]
  if (!isResearchNode(node)) return null
  const issues = researchIssues((node!.params as Record<string, Json>).text)
  if (!issues.length) return null
  return `研究先行：research 节点还没写满（${issues.join("；")}）。用 project_patch 的 write_result 把研究写进 research，再开跑生成。`
}
