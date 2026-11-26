/**
 * 上传/送出硬上限。数值逐行对齐网页版
 * src/components/agent-chat/AgentComposer.upload-limits.ts，平台差异只有一条：
 * 小程序没有 XHR upload.onprogress，因此不声明 base64/进度相关工具。
 */

/**
 * 单请求体上限：站内 `/api/agent/sessions/:id/attachments` 只是透传代理，
 * 平台硬顶 4.5MB，留出 multipart 边界开销后按 4MB 预检（网页同值）。
 */
export const MAX_FILE_BYTES = 4 * 1024 * 1024

/** 网关原片直传的体积硬顶（小程序当前只走站内代理，保留常量供后续直传路径）。 */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024

/** 普通附件上传等待硬上限（网页 PLAIN_UPLOAD_TIMEOUT_MS 同值）。 */
export const PLAIN_UPLOAD_TIMEOUT_MS = 60_000

/**
 * 送出锁硬保险（20s，网页 SEND_HARD_TIMEOUT_MS 同值）：投递卡死时无条件解锁，
 * 宁可让用户重试，也不留下永久转圈/永久禁用的按钮。
 */
export const SEND_HARD_TIMEOUT_MS = 20_000

/** 输入框字数上限（与 textarea maxlength 一致；送出前再挡一次，绝不静默截断）。 */
export const MAX_COMPOSER_CHARS = 2000

/** 逾期专用错误：调用端据此区分「网络失败」与「逾时（必须给人话）」。 */
export class UploadTimeoutError extends Error {
  constructor() {
    super('上传超时，请重试。')
    this.name = 'UploadTimeoutError'
  }
}

/** 使用者主动取消上传（区别于网络失败）。 */
export class UploadAbortedError extends Error {
  constructor() {
    super('已取消上传。')
    this.name = 'UploadAbortedError'
  }
}

/** 给没有超时能力的等待加 deadline；晚到结果被丢弃。 */
export function withUploadDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UploadTimeoutError()), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** 字节数 → 展示 MB（一位小数）。 */
export function formatMb(bytes: number): string {
  return (Math.round((bytes / (1024 * 1024)) * 10) / 10).toFixed(1)
}
