import * as fsp from "node:fs/promises"
import * as nodePath from "node:path"
import { WORKSPACE, checkAgentPath, looksLikeAgentPath } from "./sandbox"
import { platformFetch } from "./client"
import { stripDataUrlPrefix } from "./music-tools-impl-core"

// <harness-only>
// ── source_audio 输入解析：接受工作区档案路径（2026-10-04 本地参考音档接线）─────────
//
// 背景：source_audio 原本只吃 base64／data: 前缀，模型得把几 MB 音档塞进工具参数，实务上
// 做不到。使用者附件其实已落盘在 agent 工作区 uploads/<session>/，工具端本来就能读档
// （既有流程已把 base64 写成暂存档喂 ffprobe）。故在此把「路径」统一解析成纯 base64，
// 下游扒谱／生成／计费流程一行不动。
//
// 判定顺序 fail-loud（不静默忽略）：
//   ① data: 前缀 → 剥前缀当 base64；
//   ② http(s):// → 本轮不支援，明确报错（不静默忽略）；
//   ③ 看似路径 → **必须**经 checkAgentPath 沙箱白名单（realpath 落 workspace 子树＋
//      uploads 只放行本会话），通过才读档；越权路径一律 path_denied；
//   ④ 其余 → 视为裸 base64。
// 档案大小上限沿用既有读档/音讯上限语义（20MB，同 read_image）；超限明确报错并说出
// 实际大小与上限，**绝不静默截断**（截断后的音讯＝扒谱垃圾）。

/** 源音档档案大小上限（同 read_image 的 20MB 读档口径）。 */
export const MAX_SOURCE_AUDIO_BYTES = 20 * 1024 * 1024

export type SourceAudioResolution = {
  /** 纯 base64（无 data: 前缀，喂 transcribeYue2Score）。 */
  base64: string
  /** 来源种类（除错/回执用，非契约栏位）。 */
  source: "base64" | "data_url" | "workspace_file"
  /** 读档时的音档位元组数（base64/data: 来源为 undefined）。 */
  bytes?: number
  /** 读档时的原始路径（仅 workspace_file）。 */
  path?: string
}

export type SourceAudioResolveResult =
  | { ok: true; value: SourceAudioResolution }
  | { ok: false; code: string; message: string }

/**
 * 把 source_audio 的原始输入（base64／data:／工作区路径）解析成纯 base64。
 * 纯函数语义外的唯一副作用＝读档（路径分支时，且已过沙箱闸）。错误一律回结构化 code/message，
 * 由呼叫端转 fail()（不 throw，保持工具 ok/fail 契约）。
 */
export async function resolveSourceAudio(raw: string, sessionId: string | undefined): Promise<SourceAudioResolveResult> {
  const s = raw.trim()
  if (/^https?:\/\//i.test(s)) {
    return {
      ok: false,
      code: "invalid_args",
      message:
        "source_audio 本轮不支持 http(s) 音频 URL。请改用工作区内的音频文件路径（用户上传的参考音频就在 uploads/<session>/ 下，直接传该路径即可），或直接传音频 base64／data: 前缀。",
    }
  }
  if (/^data:/i.test(s)) {
    return { ok: true, value: { base64: stripDataUrlPrefix(s), source: "data_url" } }
  }
  if (!looksLikeAgentPath(s)) {
    return { ok: true, value: { base64: stripDataUrlPrefix(s), source: "base64" } }
  }
  // 看似路径 → 必须经沙箱白名单闸（不得绕过、不得读工作区外的档）。
  const verdict = checkAgentPath(s, sessionId ?? "")
  if (!verdict.ok) {
    const reasonText: Record<string, string> = {
      outside_workspace: "路径不在创作工作区内",
      internal_state: "路径是平台内部状态目录，不对创作任务开放",
      internal_config: "路径是平台内部配置文件，不对创作任务开放",
      uploads_root: "不能指向全部上传目录",
      foreign_upload: "该附件不属于当前会话",
    }
    return {
      ok: false,
      code: "path_denied",
      message: `source_audio 路径被沙箱拒绝（${reasonText[verdict.reason] ?? verdict.reason}）：${s}。只能读本会话可见的音频文件（推荐 uploads/<session>/ 下的附件），或直接传音频 base64。`,
    }
  }
  const absPath = nodePath.resolve(WORKSPACE, s)
  const limitMb = MAX_SOURCE_AUDIO_BYTES / 1024 / 1024
  let stat: Awaited<ReturnType<typeof fsp.stat>>
  try {
    stat = await fsp.stat(absPath)
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e)
    return {
      ok: false,
      code: "source_audio_read_failed",
      message: `source_audio 读取失败：无法访问文件 ${s}（${errno}）。请确认路径存在且是音频文件，或改传音频 base64。`,
    }
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      code: "source_audio_read_failed",
      message: `source_audio 读取失败：${s} 不是文件（是目录或其他类型）。请指向具体音频文件。`,
    }
  }
  if (stat.size > MAX_SOURCE_AUDIO_BYTES) {
    return {
      ok: false,
      code: "source_audio_too_large",
      message: `source_audio 文件过大：${(stat.size / 1024 / 1024).toFixed(2)} MB，上限 ${limitMb} MB。请先压缩或裁剪源音频后再传（本工具绝不静默截断——截断后的音频会让扒谱失真）。`,
    }
  }
  let buf: Buffer
  try {
    buf = await fsp.readFile(absPath)
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e)
    return { ok: false, code: "source_audio_read_failed", message: `source_audio 读取失败：${s}（${errno}）。` }
  }
  if (buf.byteLength > MAX_SOURCE_AUDIO_BYTES) {
    // stat 与 read 之间档案变大（竞态）；读后复核同样 fail-loud。
    return {
      ok: false,
      code: "source_audio_too_large",
      message: `source_audio 文件过大：${(buf.byteLength / 1024 / 1024).toFixed(2)} MB，上限 ${limitMb} MB（读取后复核，绝不静默截断）。`,
    }
  }
  return { ok: true, value: { base64: buf.toString("base64"), source: "workspace_file", bytes: buf.byteLength, path: s } }
}

/**
 * 音乐生成扣费（2026-10-10「音乐 1 币/次」）：契约＝平台控制面 `POST /v1/music/charges`
 * （biz key 鉴权，请求体只带 `{ ref }`；定价在服务端，1 币/次，同 ref 幂等不双扣；
 * 成功回 `{ ok:true, cost_coins:1 }`、重复回 `{ ..., deduped:true }`、余额不足 402）。
 *
 * 语义与调用纪律：
 * - **先出音频、后扣费**：本 helper 只在回执组装点被呼叫（音频已生成／已上传后才评估），
 *   绝不在生成前扣。
 * - **不双扣**：`ref` 在每次工具调用开始时生成一次（见 execute 内 `musicChargeRef`），
 *   同一次调用内的重试／回落通路沿用同一个 ref，平台按 ref 幂等。
 * - **免费路径不扣**：`probe=true` 与「三通路全失败」都提前 return／throw，到不了呼叫点。
 * - **失败不静默吞**：扣费失败如实回报（回 `cost_coins:null` ＋ `charge_error` ＋ `charge_note`），
 *   不虚报 0，也不因扣费失败丢掉已产出的音频。
 *
 * 账本归属（`takes` 参数）：本次调用只扣 1 次，但 gateway 的 collectToolOutputMediaUrls 会把
 * 顶层 cost_coins 回退贴到**每一张**音频卡（多 take 各一条账本行）。为避免账本合计（N 条 × 1 币）
 * 与实扣（1 币/调用）背离，成功扣费后把非主 take 的 cost_coins 显式标 0，使账本合计 = 实扣。
 */
export async function musicChargeReceiptFields(
  ref: string,
  sessionID: string | undefined,
  takes?: Array<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    const resp = await platformFetch(
      "/music/charges",
      { method: "POST", body: JSON.stringify({ ref }) },
      sessionID ?? "",
    )
    const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>
    if (!resp.ok) {
      // 平台错误封套＝{ error: { message, type, code, param } }（见 src/app/api/v1/music/charges/
      // route.ts 的 errorResponse）——是**物件**不是字串；故先认 error.message，退回 error 字串／
      // 顶层 message，最后才落到 HTTP 码，避免把平台的明文原因吞成泛用「HTTP 4xx/5xx」。
      const errField = body?.error
      const detail =
        typeof errField === "string"
          ? errField
          : errField && typeof errField === "object" && typeof (errField as { message?: unknown }).message === "string"
            ? String((errField as { message?: unknown }).message)
            : typeof body?.message === "string"
              ? body.message
              : `HTTP ${resp.status}`
      return {
        cost_coins: null,
        charge_error: resp.status === 402 ? "余额不足（这笔未扣费）" : `扣费失败（HTTP ${resp.status}）`,
        charge_note: `本次音乐已生成，但平台扣费未完成：${detail}。费用状态以平台账本为准，不得对用户宣称已扣费，也不得当作免费。`,
      }
    }
    if (typeof body?.cost_coins !== "number") {
      return {
        cost_coins: null,
        charge_error: "平台扣费回应缺 cost_coins 字段",
        charge_note: "本次音乐已生成，但平台扣费回应未带 cost_coins，实际费用状态以平台账本为准。",
      }
    }
    // 非主 take 归 0：本次调用只扣 1 次，避免 gateway 把顶层价贴到每张卡使账本虚增（见上方说明）。
    if (takes && takes.length > 1) for (const t of takes.slice(1)) t.cost_coins = 0
    return {
      cost_coins: body.cost_coins,
      ...(body?.deduped === true ? { cost_deduped: true } : {}),
    }
  } catch (e: any) {
    return {
      cost_coins: null,
      charge_error: "扣费呼叫异常",
      charge_note: `本次音乐已生成，但扣费呼叫异常：${e?.message ?? String(e)}。费用状态以平台账本为准。`,
    }
  }
}
// </harness-only>
