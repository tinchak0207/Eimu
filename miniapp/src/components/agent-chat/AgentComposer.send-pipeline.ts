import { useCallback, useEffect, useRef, useState } from 'react'
import Taro from '@tarojs/taro'
import { buildAttachmentBlock, computeCanSend, hasPendingAttachments } from './AgentComposer.attachments'
import { MAX_COMPOSER_CHARS, SEND_HARD_TIMEOUT_MS } from './AgentComposer.upload-limits'
import type { PendingAttachment } from './AgentComposer.types'

/**
 * 送出管线（逐条对齐网页版 AgentComposer.send-pipeline.ts 的语义）：
 *   预检（空内容 / 超长 / 送出中 / 附件在途）
 *   → 同步锁（ref，同一帧挡连点）＋硬保险（SEND_HARD_TIMEOUT_MS）
 *   → 组装 [附件] 区块 → 投递 → 只清本次实际发出的附件。
 *
 * 平台差异（白名单）：网页 onSend(text) 直接带文本；小程序父层现有签名是
 * onSend(): void（文本走受控 draft）。因此新增可选 onSendText，未提供时用
 * onChange(finalText) → 下一拍 onSend() 的桥（React 18 离散事件先刷新受控值）。
 */

export interface ComposerSendPipelineOptions {
  trimmed: string
  attachments: PendingAttachment[]
  /** 父层在途（sending / externalSendPending 合成后的值）。 */
  externalSending: boolean
  disabled: boolean
  /** 父层现有发送入口（读父层 draft）。 */
  onSend: () => void
  /** 首选入口：直接拿最终文本（含附件区块）。 */
  onSendText?: (text: string) => void | Promise<void>
  onChange: (value: string) => void
  /** 本次实际发出去的 chip id（调用端据此移除附件，不误清在途项）。 */
  onSent: (ids: Set<string>) => void
}

export interface ComposerSendPipelineHandle {
  canSend: boolean
  /** 内部锁或父层在途（发送钮位置据此渲染停止态）。 */
  busy: boolean
  /** 管线自身给出的失败/超时文案（父层错误横幅之外的另一条兜底）。 */
  sendError: string | null
  handleSend: () => void
}

export function useComposerSendPipeline({
  trimmed,
  attachments,
  externalSending,
  disabled,
  onSend,
  onSendText,
  onChange,
  onSent,
}: ComposerSendPipelineOptions): ComposerSendPipelineHandle {
  const [localSending, setLocalSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const localRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 最新父层回调：桥路径下一拍取的必须是「带上新 draft」的那一份。 */
  const onSendRef = useRef(onSend)
  onSendRef.current = onSend
  /** 父层在途从 true→false 才解锁，避免初始 false 被误读成「已完成」。 */
  const sawExternalRef = useRef(false)

  const unlock = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    localRef.current = false
    setLocalSending(false)
  }, [])

  // 父层在途收敛：看到过 true，再看到 false ＝这轮投递已落地（或父层已失败复位）。
  useEffect(() => {
    if (externalSending) {
      sawExternalRef.current = true
      return
    }
    if (sawExternalRef.current) {
      sawExternalRef.current = false
      unlock()
    }
  }, [externalSending, unlock])

  // 卸载清硬保险计时器：面板关掉后不该还有 setTimeout 攥着 setState。
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  const readyAttachments = attachments.filter((a) => a.status === 'ready' && (a.refs?.length ?? 0) > 0)
  const readyRefs = readyAttachments.flatMap((a) => a.refs ?? [])
  const canSend = computeCanSend(trimmed, readyRefs.length, attachments)

  const handleSend = useCallback(() => {
    // 同步连点守卫：同一帧内第二次点击时 state 还是旧值，只有 ref 挡得住。
    if (localRef.current) return
    if (externalSending) {
      setSendError('正在发送，请稍候')
      return
    }
    if (disabled) {
      void Taro.showToast({ title: '当前会话不可用', icon: 'none' })
      return
    }
    if (trimmed.length > MAX_COMPOSER_CHARS) {
      const message = `内容太长了，请精简到 ${MAX_COMPOSER_CHARS} 字以内`
      setSendError(message)
      void Taro.showToast({ title: message, icon: 'none' })
      return
    }
    if (hasPendingAttachments(attachments)) {
      void Taro.showToast({ title: '素材还在上传，请稍等', icon: 'none' })
      return
    }
    if (!trimmed && readyRefs.length === 0) {
      void Taro.showToast({ title: '先说说你想做什么', icon: 'none' })
      return
    }

    const finalText = trimmed
      ? readyRefs.length > 0
        ? `${trimmed}\n${buildAttachmentBlock(readyRefs)}`
        : trimmed
      : buildAttachmentBlock(readyRefs).replace(/^\n+/, '')

    localRef.current = true
    setLocalSending(true)
    setSendError(null)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (!localRef.current) return
      localRef.current = false
      setLocalSending(false)
      setSendError('发送超时，请重试')
    }, SEND_HARD_TIMEOUT_MS)

    try {
      if (onSendText) {
        const result = onSendText(finalText)
        if (result && typeof (result as Promise<void>).then === 'function') {
          void (result as Promise<void>)
            .catch(() => setSendError('发送失败，请检查网络后重试'))
            .finally(unlock)
        } else {
          onChange('')
          // void 回调没有结算信号：下一拍解锁，父层若自行维护在途再接管。
          setTimeout(unlock, 0)
        }
      } else {
        // 桥：先让受控 draft 变成最终文本，再在下一拍调父层最新 onSend。
        onChange(finalText)
        setTimeout(() => {
          try {
            onSendRef.current()
          } catch {
            unlock()
            setSendError('发送失败，请检查网络后重试')
          }
        }, 0)
      }
    } catch {
      unlock()
      setSendError('发送失败，请检查网络后重试')
      return
    }

    // 只移除本次实际发出去的附件，仍在途的项不动。
    onSent(new Set(readyAttachments.map((a) => a.id)))
  }, [
    attachments,
    disabled,
    externalSending,
    onSendText,
    onChange,
    onSent,
    readyAttachments,
    readyRefs,
    trimmed,
    unlock,
  ])

  return { canSend, busy: externalSending || localSending, sendError, handleSend }
}
