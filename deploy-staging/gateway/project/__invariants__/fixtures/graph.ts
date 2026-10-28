// 摘要/上下文用的合成图（含 failed / blocked / pinned / drift），以及手写的图节点工厂。
import { invariantIso, INVARIANT_T0 } from "./session.ts"

export interface NodeLike {
  id: string
  type: string
  intent: string
  params: Record<string, unknown>
  inputs: Record<string, { from: string; port?: string }>
  refs: unknown[]
  pinned: null | {
    by: "user" | "agent"
    at: string
    outputsSha: string[]
    signatureAtPin: string
  }
  status: string
  signature: string | null
  lastRun: null | { runId: string; at: string; via: string; signature: string; costCoins: number; attempt: number }
  outputs: unknown[]
  rev: number
  error?: { code: string; message: string; retryable: boolean; at: string }
}

export function nodeLike(id: string, type: string, over: Partial<NodeLike> = {}): NodeLike {
  return {
    id,
    type,
    intent: "",
    params: {},
    inputs: {},
    refs: [],
    pinned: null,
    status: "pending",
    signature: null,
    lastRun: null,
    outputs: [],
    rev: 1,
    ...over,
  }
}

const sha = (c: string) => c.repeat(64)

export function makeDigestGraph(now: string = invariantIso(INVARIANT_T0)) {
  const nodes: Record<string, NodeLike> = {}
  for (let i = 0; i < 40; i++) nodes[`ok_${i}`] = nodeLike(`ok_${i}`, "keyframe", { status: "done", signature: `sig_ok_${i}` })
  for (let i = 0; i < 7; i++) {
    nodes[`fail_${i}`] = nodeLike(`fail_${i}`, "keyframe", {
      status: "failed",
      error: { code: "provider_error", message: `上游 500：模型不可用（第 ${i} 次）`, retryable: true, at: now },
    })
  }
  for (let i = 0; i < 5; i++) nodes[`block_${i}`] = nodeLike(`block_${i}`, "clip", { status: "blocked" })
  for (let i = 0; i < 4; i++) {
    nodes[`pin_${i}`] = nodeLike(`pin_${i}`, "keyframe", {
      status: "done",
      signature: `sig_pin_${i}`,
      pinned: { by: "user", at: now, outputsSha: [sha("a")], signatureAtPin: `sig_pin_${i}` },
    })
  }
  nodes.pin_1.signature = "sig_pin_1_v2"
  nodes.pin_2.signature = "sig_pin_2_v2"
  return {
    schema: 1,
    id: "ses_inv",
    sessionId: "ses_inv",
    version: 7,
    createdAt: now,
    updatedAt: now,
    templateId: "feature_film",
    brief: [] as unknown[],
    decisions: [{ id: "d1", at: now, question: "用 16:9 还是 9:16？", answer: "16:9，别裁我的竖图" }],
    targets: { durationSec: 30, aspect: "16:9", audio: "both", setBy: { kind: "user" }, at: now },
    defaults: { imageModel: "gpt-image-2.5-flare", videoModel: "vid-test", imageSize: "1280x720", style: "胶片感" },
    nodes,
    order: Object.keys(nodes),
    budget: { capCoins: 500, spentCoins: 123, savedCoins: 40 },
    activeRun: null,
    seq: 200,
  }
}

export function makeDigestInputs(now: string = invariantIso(INVARIANT_T0)) {
  return {
    environment: `read_image 可用；image_generate 已折叠到节点；exec-bridge music 可用；${"环境细节".repeat(120)}`,
    preferences: `偏好：中文回答；导出 mp4；不要水印；${"偏好".repeat(200)}`,
    authorization: "full（用户设了完全访问）",
    pending: [{ question: "第三镜要不要补拍？", at: now }],
    recentEvents: Array.from({ length: 14 }, (_, i) => ({
      seq: 180 + i,
      at: now,
      kind: ["node_status", "cost", "pin_drift"][i % 3],
      node: `ok_${i}`,
      data: { status: "done", note: "事件说明" },
    })),
  }
}
