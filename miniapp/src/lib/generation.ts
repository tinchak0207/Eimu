import Taro from '@tarojs/taro'
import { ApiError, BASE_URL, request } from './request'
import { getToken, getUserId } from './storage'

export type GenerationTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'refunded'
  | 'unknown'

export interface GenerationTaskResult {
  resultId: string
  taskId: string
  outputIndex: number
  url: string | null
  mimeType: string
  width: number | null
  height: number | null
}

/** 服务端 NormalizedGenerationConfig 里本项目用得到的那几槽（不用全量镜像）。 */
export interface GenerationSubmittedConfig {
  modelId?: string
  mediaType?: string
  aspectRatio?: string
  outputResolution?: string
  qualityMode?: string
  durationSeconds?: number
  generateAudio?: boolean
}

/** 与服务端 src/lib/generation-task-types.ts 的 GenerationTaskProjection 同形。 */
export interface GenerationTask {
  taskId: string
  status: GenerationTaskStatus
  modelId: string
  kind: 'image_generate' | 'image_edit' | 'video_generate' | 'tts' | 'avatar' | 'lipsync'
  submittedConfig?: GenerationSubmittedConfig
  prompt?: string
  resultIds?: string[]
  primaryResultId?: string
  results: GenerationTaskResult[]
  requestedCount: number
  completedCount: number
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
  errorCode?: string
  errorMessage?: string
}

/** 参考图角色：与服务端 ReferenceRole（generation-jobs/route.ts:108-111）同值域。 */
export type ReferenceRole = 'general' | 'character' | 'face' | 'product' | 'style' | 'composition'

/**
 * 一张待上传的参考图。
 *
 * `path` 是 chooseMedia 返回的本地临时路径；文件字节在提交时现读（base64 →
 * multipart 二进制），不在 state 里囤 base64，避免多图时内存翻倍。
 */
export interface ReferenceImageInput {
  id: string
  name: string
  role?: ReferenceRole
  sourceResultId?: string
  sourceGenerationId?: string
  path: string
  size?: number
}

export interface SubmitGenerationInput {
  prompt: string
  modelId: string
  aspectRatio: string
  outputResolution: string
  qualityMode?: 'fast' | 'quality'
  userId: number
  /** 非空时走 multipart（与网页端 use-image-generation.ts:631-660 同一契约）。 */
  referenceImages?: ReferenceImageInput[]
  durationSeconds?: number
  generateAudio?: boolean
  workflow?: unknown
  retryOfTaskId?: string
}

/** 认证头：与 request.ts:68-75 同源（multipart 绕开 request 时必须自己补）。 */
function authHeaders(): Record<string, string> {
  const token = getToken()
  const userId = getUserId()
  if (!token || !userId) {
    throw new ApiError('尚未登录，请先登录', 401, 'not_authenticated')
  }
  return {
    Authorization: `Bearer ${token}`,
    'x-user-id': String(userId),
  }
}

/** 提交生成任务：POST /api/generation-jobs（响应 202 {success, data: task}）。 */
export async function submitGeneration(input: SubmitGenerationInput): Promise<GenerationTask> {
  const references = input.referenceImages ?? []
  const idempotencyKey = `mp-${input.userId}-${Date.now()}`
  const payload = references.length
    ? await submitMultipartGeneration(input, references, idempotencyKey)
    : await request<{
        success?: boolean
        data?: GenerationTask
        error?: string
        code?: string
      }>({
        path: '/api/generation-jobs',
        method: 'POST',
        data: {
          prompt: input.prompt,
          modelId: input.modelId,
          aspectRatio: input.aspectRatio,
          outputResolution: input.outputResolution,
          qualityMode: input.qualityMode ?? 'fast',
        },
        header: {
          'Idempotency-Key': idempotencyKey,
        },
      })

  if (!payload?.data?.taskId) {
    throw new ApiError(payload?.error || '任务提交失败', 502, payload?.code || 'submit_failed')
  }
  return payload.data
}

/* ────────────────────────────────────────────────────────────────────────
 * multipart 参考图提交
 *
 * 小程序没有 FormData：这里按 RFC 7578 手拼 body（文本字段 UTF-8 编码、文件字段
 * 二进制原样），再用 Taro.request 发 ArrayBuffer。字段名与顺序逐条对应网页端
 * src/hooks/use-image-generation.ts:631-660：
 *   prompt / modelId / qualityMode / aspectRatio / outputResolution /
 *   durationSeconds / generateAudio / workflow / retryOfTaskId /
 *   referenceMetadata(JSON 数组) / referenceImages(文件, 可多个)
 * 服务端解析见 src/app/api/generation-jobs/route.ts:114-138。
 * ──────────────────────────────────────────────────────────────────────── */

const MULTIPART_CRLF = '\r\n'
const REFERENCE_MAX_BYTES = 12 * 1024 * 1024

/** UTF-8 编码（微信基础库没有 TextEncoder，手写避免依赖）。 */
function utf8Encode(value: string): Uint8Array {
  const bytes: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    let code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        index += 1
      }
    }
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return new Uint8Array(bytes)
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 微信没有 atob；readFile 的 base64 在这里解成二进制。 */
function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, '')
  const output = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let buffer = 0
  let bits = 0
  let written = 0
  for (let index = 0; index < clean.length; index += 1) {
    const value = BASE64_ALPHABET.indexOf(clean[index])
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      output[written] = (buffer >> bits) & 0xff
      written += 1
    }
  }
  return written === output.length ? output : output.subarray(0, written)
}

function concatBytes(parts: Uint8Array[]): ArrayBuffer {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.length
  }
  return merged.buffer as ArrayBuffer
}

function textPart(boundary: string, name: string, value: string): Uint8Array {
  return utf8Encode(
    `--${boundary}${MULTIPART_CRLF}`
      + `Content-Disposition: form-data; name="${name}"${MULTIPART_CRLF}${MULTIPART_CRLF}`
      + `${value}${MULTIPART_CRLF}`,
  )
}

function filePart(
  boundary: string,
  name: string,
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
): Uint8Array[] {
  return [
    utf8Encode(
      `--${boundary}${MULTIPART_CRLF}`
        + `Content-Disposition: form-data; name="${name}"; filename="${filename}"${MULTIPART_CRLF}`
        + `Content-Type: ${mimeType}${MULTIPART_CRLF}${MULTIPART_CRLF}`,
    ),
    bytes,
    utf8Encode(MULTIPART_CRLF),
  ]
}

function mimeTypeFromName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.heic')) return 'image/heic'
  return 'image/png'
}

function extensionFromMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/gif') return 'gif'
  if (mimeType === 'image/heic') return 'heic'
  return 'png'
}

/** 按文件头识别图片 MIME（jpg/png/webp/gif），识别不出用 fallback。 */
function sniffImageMime(bytes: Uint8Array, fallback: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  return fallback
}

/** 读本地临时文件为 base64（chooseMedia → 提交时才读，省内存）。 */
function readFileBase64(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    Taro.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (result) => {
        if (typeof result.data !== 'string' || !result.data) {
          reject(new ApiError('读取图片失败：文件为空', 0, 'read_file_failed'))
          return
        }
        resolve(result.data)
      },
      fail: (error) => {
        reject(new ApiError(`读取图片失败：${error?.errMsg || '未知错误'}`, 0, 'read_file_failed'))
      },
    })
  })
}

type GenerationSubmitPayload = {
  success?: boolean
  data?: GenerationTask
  error?: string
  message?: string
  code?: string
}

function generationSubmitBody(data: unknown): GenerationSubmitPayload {
  return (data && typeof data === 'object' ? data : {}) as GenerationSubmitPayload
}

/** 两条上传通道（手拼 multipart / uploadFile 退路）共用的响应判定。 */
function assertGenerationSubmitResponse(response: {
  statusCode: number
  data: unknown
}): GenerationSubmitPayload {
  const body = generationSubmitBody(response.data)
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new ApiError(
      body.error || body.message || `任务提交失败（${response.statusCode}）`,
      response.statusCode,
      body.code || `http_${response.statusCode}`,
    )
  }
  if (!body.data?.taskId) {
    throw new ApiError(body.error || body.message || '任务提交失败', 502, body.code || 'submit_failed')
  }
  return body
}

/**
 * 退路：`Taro.uploadFile` 单图（任务书指定的兜底通道）。
 *
 * 只在手拼 multipart 出现**网络层异常**（Taro.request reject，拿不到任何 HTTP 响应）
 * 且恰好 1 张参考图时走这里：uploadFile 一次只能带一个文件，多图无法表达。
 *
 * 复用同一个 `Idempotency-Key`：服务端 command-service.ts:128/177 按
 * `(tenant_id, idempotency_key)` 去重，网络抖动后的重试不会二次建单/二次扣费。
 */
async function submitSingleReferenceGeneration(
  input: SubmitGenerationInput,
  image: ReferenceImageInput,
  idempotencyKey: string,
): Promise<GenerationSubmitPayload> {
  const formData: Record<string, string> = {
    prompt: input.prompt,
    modelId: input.modelId,
    qualityMode: input.qualityMode ?? 'fast',
    aspectRatio: input.aspectRatio,
    outputResolution: input.outputResolution,
    referenceMetadata: JSON.stringify([{
      id: image.id,
      name: image.name,
      role: image.role ?? 'general',
      sourceResultId: image.sourceResultId,
      sourceGenerationId: image.sourceGenerationId,
    }]),
  }
  if (input.durationSeconds !== undefined) formData.durationSeconds = String(input.durationSeconds)
  if (typeof input.generateAudio === 'boolean') formData.generateAudio = String(input.generateAudio)
  if (input.workflow) formData.workflow = JSON.stringify(input.workflow)
  if (input.retryOfTaskId) formData.retryOfTaskId = input.retryOfTaskId

  let result: Taro.uploadFile.SuccessCallbackResult
  try {
    result = await Taro.uploadFile({
      url: `${BASE_URL}/api/generation-jobs`,
      filePath: image.path,
      name: 'referenceImages',
      formData,
      header: {
        ...authHeaders(),
        'Idempotency-Key': idempotencyKey,
      },
      timeout: 120_000,
    })
  } catch (error) {
    const message = (error as { errMsg?: string } | null)?.errMsg || '网络异常'
    throw new ApiError(`参考图上传失败：${message}`, 0, 'upload_failed')
  }

  let parsed: unknown = {}
  try {
    parsed = JSON.parse(result.data) as unknown
  } catch {
    // 非 JSON（网关 413/HTML 错误页）按空体处理，交给统一判定给出状态码文案。
  }
  return assertGenerationSubmitResponse({ statusCode: result.statusCode, data: parsed })
}

async function submitMultipartGeneration(
  input: SubmitGenerationInput,
  references: ReferenceImageInput[],
  idempotencyKey: string,
): Promise<GenerationSubmitPayload> {
  const oversized = references.find((image) => (image.size ?? 0) > REFERENCE_MAX_BYTES)
  if (oversized) {
    throw new ApiError(`参考图「${oversized.name}」超过 12MB，请换小一点的图片。`, 0, 'reference_too_large')
  }

  const boundary = `----EimuMiniapp${Date.now()}${Math.random().toString(36).slice(2, 10)}`
  const parts: Uint8Array[] = [
    textPart(boundary, 'prompt', input.prompt),
    textPart(boundary, 'modelId', input.modelId),
    textPart(boundary, 'qualityMode', input.qualityMode ?? 'fast'),
    textPart(boundary, 'aspectRatio', input.aspectRatio),
    textPart(boundary, 'outputResolution', input.outputResolution),
  ]
  if (input.durationSeconds !== undefined) {
    parts.push(textPart(boundary, 'durationSeconds', String(input.durationSeconds)))
  }
  if (typeof input.generateAudio === 'boolean') {
    parts.push(textPart(boundary, 'generateAudio', String(input.generateAudio)))
  }
  if (input.workflow) {
    parts.push(textPart(boundary, 'workflow', JSON.stringify(input.workflow)))
  }
  if (input.retryOfTaskId) {
    parts.push(textPart(boundary, 'retryOfTaskId', input.retryOfTaskId))
  }
  parts.push(
    textPart(
      boundary,
      'referenceMetadata',
      JSON.stringify(references.map((image) => ({
        id: image.id,
        name: image.name,
        role: image.role ?? 'general',
        sourceResultId: image.sourceResultId,
        sourceGenerationId: image.sourceGenerationId,
      }))),
    ),
  )

  for (let index = 0; index < references.length; index += 1) {
    const image = references[index]
    const base64 = await readFileBase64(image.path)
    const bytes = base64ToBytes(base64)
    // chooseMedia 的临时文件名不可靠（常无扩展名）→ 用文件头定 MIME，文件名兜底。
    const mimeType = sniffImageMime(bytes, mimeTypeFromName(image.name || image.path))
    parts.push(...filePart(boundary, 'referenceImages', `reference-${index + 1}.${extensionFromMime(mimeType)}`, mimeType, bytes))
  }
  parts.push(utf8Encode(`--${boundary}--${MULTIPART_CRLF}`))

  let response: Taro.request.SuccessCallbackResult<unknown>
  try {
    response = await Taro.request({
      url: `${BASE_URL}/api/generation-jobs`,
      method: 'POST',
      data: concatBytes(parts) as Taro.request.Option['data'],
      header: {
        ...authHeaders(),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Idempotency-Key': idempotencyKey,
      },
      dataType: 'json',
      timeout: 120_000,
    })
  } catch (error) {
    // 手拼 multipart 在部分基础库/代理上会在网络层直接失败（拿不到 HTTP 响应）。
    // 单图时退回 Taro.uploadFile（同一 Idempotency-Key，服务端幂等，不会重复建单）。
    if (references.length === 1) {
      return submitSingleReferenceGeneration(input, references[0], idempotencyKey)
    }
    const message = (error as { errMsg?: string } | null)?.errMsg || '网络异常'
    throw new ApiError(`参考图上传失败：${message}`, 0, 'upload_failed')
  }

  return assertGenerationSubmitResponse(response)
}

/* ────────────────────────────────────────────────────────────────────────
 * 改图 / 放大（网页端用户态链路，逐行对应）
 *
 *   /api/pixai/upload  ← src/components/pixai-tools/shared.ts:128-144
 *   /api/pixai/edit    ← src/components/pixai-tools/shared.ts:147-177
 *                        body { image: mediaId, prompt, size, n: 1 }
 *   /api/pixai/upscale ← src/components/pixai-tools/shared.ts:180-209
 *                        body { image: mediaId, factor, size?, ... }
 *
 * 这是浏览器用户态（authenticateImageUser）走的那条，不是 B 端密钥的 /v1/*。
 * ──────────────────────────────────────────────────────────────────────── */

const PIXAI_UPLOAD_TIMEOUT_MS = 60_000
/** 改图 / 放大同步阻塞（网页端实测 ~10s / ~22s，路由 maxDuration 300s）。 */
const PIXAI_GENERATE_TIMEOUT_MS = 280_000

export interface LocalImagePayload {
  base64: string
  mimeType: string
}

async function downloadToTempFile(url: string): Promise<string> {
  let result: Awaited<ReturnType<typeof Taro.downloadFile>>
  try {
    result = await Taro.downloadFile({ url })
  } catch (error) {
    const message = (error as { errMsg?: string } | null)?.errMsg || '图片下载失败'
    throw new ApiError(`读取图片失败：${message}`, 0, 'download_failed')
  }
  if (result.statusCode !== 200 || !result.tempFilePath) {
    throw new ApiError(`图片下载失败（${result.statusCode}）`, 0, 'download_failed')
  }
  return result.tempFilePath
}

/** 归一化来源图：本地临时路径直读；http(s) URL 先 downloadFile 再读。 */
export async function readLocalImagePayload(input: {
  path?: string
  url?: string
}): Promise<LocalImagePayload> {
  const source = input.path || input.url || ''
  if (!source) throw new ApiError('缺少图片来源', 0, 'missing_image')
  // 历史卡片的 base64 结果是 data URL，直接拆出裸 base64，不落地成文件。
  const inline = /^data:([^;]+);base64,(.+)$/i.exec(source)
  if (inline) return { base64: inline[2], mimeType: inline[1] }
  const filePath = /^https?:\/\//i.test(source) ? await downloadToTempFile(source) : source
  const base64 = await readFileBase64(filePath)
  return { base64, mimeType: sniffImageMime(base64ToBytes(base64), mimeTypeFromName(filePath)) }
}

/** 上传 base64 到 /api/pixai/upload，返回 mediaId（不扣费，只校验登录）。 */
export async function uploadPixaiMedia(payload: LocalImagePayload): Promise<string> {
  const body = await request<{ mediaId?: string; success?: boolean; message?: string }>({
    path: '/api/pixai/upload',
    method: 'POST',
    data: { data: payload.base64, mimeType: payload.mimeType },
    timeout: PIXAI_UPLOAD_TIMEOUT_MS,
  })
  const mediaId = typeof body?.mediaId === 'string' ? body.mediaId : ''
  if (!mediaId) {
    throw new ApiError(body?.message || '上传失败：未返回 mediaId', 502, 'upload_failed')
  }
  return mediaId
}

interface PixaiImageResponse {
  data?: Array<{ url?: string; b64_json?: string }>
  url?: string
  images?: Array<{ url?: string; base64?: string }>
}

function firstImageUrl(body: PixaiImageResponse | null, fallback: string): string {
  const first = Array.isArray(body?.data) ? body.data[0] : undefined
  const url = first?.url
    || first?.b64_json
    || body?.url
    || (Array.isArray(body?.images) ? body.images[0]?.url ?? body.images[0]?.base64 ?? '' : '')
  if (!url) throw new ApiError(fallback, 502, 'missing_image_result')
  return url
}

/** 改图：POST /api/pixai/edit，返回成图 URL（或 base64 data URL）。 */
export async function runPixaiEdit(input: {
  mediaId: string
  prompt: string
  size: string
}): Promise<string> {
  const body = await request<PixaiImageResponse>({
    path: '/api/pixai/edit',
    method: 'POST',
    data: {
      image: input.mediaId,
      prompt: input.prompt,
      size: input.size,
      n: 1,
    },
    timeout: PIXAI_GENERATE_TIMEOUT_MS,
  })
  return firstImageUrl(body, '改图失败：未返回图片')
}

/** 高清放大：POST /api/pixai/upscale。size 传原图 "WxH"，服务端按它归类计费。 */
export async function runPixaiUpscale(input: {
  mediaId: string
  factor?: number
  size?: string
}): Promise<string> {
  const body = await request<PixaiImageResponse>({
    path: '/api/pixai/upscale',
    method: 'POST',
    data: {
      image: input.mediaId,
      factor: input.factor ?? 2,
      ...(input.size ? { size: input.size } : {}),
    },
    timeout: PIXAI_GENERATE_TIMEOUT_MS,
  })
  return firstImageUrl(body, '放大失败：未返回图片')
}

/**
 * 能否在小程序里「再来一张」：只放行纯文生图。
 *
 * image_edit 的参考图文件与 LoRA 版本都不在提交契约里（小程序不带 multipart），
 * 视频的 durationSeconds/generateAudio 也不在契约内——硬重跑会静默换成默认时长、
 * 或让编辑任务丢了参考图还照收钱，所以一概不放行，由调用方隐藏按钮。
 */
export function canRerunTask(task: GenerationTask): boolean {
  return task.kind === 'image_generate' && Boolean(task.prompt?.trim())
}

/**
 * 「再来一张」：按原任务配方重跑，直接复用 submitGeneration（不另写提交链）。
 *
 * 原样回填：prompt、modelId（submittedConfig.modelId → task.modelId）、
 * aspectRatio、outputResolution、qualityMode——正是 POST /api/generation-jobs
 * 的契约字段，服务端会再用 normalizeGenerationConfig 校验一次。
 *
 * 刻意不带：durationSeconds / generateAudio（视频专用，契约外）、referenceCount /
 * loraModelVersionIds（需要对应文件，小程序没有上传通道）、retryOfTaskId（血缘字段，
 * 当前没有对应 UI；且编辑任务靠它继承参考图，只带 id 不带图会造成半套语义）。
 */
export async function rerunFromTask(task: GenerationTask): Promise<GenerationTask> {
  const prompt = (task.prompt ?? '').trim()
  if (!prompt) {
    throw new ApiError('这条作品没有可复用的描述，无法重跑', 0, 'missing_prompt')
  }
  if (!canRerunTask(task)) {
    throw new ApiError('视频与编辑作品暂不支持在小程序重跑', 0, 'rerun_unsupported')
  }
  const userId = getUserId()
  if (!userId) {
    throw new ApiError('尚未登录，请先登录', 401, 'not_authenticated')
  }
  const config = task.submittedConfig
  return submitGeneration({
    prompt,
    modelId: config?.modelId || task.modelId,
    aspectRatio: config?.aspectRatio || '1:1',
    outputResolution: config?.outputResolution || '1k',
    qualityMode: config?.qualityMode === 'quality' ? 'quality' : 'fast',
    userId,
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const TERMINAL_FAILED: GenerationTaskStatus[] = ['failed', 'cancelled', 'refunded', 'unknown']

/**
 * 轮询单个任务。逻辑照抄网页端 src/hooks/use-image-generation.ts 的
 * waitForGenerationTask：总时限 15 分钟、成功/终态判定、网关瞬时错误重试。
 */
export async function waitForGenerationTask(
  taskId: string,
  onTask?: (task: GenerationTask) => void,
  isCancelled?: () => boolean,
): Promise<GenerationTask> {
  const deadline = Date.now() + 15 * 60_000
  let consecutiveGatewayErrors = 0

  while (Date.now() < deadline) {
    if (isCancelled?.()) {
      throw new ApiError('已停止等待，可到「作品」页查看结果', 0, 'polling_cancelled')
    }

    let task: GenerationTask | null = null
    let fetchFailed = false

    try {
      const data = await request<GenerationTask>({
        path: `/api/generation-jobs/${encodeURIComponent(taskId)}`,
      })
      if (!data || typeof data.taskId !== 'string') {
        fetchFailed = true
      } else {
        task = data
      }
    } catch (error) {
      const apiError = error instanceof ApiError
        ? error
        : new ApiError('任务查询失败', 0, 'polling_failed')
      if (apiError.code === 'not_authenticated' || apiError.code === 'unauthorized') {
        throw apiError
      }
      // 5xx / 429 / 网络错误是瞬时故障，继续轮询；其余 4xx 是真实拒绝。
      if (apiError.status >= 500 || apiError.status === 429 || apiError.status === 0) {
        fetchFailed = true
      } else {
        throw apiError
      }
    }

    if (fetchFailed || !task) {
      consecutiveGatewayErrors += 1
      if (consecutiveGatewayErrors > 20) {
        throw new ApiError('生成任务查询持续失败（网关异常），请稍后到「作品」页查看。', 0, 'polling_gateway_error')
      }
      await sleep(3_000)
      continue
    }

    consecutiveGatewayErrors = 0
    onTask?.(task)

    if (task.status === 'succeeded') return task
    if (TERMINAL_FAILED.includes(task.status)) {
      throw new ApiError(
        task.errorMessage || `生成任务结束：${task.status}`,
        0,
        task.errorCode || task.status,
      )
    }

    await sleep(1_000)
  }

  throw new ApiError('生成任务仍在运行，请到「作品」页稍后查看。', 0, 'polling_timeout')
}
