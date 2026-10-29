import type { NewNode } from "../types.ts"

/** 原地保留配方全部制作节点，只拆开既有 export 的合成与发布职责。 */
export function withReviewedCandidate(nodes: NewNode[]): NewNode[] {
  const final = nodes.find((n) => n.id === "export" && n.type === "export")
  if (!final || final.params?.preset === "image_pack") return nodes
  const sourceInputs = Object.fromEntries(Object.entries(final.inputs ?? {}).filter(([name]) => name !== "machine" && name !== "verdict"))
  const candidate: NewNode = {
    id: "candidate", type: "export", intent: "完整最终候选：所有镜头、混音与字幕合成，独立审片前不作最终交付",
    params: { ...final.params, stage: "candidate" }, inputs: sourceInputs,
  }
  let candidateInserted = false
  return nodes.flatMap((node) => {
    if (node.id === "qc" || node.id === "qc_look") {
      const { onFail: _oldRecheck, ...kept } = node
      const thresholds = { ...(node.params?.thresholds as Record<string, import("../types.ts").Json> ?? {}) }
      delete thresholds.requireAudio // 声音是否必需由真实目标决定，保留 audio:none。
      delete thresholds.maxDurationSec // 旧段落阈值不能误作完整影片上限。
      const before = candidateInserted ? [] : [candidate]
      candidateInserted = true
      return [...before, { ...kept, params: { ...node.params, thresholds, ...(node.params?.mode === "critic" ? { rubric: "film_final_critic" } : {}) }, inputs: { final: { from: "candidate" } }, intent: "检查完整候选及用户实际要求，失败交给作者定向修改后再审，禁止只重审同一素材。" }]
    }
    if (node === final) return [...(candidateInserted ? [] : [candidate]), { ...node, params: { ...node.params, stage: "publish" }, inputs: {
      candidate: { from: "candidate" }, machine: { from: "qc" }, verdict: { from: "qc_look" },
      jianying: { from: "candidate", port: "jianying" }, fcpxml: { from: "candidate", port: "fcpxml" },
    } }]
    return [node]
  })
}
