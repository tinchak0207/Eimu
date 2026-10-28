// 工程图 music 执行器（S8a，设计文档 §3.5 music 行 / §3.6）。
//
// 只经 ctx.execBridge.call("music_gen", ...) 调 opencode 进程里的 music_gen 工具；
// 网关不 import runtime 的音乐实现，也不直接 fetch 任何音乐上游（那是第三份实现）。
// 幂等：idemKey 与 submitGeneration 同式（types.ts:224 契约；submit-generation.ts:25 idempotencyKeyOf），
// 桥把它当 musicChargeRef，同 key 二次调用直接回缓存、不再生成也不再扣费。
// 产物只经 ctx.ingest 入库（不设 Output.url，避免 wrapper 的公网发布重复产物）。
//
// J5 版权参数闸：拒绝可能携带在版旋律的入参（abc 乐谱、source_audio/翻唱源、cover 措辞等）。
// 这是**关键词启发式**，不是乐理/音频指纹核对；它能挡住显式参数与明显措辞，挡不住“把旋律写进 prompt
// 的自然语言描述”。局限在 S8a 回报里如实写明。
import type { ExecContext, ExecErrorCode, ExecResult, Json, NodeExecutor, Output } from "../types"
import { NODE_SPECS } from "../specs"
import { defaultClientTimeoutMs } from "../exec-bridge-client.ts"
// S5 的 Idempotency-Key 同式（types.ts:224）；桥拿它当 musicChargeRef，重放同一式就天然幂等。
import { idempotencyKeyOf } from "../submit-generation.ts"

/** 设计文档 §3.5：music 1 币/次（平台目录 x_coins_per_music 的同源口径；实际扣费以桥回执为准）。 */
export const MUSIC_COINS_PER_GENERATION = 1
/** 账本/报价用的模型标识（与平台目录 music-1 同名）。 */
export const MUSIC_MODEL_ID = "music-1"

// ---------------------------------------------------------------- J5 版权参数闸
// 键名归一：小写 + 去掉非字母数字（保留 CJK），sourceAudioSha / source_audio_sha 都落到 sourceaudiosha。
const J5_DENY_KEYS = new Set([
  "abc", "cotmode", "sourceaudio", "sourceaudiosha", "cover", "coverof", "coversong",
  "referenceaudio", "referencesong", "referencemelody", "melodyreference", "originaltrack", "翻唱",
])
const J5_VALUE_MARKERS = /翻唱|翻录|cover of|cover song|covering|same melody|identical melody|原曲旋律|复刻.{0,12}旋律|旋律.{0,6}(一致|相同|照搬)|in the exact style of/i
/** ABC 记谱（X: 序号 + K: 调号）与内嵌音频 base64：两种“把旋律直接喂给模型”的形状。 */
const ABC_SCORE_RE = /(^|\n)\s*X:\s*\d+\s*(\n|$)[\s\S]*(^|\n)\s*K:\s*\S+/m
const EMBEDDED_AUDIO_RE = /^data:audio\//i
const J5_LITERAL_VALUES = /^(abc|cover|source_audio|source_audio_sha|sourceaudiosha|翻唱)$/i

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "")
}

export type MusicRightsGate = { ok: true } | { ok: false; message: string }

/**
 * J5：拒绝可能带在版旋律的入参。返回可读理由（bad_input 的 message）。
 * 只做键名/字符串形状匹配，不做语义判断——见文件头局限说明。
 */
export function checkMusicCopyrightGate(params: Record<string, Json>): MusicRightsGate {
  type Hit = { path: string; detail: string }
  const scan = (value: Json, at: string, depth: number): Hit | null => {
    if (depth > 4) return null
    if (typeof value === "string") {
      if (J5_VALUE_MARKERS.test(value)) return { path: at, detail: "含翻唱/复刻既有歌曲旋律的措辞" }
      if (ABC_SCORE_RE.test(value)) return { path: at, detail: "含 ABC 乐谱（X:/K: 头），可能直接复刻既有旋律" }
      if (EMBEDDED_AUDIO_RE.test(value.trim())) return { path: at, detail: "含内嵌音频数据（可能是参考/翻唱源音频）" }
      if (J5_LITERAL_VALUES.test(value.trim())) return { path: at, detail: `值为「${value.trim()}」，疑似乐谱/翻唱标记` }
      return null
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const hit = scan(value[i], `${at}[${i}]`, depth + 1)
        if (hit) return hit
      }
      return null
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        const path = at ? `${at}.${k}` : k
        if (J5_DENY_KEYS.has(normalizeKey(k))) {
          return { path, detail: `参数键「${k}」属于版权闸禁止的乐谱/参考音频/翻唱入口` }
        }
        const hit = scan(v, path, depth + 1)
        if (hit) return hit
      }
    }
    return null
  }
  const hit = scan(params as Json, "params", 0)
  if (!hit) return { ok: true }
  return {
    ok: false,
    message:
      `音乐版权参数闸（J5）：${hit.path} ${hit.detail}。不交付可能复刻在版歌曲旋律的音频；` +
      "请只用 prompt 描述风格、情绪、配器、BPM、调性，或提供原创歌词。" +
      "（这是关键词启发式拦截，不是乐理核对。）",
  }
}

/** 复用 S5 的 Idempotency-Key（types.ts:224 契约）；桥把它当 musicChargeRef。 */
export function musicIdemKey(ctx: Pick<ExecContext, "project" | "signature" | "take" | "attempt">): string {
  return idempotencyKeyOf({ projectId: ctx.project.id, signature: ctx.signature, take: ctx.take, attempt: ctx.attempt })
}

/** specs 参数名 → music_gen 工具参数名。只转发工具认识的键；durationHint→duration_hint 为显式映射。 */
export function musicBridgeParams(params: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {}
  if (typeof params.prompt === "string") out.prompt = params.prompt
  if (typeof params.lyrics === "string" && params.lyrics.length > 0) out.lyrics = params.lyrics
  if (params.durationHint === "full" || params.durationHint === "clip30") out.duration_hint = params.durationHint
  return out
}

export interface MusicExecutorOptions {
  /** 测试接缝：覆盖桥客户端超时（生产不传，用默认 240s + 15s）。 */
  timeoutMs?: number
}

export function createMusicExecutor(opts: MusicExecutorOptions = {}): NodeExecutor {
  return {
    type: "music",
    specVersion: NODE_SPECS.music.specVersion,

    async estimate(): Promise<number | null> {
      return MUSIC_COINS_PER_GENERATION
    },

    async run(ctx: ExecContext): Promise<ExecResult> {
      const params = ctx.params ?? {}
      const gate = checkMusicCopyrightGate(params)
      if (gate.ok === false) return { ok: false, code: "bad_input", message: gate.message, retryable: false }

      const bridgeParams = musicBridgeParams(params)
      if (typeof bridgeParams.prompt !== "string" || bridgeParams.prompt.trim() === "") {
        return { ok: false, code: "bad_input", message: "music 缺少必填参数 prompt（风格描述）；未提交。", retryable: false }
      }

      const idemKey = musicIdemKey(ctx)
      const common = {
        project_id: ctx.project.id, node_id: ctx.node.id, signature: ctx.signature,
        run_id: ctx.runId, attempt: ctx.attempt, take: ctx.take, idem_key: idemKey,
      }
      const res = await ctx.execBridge.call(
        "music_gen",
        {
          sessionId: ctx.sessionId,
          projectId: ctx.project.id,
          nodeId: ctx.node.id,
          signature: ctx.signature,
          idemKey,
          params: bridgeParams,
        },
        { timeoutMs: opts.timeoutMs ?? defaultClientTimeoutMs("music_gen"), signal: ctx.signal },
      )
      if (res.ok === false) {
        const code: ExecErrorCode = res.code
        if (code !== "bad_input" && code !== "cancelled") {
          await ctx.ledger.write({ ...common, event: "failed", model: MUSIC_MODEL_ID, cost_coins: 0 })
        }
        return { ok: false, code, message: res.message, retryable: res.retryable }
      }
      if (res.files.length === 0) {
        await ctx.ledger.write({ ...common, event: "failed", model: MUSIC_MODEL_ID, cost_coins: 0 })
        return { ok: false, code: "provider_error", message: "exec-bridge 回执成功但没有音频文件；未交付。", retryable: false }
      }

      const outputs: Output[] = []
      // 桥的 ok 回执在契约之外额外透出 chargeError（exec-bridge-client.ts:14 ExecBridgeOk），扣费未确认时在场。
      const chargeError = (res as { chargeError?: string }).chargeError
      for (const f of res.files) {
        const hintMime = f.mime || "audio/mpeg"
        const ingested = await ctx.ingest({ path: f.path }, { port: "out", mime: hintMime, origin: "generated" })
        const meta: Record<string, Json> = {
          provider: res.provider ?? "music_gen",
          cost_coins: res.costCoins,
          ...(res.chargeRef ? { chargeRef: res.chargeRef } : {}),
          ...(chargeError ? { chargeError } : {}),
        }
        outputs.push({
          port: "out",
          artifactId: ingested.artifactId,
          sha256: ingested.sha256,
          path: ingested.path,
          mime: ingested.mime || hintMime,
          bytes: ingested.bytes,
          origin: "generated",
          take: ctx.take,
          ...(typeof f.durationSec === "number" && f.durationSec > 0 ? { durationSec: f.durationSec } : {}),
          meta: {
            ...meta,
            ...(typeof f.durationSec === "number" && f.durationSec > 0 ? { durationSec: f.durationSec } : {}),
          },
        })
      }

      await ctx.ledger.write({ ...common, event: "submitted", model: MUSIC_MODEL_ID, cost_coins: MUSIC_COINS_PER_GENERATION })
      await ctx.ledger.write({
        ...common, event: "completed", model: MUSIC_MODEL_ID, cost_coins: res.costCoins,
        ...(res.chargeRef ? { charge_ref: res.chargeRef } : {}),
        artifact_sha256: outputs[0].sha256,
      })
      return {
        ok: true,
        outputs,
        ...(outputs.length > 1 ? { pool: outputs } : {}),
        costCoins: res.costCoins,
      }
    },
  }
}

export const musicExecutor: NodeExecutor = createMusicExecutor()
