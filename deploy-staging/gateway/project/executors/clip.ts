// S7 clip 执行器：逐镜视频生成。
//
// 与 keyframe 同一条提交通道（ctx.submitGeneration，S5）：failover / Idempotency-Key / 收据 / 预算 / 轮询 / 取消退款
// 全在 S5，执行器不 fetch 平台、不新增 env、不重复记账。参数名严格按 NODE_SPECS.clip：
// prompt / model / seconds / resolution / seed / generateAudio / size / styleLock。
// 报价用 pricing-gateway.ts 的 videoNodeCoinsSync（先按 S5 同口径暖一次目录缓存；报不出价 → null）。
import { catalogVideoPerSecondCoins, videoNodeCoinsSync } from "../../pricing-gateway.ts"
import { NODE_SPECS } from "../specs.ts"
import type { ExecContext, ExecResult, NodeExecutor, Output, ProjectGraph, ProjectNode } from "../types.ts"
import {
  apiKeyOf, collectReferenceImages, effectiveParams, failureOf, ingestGenerated, textParam, unresolvedRefs,
} from "./keyframe.ts"

function bad(message: string): ExecResult {
  return { ok: false, code: "bad_input", message, retryable: false }
}

export const clipExecutor: NodeExecutor = {
  type: "clip",
  specVersion: NODE_SPECS.clip.specVersion,
  async estimate(node: Readonly<ProjectNode>, project: Readonly<ProjectGraph>, session: unknown): Promise<number | null> {
    const eff = effectiveParams(node, project)
    const model = textParam(eff.model)
    const apiKey = apiKeyOf(session)
    const seconds = typeof eff.seconds === "number" && eff.seconds > 0 ? eff.seconds : null
    if (!model || !apiKey || seconds === null) return null
    // 与 S5 提交前同一口径：先拿目录（暖 priceCatalogPerSecondCache），再按完整提交档位取币值。
    await catalogVideoPerSecondCoins(model, apiKey)
    const resolution = textParam(eff.resolution)
    const generateAudio = typeof eff.generateAudio === "boolean" ? eff.generateAudio : undefined
    const metadata: Record<string, unknown> = {
      model,
      ...(resolution ? { resolution } : {}),
      ...(generateAudio !== undefined ? { generate_audio: generateAudio } : {}),
    }
    return videoNodeCoinsSync({ id: node.id, metadata }, undefined, seconds)
  },
  async run(ctx: ExecContext): Promise<ExecResult> {
    const eff = effectiveParams(ctx.node, ctx.project)
    const prompt = textParam(eff.prompt)
    const styleLock = textParam(eff.styleLock)
    if (!prompt) return bad(`clip 节点 ${ctx.node.id} 缺少 params.prompt；未提交。`)
    const unresolved = unresolvedRefs({ prompt, styleLock })
    if (unresolved.length) {
      return bad(`clip 节点 ${ctx.node.id} 的 ${unresolved.join("/")} 仍含未解析的 \${...}；禁止把模板变量提交上送，未提交。`)
    }
    const model = textParam(eff.model)
    if (!model) return bad(`clip 节点 ${ctx.node.id} 缺少 params.model（工程 defaults.videoModel 也未设置）；未提交。`)
    const seconds = typeof eff.seconds === "number" && eff.seconds > 0 ? eff.seconds : undefined
    if (seconds === undefined) return bad(`clip 节点 ${ctx.node.id} 缺少 params.seconds；上游按条计费，缺时长不提交。`)

    const refs = collectReferenceImages(ctx)
    if (refs.localOnly.length) {
      return bad(
        `clip 节点 ${ctx.node.id} 的参考图没有公网 URL，只有本地 artifact 路径：${refs.localOnly.join(", ")}；` +
        `上游 reference_images 只接受 http(s)，未截断、未提交。`,
      )
    }

    const size = textParam(eff.size)
    const resolution = textParam(eff.resolution)
    const seed = typeof eff.seed === "number" && Number.isInteger(eff.seed) ? eff.seed : undefined
    const generateAudio = typeof eff.generateAudio === "boolean" ? eff.generateAudio : undefined

    const res = await ctx.submitGeneration({
      kind: "video",
      model,
      prompt,
      seconds,
      ...(size ? { size } : {}),
      ...(resolution ? { resolution } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(generateAudio !== undefined ? { generateAudio } : {}),
      ...(styleLock ? { styleLock } : {}),
      ...(refs.urls.length ? { referenceImages: refs.urls } : {}),
      projectId: ctx.project.id,
      nodeId: ctx.node.id,
      signature: ctx.signature,
      runId: ctx.runId,
      attempt: ctx.attempt,
      take: ctx.take,
      apiKey: apiKeyOf(ctx.session),
      sessionId: ctx.sessionId,
      signal: ctx.signal,
    })
    if (!res.ok) return failureOf(res)!
    if (!res.urls.length) {
      return { ok: false, code: "provider_error", message: `任务 ${res.taskId} 报告成功但没有任何产物 URL；未入库。`, retryable: true, costCoins: res.costCoins }
    }
    let outputs: Output[]
    try {
      outputs = await ingestGenerated(ctx, res.urls, { executedModel: res.executedModel, seed, taskId: res.taskId, durationSec: seconds })
    } catch (error) {
      return {
        ok: false, code: "provider_error", retryable: true, costCoins: res.costCoins,
        message: `任务 ${res.taskId} 已成功但产物入库失败：${error instanceof Error ? error.message : String(error)}；用同一 Idempotency-Key 重试不会重复提交。`,
      }
    }
    return { ok: true, outputs, costCoins: res.costCoins }
  },
}
