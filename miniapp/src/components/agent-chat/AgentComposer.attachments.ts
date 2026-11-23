import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import Taro from '@tarojs/taro'
import { BASE_URL } from '../../lib/request'
import { getToken, getUserId } from '../../lib/storage'
import type { AgentAttachmentRef, MiniPickedFile, PendingAttachment } from './AgentComposer.types'
import {
  MAX_FILE_BYTES,
  PLAIN_UPLOAD_TIMEOUT_MS,
  UploadAbortedError,
  UploadTimeoutError,
  formatMb,
  withUploadDeadline,
} from './AgentComposer.upload-limits'

/**
 * 附件层：纯函数（与网页版 AgentComposer.attachments.ts 同语义）＋小程序上传管道。
 *
 * 平台差异（白名单）：
 *   - `File` → `MiniPickedFile`（Taro.chooseMedia 的 tempFilePath）；
 *   - FormData/XHR → `Taro.uploadFile`（multipart 由平台补 boundary）；
 *   - Object URL revoke → 无（小程序临时文件由平台回收）；
 *   - 抽帧/本机 ingest/直传票券 → 小程序不做（只走站内代理 images）。
 */

/* ─────────────────────────── 纯函数层 ─────────────────────────── */

function attachmentLine(ref: AgentAttachmentRef): string {
  const mime = ref.mime ?? 'application/octet-stream'
  const size = typeof ref.size === 'number' ? String(ref.size) : '?'
  return `${ref.path} | ${mime} | ${size}`
}

/** 附件区块字面值（与网页版 buildAttachmentBlock 逐字一致）。 */
export function buildAttachmentBlock(attachments: AgentAttachmentRef[]): string {
  const lines = attachments.map((ref, i) => `${i + 1}. ${attachmentLine(ref)}`).join('\n')
  return `\n[ATTACHMENTS_BLOCK]\n[附件]\n${lines}\n[/ATTACHMENTS_BLOCK]`
}

/** 是否存在仍在上传的附件——存在时禁止送出。 */
export function hasPendingAttachments(attachments: Pick<PendingAttachment, 'status'>[]): boolean {
  return attachments.some((a) => a.status === 'uploading')
}

/** 送出资格：有文字或有已就绪附件，且没有仍在途的附件。 */
export function computeCanSend(
  trimmedText: string,
  readyRefCount: number,
  attachments: Pick<PendingAttachment, 'status'>[],
): boolean {
  return (Boolean(trimmedText) || readyRefCount > 0) && !hasPendingAttachments(attachments)
}

/** 「在途」下一值：内部送出锁或面板在途任一为真。回 null＝与当前相同，不必动。 */
export function nextSendBusy(
  current: boolean,
  internalSendInFlight: boolean,
  externalSendPending: boolean,
): boolean | null {
  const next = internalSendInFlight || externalSendPending
  return next === current ? null : next
}

/** 网道附件 → 前端 ref（kind 按 mime 推导，照网页版 toAgentAttachmentRef）。 */
export function toAttachmentRef(a: {
  path?: string
  name?: string
  mime?: string
  size?: number
}): AgentAttachmentRef {
  const mime = a.mime ?? ''
  const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'document'
  return { kind, path: a.path, name: a.name, mime, size: a.size }
}

/* ─────────────────────────── 上传（Taro） ─────────────────────────── */

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
}

function basename(path: string): string {
  const clean = path.split('?')[0] ?? ''
  const parts = clean.split('/')
  const raw = parts[parts.length - 1] ?? ''
  try {
    return decodeURIComponent(raw) || '未命名文件'
  } catch {
    return raw || '未命名文件'
  }
}

function mimeOf(name: string, fallback = 'application/octet-stream'): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? fallback
}

export interface UploadAttachmentOptions {
  /** 取消令牌：置 aborted 后晚到的结果一律丢弃（小程序 uploadFile 无 abort）。 */
  cancel?: { aborted: boolean }
  timeoutMs?: number
}

function extractUploadError(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const payload = body as Record<string, unknown>
    if (typeof payload.error === 'string' && payload.error) return payload.error
    if (typeof payload.message === 'string' && payload.message) return payload.message
  }
  if (status === 401) return '登录已失效，请重新登录'
  if (status === 413) return `文件超过 ${formatMb(MAX_FILE_BYTES)} MB 上限，请压缩后再上传`
  if (status === 415) return '不支持这个文件类型'
  if (status >= 500) return `服务暂时不可用（${status}）`
  return `上传失败（${status}）`
}

/**
 * 上传一个媒体到站内代理 `/api/agent/sessions/{id}/attachments`。
 * 成功后回 `{ name, path, size, mime }`（契约同网页版 uploadAgentAttachments 的单项）。
 */
export async function uploadAgentAttachment(
  sessionId: string,
  file: MiniPickedFile,
  options: UploadAttachmentOptions = {},
): Promise<AgentAttachmentRef> {
  const token = getToken()
  const userId = getUserId()
  if (!token || !userId) {
    throw new Error('尚未登录，无法上传附件。')
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`文件 ${formatMb(file.size)} MB 超过上限 ${formatMb(MAX_FILE_BYTES)} MB，请压缩后再上传`)
  }

  const run = (async (): Promise<AgentAttachmentRef> => {
    let res: Taro.uploadFile.SuccessCallbackResult
    try {
      res = await Taro.uploadFile({
        url: `${BASE_URL}/api/agent/sessions/${encodeURIComponent(sessionId)}/attachments`,
        filePath: file.path,
        name: 'file',
        header: {
          Authorization: `Bearer ${token}`,
          'x-user-id': String(userId),
          accept: 'application/json',
        },
        timeout: options.timeoutMs ?? PLAIN_UPLOAD_TIMEOUT_MS,
      })
    } catch (error) {
      const errMsg = (error as { errMsg?: string } | null)?.errMsg
      throw new Error(errMsg ? `网络请求失败：${errMsg}` : '网络连接失败，请检查网络后再试。')
    }
    if (options.cancel?.aborted) throw new UploadAbortedError()

    let data: unknown
    try {
      data = res.data ? JSON.parse(res.data) : null
    } catch {
      data = null
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(extractUploadError(data, res.statusCode))
    }
    const arr = (data as { attachments?: unknown } | null)?.attachments
    const first = Array.isArray(arr) ? arr[0] : undefined
    if (!first || typeof first !== 'object') {
      throw new Error('服务器未返回有效的附件清单。')
    }
    const row = first as Record<string, unknown>
    const ref = toAttachmentRef({
      path: typeof row.path === 'string' ? row.path : undefined,
      name: typeof row.name === 'string' ? row.name : file.name,
      mime: typeof row.mime === 'string' ? row.mime : file.mime,
      size: typeof row.size === 'number' ? row.size : file.size,
    })
    if (!ref.path) throw new Error('服务器未返回附件存储路径。')
    return ref
  })()

  return withUploadDeadline(run, options.timeoutMs ?? PLAIN_UPLOAD_TIMEOUT_MS)
}

/* ─────────────────────────── 附件状态 hook ─────────────────────────── */

let attachmentSeq = 0

interface UseComposerAttachmentsOptions {
  disabled: boolean
  sessionId?: string | null
  onEnsureSession?: () => Promise<string | null>
}

export interface ComposerAttachmentsHandle {
  attachments: PendingAttachment[]
  attachmentsRef: MutableRefObject<PendingAttachment[]>
  pickMedia: () => void
  removeAttachment: (id: string) => void
  cancelAttachment: (id: string) => void
  retryAttachment: (id: string) => void
  removeAttachments: (ids: Set<string>) => void
}

/** 附件 chip 状态机：选图 → 预检 → 上传 → ready/error，失败/取消可重试。 */
export function useComposerAttachments({
  disabled,
  sessionId,
  onEnsureSession,
}: UseComposerAttachmentsOptions): ComposerAttachmentsHandle {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const attachmentsRef = useRef<PendingAttachment[]>([])
  attachmentsRef.current = attachments
  const mountedRef = useRef(true)
  const cancelsRef = useRef<Map<string, { aborted: boolean }>>(new Map())

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cancelsRef.current.forEach((token) => {
        token.aborted = true
      })
      cancelsRef.current.clear()
    }
  }, [])

  const patchAttachment = useCallback((id: string, patch: Partial<PendingAttachment>) => {
    if (!mountedRef.current) return
    setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  }, [])

  const removeAttachment = useCallback((id: string) => {
    const token = cancelsRef.current.get(id)
    if (token) token.aborted = true
    cancelsRef.current.delete(id)
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const removeAttachments = useCallback((ids: Set<string>) => {
    setAttachments((prev) => prev.filter((a) => !ids.has(a.id)))
    ids.forEach((id) => {
      cancelsRef.current.delete(id)
    })
  }, [])

  const cancelAttachment = useCallback(
    (id: string) => {
      const token = cancelsRef.current.get(id)
      if (token) token.aborted = true
      cancelsRef.current.delete(id)
      patchAttachment(id, { status: 'error', errorMessage: '已取消上传' })
    },
    [patchAttachment],
  )

  /** 一批 File 逐个入 chip 并上传；每个文件的失败互不牵连。 */
  const enqueueFiles = useCallback(
    async (files: MiniPickedFile[]) => {
      if (disabled || files.length === 0 || !mountedRef.current) return

      let session: string | null = sessionId ?? null
      if (!session && onEnsureSession) {
        try {
          session = await onEnsureSession()
        } catch {
          session = null
        }
      }
      if (!mountedRef.current) return
      if (!session) {
        const id = `att-${++attachmentSeq}`
        const file = files[0]
        setAttachments((prev) => [
          ...prev,
          {
            id,
            fileName: file?.name ?? '附件',
            status: 'error',
            errorMessage: '当前版本无法上传素材：会话尚未就绪，请稍后重试。',
            file,
            localPath: file?.path,
          },
        ])
        return
      }

      // 去重键＝文件名＋字节数（已就绪/在途的同键档静默跳过；error/取消的可重加）。
      const existing = new Set(
        attachmentsRef.current
          .filter((a) => a.status === 'ready' || a.status === 'uploading')
          .map((a) => `${a.fileName}\u0000${a.file?.size ?? ''}`),
      )
      const batch = new Set<string>()

      files.forEach((file) => {
        const key = `${file.name}\u0000${file.size}`
        if (existing.has(key) || batch.has(key)) return
        batch.add(key)

        const id = `att-${++attachmentSeq}`
        if (file.size > MAX_FILE_BYTES) {
          setAttachments((prev) => [
            ...prev,
            {
              id,
              fileName: file.name,
              status: 'error',
              errorMessage: `文件 ${formatMb(file.size)} MB 超过上限 ${formatMb(MAX_FILE_BYTES)} MB，请压缩或拆分后再上传`,
              file,
              localPath: file.path,
            },
          ])
          return
        }

        const token = { aborted: false }
        cancelsRef.current.set(id, token)
        setAttachments((prev) => [
          ...prev,
          { id, fileName: file.name, status: 'uploading', file, localPath: file.path, cancel: token },
        ])

        void uploadAgentAttachment(session as string, file, { cancel: token })
          .then((ref) => {
            if (token.aborted || !mountedRef.current) return
            patchAttachment(id, { status: 'ready', refs: [ref], errorMessage: undefined })
          })
          .catch((error: unknown) => {
            if (!mountedRef.current) return
            if (token.aborted) {
              patchAttachment(id, { status: 'error', errorMessage: '已取消上传' })
              return
            }
            const message =
              error instanceof UploadTimeoutError
                ? error.message
                : error instanceof UploadAbortedError
                  ? '已取消上传'
                  : error instanceof Error
                    ? error.message
                    : '上传失败，请重试。'
            patchAttachment(id, { status: 'error', errorMessage: message })
          })
          .finally(() => {
            cancelsRef.current.delete(id)
          })
      })
    },
    [disabled, sessionId, onEnsureSession, patchAttachment],
  )

  /** 选图入口（Taro.chooseMedia）。用户取消选择＝静默。 */
  const pickMedia = useCallback(() => {
    if (disabled) {
      void Taro.showToast({ title: '当前会话不可用', icon: 'none' })
      return
    }
    void Taro.chooseMedia({
      count: 9,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
    })
      .then((res) => {
        const picked: MiniPickedFile[] = (res.tempFiles ?? []).map((item) => {
          const name = basename(item.tempFilePath)
          return {
            path: item.tempFilePath,
            name,
            size: typeof item.size === 'number' ? item.size : 0,
            mime: mimeOf(name, item.fileType === 'video' ? 'video/mp4' : 'image/jpeg'),
          }
        })
        void enqueueFiles(picked)
      })
      .catch((error: unknown) => {
        const errMsg = (error as { errMsg?: string } | null)?.errMsg ?? ''
        if (errMsg.includes('cancel')) return
        void Taro.showToast({ title: '选择素材失败，请重试', icon: 'none' })
      })
  }, [disabled, enqueueFiles])

  /** 重试：拿 chip 上保留的原媒体重走同一条入队管道（不新增上传器）。 */
  const retryAttachment = useCallback(
    (id: string) => {
      const gone = attachmentsRef.current.find((a) => a.id === id)
      if (!gone?.file) return
      const file = gone.file
      setAttachments((prev) => prev.filter((a) => a.id !== id))
      void enqueueFiles([file])
    },
    [enqueueFiles],
  )

  return {
    attachments,
    attachmentsRef,
    pickMedia,
    removeAttachment,
    cancelAttachment,
    retryAttachment,
    removeAttachments,
  }
}
