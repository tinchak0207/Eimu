// S7 keyframe 执行器：图片生成（参考图 / 关键帧 / 海报 / 详情页，用 params.role 区分用途）。
//
// 唯一提交通道 = ctx.submitGeneration（S5 的 createSubmitGeneration）：模型 failover、Idempotency-Key、
// 收据登记、预算预留、轮询、取消退款都在那里；本执行器不 fetch 平台、不新增 env、不重复记账。
//
// 参数名严格按 NODE_SPECS.keyframe：prompt / model / size / seed / role / n / styleLock / quality。
// ctx.params 是 ${} 解析后的值；提交前再断言 prompt/styleLock 里不含 "${"，防止解析失败静默上送模板变量。
// reference_images 从 ctx.inputs（image/file 口的上游产物）与 ctx.refs 解析：
//   Output.url（公网地址）优先，其次 Output.path（artifact-store 本地路径）。
//   上游只接受 http(s) 参考图；任一参考图只有本地路径 → 明确 bad_input，不静默丢掉参考条件、不提交。
import { estimateNodeCoins } from "../../pricing-gateway.ts"
import { NODE_SPECS, materializeDefaults, portKindOf } from "../specs.ts"
// 产物入库后的 downloaded ACK 归执行器（S2 store.ts 的 ackProjectArtifacts → acknowledgeGeneration(task, "downloaded")，
// stage 与 job-delivery.ts 的既有用法对齐）。调度器不碰 ACK。
import { ackProjectArtifacts } from "../store.ts"
import type {
  ExecContext, ExecResult, Json, NodeExecutor, Output, ProjectGraph, ProjectNode, SubmitGenerationRes,
} from "../types.ts"

/** 显式参数 > 工程 defaults > 硬默认（与 add_node 时的物化同一套，见 specs.materializeDefaults）。 */
export function effectiveParams(node: Readonly<ProjectNode>, project: Readonly<ProjectGraph>): Record<string, Json> {
  return materializeDefaults(node.type, node.id, node.params ?? {}, project.defaults ?? {})
}

export function textParam(v: Json | undefined): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined
}

/** JSON参数的空物化默认{}不是一张工具订单。 */
export function preparedSubmissionOf(value: Json | undefined): import("../types.ts").SubmitGenerationReq["prepared"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const v=value as Record<string,Json>
  if (!v.payload || typeof v.payload!=="object" || Array.isArray(v.payload) || !v.identity || typeof v.identity!=="object" || Array.isArray(v.identity) || typeof v.identity.request_id!=="string") return undefined
  return value as unknown as import("../types.ts").SubmitGenerationReq["prepared"]
}

/** 网关 SessionState 上执行器唯一需要的东西（契约 ExecContext.session 的约定）。 */
export function apiKeyOf(session: unknown): string {
  const key = (session as { apiKey?: unknown } | null)?.apiKey
  return typeof key === "string" ? key : ""
}

export interface ReferencePick {
  urls: string[]
  /** 只有本地 artifact 路径、没有公网 URL 的参考图（上游拒收，必须报错而不是丢弃）。 */
  localOnly: string[]
}

/** 参考图：按 input 名排序（image/file 口）→ 再按 refs.role 排序，去重保序。 */
export function collectReferenceImages(ctx: ExecContext): ReferencePick {
  const picks: { label: string; output: Output }[] = []
  const inputs = ctx.inputs ?? {}
  for (const name of Object.keys(inputs).sort()) {
    const ref = ctx.node.inputs?.[name]
    const upstream = ref ? ctx.project.nodes?.[ref.from] : undefined
    const kind = upstream ? portKindOf(upstream, ref?.port) : null
    if (kind !== "image" && kind !== "file") continue // text/json 是提示词来源，不是参考图
    for (const output of inputs[name] ?? []) picks.push({ label: `inputs.${name}`, output })
  }
  for (const ref of [...(ctx.refs ?? [])].sort((a, b) => String(a.role).localeCompare(String(b.role)))) {
    picks.push({ label: `refs.${ref.role}`, output: ref.output })
  }
  const urls: string[] = []
  const localOnly: string[] = []
  for (const { label, output } of picks) {
    const url = typeof output.url === "string" && output.url ? output.url : undefined
    if (url) {
      if (!urls.includes(url)) urls.push(url)
      continue
    }
    const why = `${label}=${output.artifactId}`
    if (!localOnly.includes(why)) localOnly.push(why)
  }
  return { urls, localOnly }
}

/** 提交结果 → 失败 ExecResult（错误码/可重试/未知状态原样透传，执行器不改写语义）；成功回 null。 */
export function failureOf(res: SubmitGenerationRes): ExecResult | null {
  if (!("code" in res)) return null
  return {
    ok: false, code: res.code, message: res.message, retryable: res.retryable,
    ...(res.submitUnknown ? { submitUnknown: true } : {}),
    costCoins: 0,
  }
}

/** 产物统一经 ctx.ingest 入库（sha256 由 artifact-store 实算）；url 保留在 Output 上供下游参考图使用。
 *  全部产物入库后立刻记 downloaded ACK —— ACK 只认“全部权威产物一次覆盖”（job-store 按 url 全量对齐）。
 *  ACK 失败不 fail-closed（与 S5 的轮询记账同语义）：产物已入库、账已记，只打日志留痕，不把已花钱的成功翻成失败。 */
export async function ingestGenerated(
  ctx: ExecContext,
  urls: string[],
  extra: { executedModel?: string; seed?: number; taskId?: string; durationSec?: number },
): Promise<Output[]> {
  const outputs: Output[] = []
  for (const url of urls) {
    const out = await ctx.ingest({ url }, { port: "out", origin: "generated" })
    outputs.push({
      ...out,
      port: "out",
      url,
      ...(ctx.node.takes ? { take: ctx.take } : {}),
      ...(typeof extra.durationSec === "number" ? { durationSec: extra.durationSec } : {}),
      meta: {
        ...(out.meta ?? {}),
        ...(extra.executedModel ? { executedModel: extra.executedModel } : {}),
        ...(typeof extra.seed === "number" ? { seed: extra.seed } : {}),
        ...(extra.taskId ? { task_id: extra.taskId } : {}),
      },
    })
  }
  // 同步回图兜底（S5 的 taskId=""）没有收据可 ACK，直接跳过。
  if (extra.taskId) {
    try {
      ackProjectArtifacts(extra.taskId, outputs)
    } catch (error) {
      console.error(`[project] downloaded ACK failed task=${extra.taskId} node=${ctx.node.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return outputs
}

function bad(message: string): ExecResult {
  return { ok: false, code: "bad_input", message, retryable: false }
}

/** 提交前硬闸：解析后的字符串里不得再有 ${...}；返回含未解析引用的参数名。 */
export function unresolvedRefs(values: Record<string, string | undefined>): string[] {
  return Object.entries(values).filter(([, v]) => typeof v === "string" && v.includes("${")).map(([k]) => k)
}

export const keyframeExecutor: NodeExecutor = {
  type: "keyframe",
  specVersion: NODE_SPECS.keyframe.specVersion,
  async estimate(node: Readonly<ProjectNode>, project: Readonly<ProjectGraph>, session: unknown): Promise<number | null> {
    const eff = effectiveParams(node, project)
    const model = textParam(eff.model)
    const apiKey = apiKeyOf(session)
    if (!model || !apiKey) return null // 报不出价：不猜目录价
    const quality = textParam(eff.quality)
    const unit = await estimateNodeCoins({ kind: "image", metadata: { model } }, apiKey, undefined, quality)
    if (unit === null) return null
    const n = typeof eff.n === "number" && Number.isInteger(eff.n) && eff.n > 0 ? eff.n : 1
    return Math.round(unit * n * 1e6) / 1e6 // S5 的 cost = unit × n，报价同口径
  },
  async run(ctx: ExecContext): Promise<ExecResult> {
    const eff = effectiveParams(ctx.node, ctx.project)
    const prompt = textParam(eff.prompt)
    const styleLock = textParam(eff.styleLock)
    if (!prompt) return bad(`keyframe 节点 ${ctx.node.id} 缺少 params.prompt；未提交。`)
    const unresolved = unresolvedRefs({ prompt, styleLock })
    if (unresolved.length) {
      return bad(`keyframe 节点 ${ctx.node.id} 的 ${unresolved.join("/")} 仍含未解析的 \${...}；禁止把模板变量提交上送，未提交。`)
    }
    const model = textParam(eff.model)
    if (!model) return bad(`keyframe 节点 ${ctx.node.id} 缺少 params.model（工程 defaults.imageModel 也未设置）；未提交。`)

    const refs = collectReferenceImages(ctx)
    if (refs.localOnly.length) {
      return bad(
        `keyframe 节点 ${ctx.node.id} 的参考图没有公网 URL，只有本地 artifact 路径：${refs.localOnly.join(", ")}；` +
        `上游 reference_images 只接受 http(s)，未截断、未提交。`,
      )
    }

    const n = typeof eff.n === "number" && Number.isInteger(eff.n) && eff.n > 0 ? eff.n : 1
    const seed = typeof eff.seed === "number" && Number.isInteger(eff.seed) ? eff.seed : undefined
    const size = textParam(eff.size)
    const quality = textParam(eff.quality)

    const res = await ctx.submitGeneration({
      ...(preparedSubmissionOf(eff.toolSubmission) ? { prepared: preparedSubmissionOf(eff.toolSubmission) } : {}),
      kind: "image",
      model,
      prompt,
      n,
      ...(size ? { size } : {}),
      ...(quality ? { quality } : {}),
      ...(seed !== undefined ? { seed } : {}),
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
      outputs = await ingestGenerated(ctx, res.urls, { executedModel: res.executedModel, seed, taskId: res.taskId })
    } catch (error) {
      // 已花钱的产物在本地入库失败：保留成本事实，可重试（同 idemKey 上游去重，不会二次扣费）。
      return {
        ok: false, code: "provider_error", retryable: true, costCoins: res.costCoins,
        message: `任务 ${res.taskId} 已成功但产物入库失败：${error instanceof Error ? error.message : String(error)}；用同一 Idempotency-Key 重试不会重复提交。`,
      }
    }
    return { ok: true, outputs, costCoins: res.costCoins }
  },
}
