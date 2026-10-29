// 工程图 voice 执行器（S8a，设计文档 §3.5 voice 行）。
//
// 只调 project/speech.ts 的 synthesizeSpeech（旧 handleTts 的唯一实现），不直接碰 TTS 上游。
// 产物经 ctx.ingest 入 artifact-store（内容寻址、sha256），不设 Output.url —— 工程图的
// 发布权归 ctx.ingest / 交付出口，执行器不再走旧的 TTS_PUBLIC_BASE 公网发布面（避免重复发布）。
// durationSec 用 ffprobe 实测后写进 Output 与 meta.durationSec（下游 timeline/mix 需要）。
import { execFile } from "node:child_process"
import { estimateTtsCoins } from "../../pricing-and-validation.ts"
import { releaseGenerationCharge, reserveGenerationCharge, settleGenerationCharge } from "../ledger.ts"
import { idempotencyKeyOf } from "../submit-generation.ts"
import type { ExecContext, ExecErrorCode, ExecResult, NodeExecutor, Output, ProjectNode } from "../types"
import { NODE_SPECS } from "../specs"
import { synthesizeSpeech, TTS_MODEL_ID, type SpeechDeps, type SynthesisErrorCode } from "../speech"
import { restorePaidAudioOutputs } from "./music.ts"
import type { SharedGenerationOperation as SharedJournalOperation } from "../types.ts"

/** ffprobe 实测音频时长（秒）；拿不到 → null（不阻断交付，旧路径也从未要求时长）。 */
export type DurationProbe = (file: string) => Promise<number | null>

const FFPROBE_TIMEOUT_MS = 15_000

export function ffprobeDurationSec(file: string, bin = process.env.FFPROBE_BIN || "ffprobe"): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null)
        const sec = Number(String(stdout).trim())
        resolve(Number.isFinite(sec) && sec > 0 ? sec : null)
      },
    )
  })
}

export interface VoiceExecutorOptions {
  /** 测试接缝：假 TTS 上游、临时目录、确定性 URL。生产不传。 */
  speech?: SpeechDeps
  /** 测试接缝：替换 ffprobe。生产不传。 */
  probeDurationSec?: DurationProbe
}

/** synthesizeSpeech 错误码 → 执行器错误码（text>2000 与旧路由同为“输入错误”，不可重试）。 */
const ERROR_MAP: Record<SynthesisErrorCode, { code: ExecErrorCode; retryable: boolean; ledgerFailure: boolean }> = {
  bad_request: { code: "bad_input", retryable: false, ledgerFailure: false },
  cancelled: { code: "cancelled", retryable: false, ledgerFailure: false },
  tts_unavailable: { code: "provider_error", retryable: true, ledgerFailure: true },
  tts_upstream_error: { code: "provider_error", retryable: true, ledgerFailure: true },
  tts_empty_audio: { code: "provider_error", retryable: true, ledgerFailure: true },
}

export function createVoiceExecutor(opts: VoiceExecutorOptions = {}): NodeExecutor {
  const probeDuration = opts.probeDurationSec ?? ffprobeDurationSec
  return {
    type: "voice",
    specVersion: NODE_SPECS.voice.specVersion,

    async estimate(node: Readonly<ProjectNode>): Promise<number | null> {
      const text = typeof node.params?.text === "string" ? node.params.text.trim() : ""
      if (!text) return null
      return estimateTtsCoins(TTS_MODEL_ID, text)
    },

    async run(ctx: ExecContext): Promise<ExecResult> {
      const text = typeof ctx.params.text === "string" ? ctx.params.text : ""
      const voice = typeof ctx.params.voice === "string" ? ctx.params.voice : undefined
      const speed = typeof ctx.params.speed === "number" && Number.isFinite(ctx.params.speed) ? ctx.params.speed : undefined
      const apiKey = (ctx.session as { apiKey?: string } | null | undefined)?.apiKey
      const quoted = estimateTtsCoins(TTS_MODEL_ID, text.trim())
      const idemKey = idempotencyKeyOf({ projectId: ctx.project.id, signature: ctx.signature, take: ctx.take, attempt: ctx.attempt })
      const common = {
        project_id: ctx.project.id, node_id: ctx.node.id, signature: ctx.signature,
        run_id: ctx.runId, attempt: ctx.attempt, take: ctx.take, idem_key: idemKey,
      }
      let operation: SharedJournalOperation | undefined
      let originalRow: any
      let submitAllowed = true
      try {
        if (ctx.generationOperation) {
          operation = await ctx.generationOperation({ kind: "voice", projectId: ctx.project.id, nodeId: ctx.node.id, signature: ctx.signature, runId: ctx.runId, attempt: ctx.attempt, take: ctx.take, sessionId: ctx.sessionId, idemKey, model: TTS_MODEL_ID, payload: { text, ...(voice ? { voice } : {}), ...(speed !== undefined ? { speed } : {}) }, coins: quoted })
          const reserved = operation.reserve()
          originalRow = reserved.row
          submitAllowed = reserved.submitAllowed
          if (originalRow?.state === "completed") return { ok: true, outputs: await restorePaidAudioOutputs(ctx, originalRow), costCoins: 0 }
        }
      } catch (error) {
        return { ok: false, code: "platform_fault", message: `配音共同账本/已付费回执不可用，未重投：${error instanceof Error ? error.message : String(error)}`, retryable: false, ...(originalRow ? { submitUnknown: true } : {}) }
      }
      const reserved = operation ? { ok: true as const, bound: submitAllowed } : await reserveGenerationCharge(ctx.sessionId, { projectId: ctx.project.id, idemKey, coins: quoted })
      if (reserved.ok === false) return { ok: false, code: reserved.code, message: reserved.message, retryable: reserved.retryable }
      if (reserved.bound) await ctx.ledger.write({ ...common, event: "submitted", model: TTS_MODEL_ID, cost_coins: quoted, idem_key: idemKey })
      const recovered = !submitAllowed ? JSON.parse(originalRow?.registration_json ?? "null")?.rawSpeech : null
      if (!submitAllowed && !recovered?.path) return { ok: false, code: "submit_unknown", message: "配音原提交结果未知；上游没有幂等恢复证明，保留原预留，不重新合成", retryable: false, submitUnknown: true }
      const r: Awaited<ReturnType<typeof synthesizeSpeech>> = recovered ?? await synthesizeSpeech({ text, voice, speed, apiKey, signal: ctx.signal }, opts.speech)
      if (r.ok === false) {
        const mapped = ERROR_MAP[r.code]
        if (operation && !["bad_request", "tts_unavailable"].includes(r.code)) {
          operation.unknown()
          return { ok: false, code: "submit_unknown", message: `配音提交后终态不明，保留原operation只对账：${r.message}`, retryable: false, submitUnknown: true }
        }
        if (reserved.bound) {
          if (operation) operation.reject()
          else releaseGenerationCharge(ctx.sessionId, idemKey)
          await ctx.ledger.write({ ...common, event: "refunded", model: TTS_MODEL_ID, cost_coins: quoted, idem_key: idemKey })
        }
        if (mapped.ledgerFailure) {
          await ctx.ledger.write({ ...common, event: "failed", model: TTS_MODEL_ID, cost_coins: 0 })
        }
        return { ok: false, code: mapped.code, message: r.message, retryable: mapped.retryable }
      }

      operation?.accept(idemKey, { kind: "voice", rawSpeech: r, originalCostCoins: r.costCoins })
      let ingested: Output
      try { ingested = await ctx.ingest(
        { path: r.path },
        { port: "out", mime: "audio/mpeg", origin: "generated" },
      ) } catch (error) {
        return { ok: false, code: "platform_fault", message: `配音已合成，原文件回执保留，入库待恢复：${error instanceof Error ? error.message : String(error)}`, retryable: false, submitUnknown: true }
      }
      const durationSec = await probeDuration(ingested.path)
      const output: Output = {
        port: "out",
        artifactId: ingested.artifactId,
        sha256: ingested.sha256,
        path: ingested.path,
        mime: ingested.mime || "audio/mpeg",
        bytes: ingested.bytes,
        origin: "generated",
        take: ctx.take,
        ...(durationSec !== null ? { durationSec } : {}),
        meta: {
          executedModel: TTS_MODEL_ID,
          chars: r.chars,
          cost_coins: r.costCoins,
          audioOperation: { kind: "voice", idemKey, sessionId: ctx.sessionId, projectId: ctx.project.id, nodeId: ctx.node.id, signature: ctx.signature },
          ...(durationSec !== null ? { durationSec } : {}),
          ...(durationSec === null ? { durationProbe: "unavailable" } : {}),
        },
      }
      if (operation) {
        operation.accept(idemKey, { kind: "voice", outputs: [output], originalCostCoins: r.costCoins })
        operation.settle(r.costCoins)
      } else settleGenerationCharge(ctx.sessionId, idemKey, r.costCoins)
      if (!reserved.bound) await ctx.ledger.write({ ...common, event: "submitted", model: TTS_MODEL_ID, cost_coins: r.costCoins })
      await ctx.ledger.write({ ...common, event: "completed", model: TTS_MODEL_ID, cost_coins: r.costCoins, artifact_sha256: ingested.sha256 })
      return { ok: true, outputs: [output], costCoins: r.costCoins }
    },
  }
}

export const voiceExecutor: NodeExecutor = createVoiceExecutor()
