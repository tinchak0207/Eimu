import { useCallback, useEffect, useRef, useState } from 'react'
import { Audio, Button, Image, Text, View, Video } from '@tarojs/components'
import Taro, { useLoad, useShareAppMessage } from '@tarojs/taro'
import { ApiError, request } from '../../../lib/request'
import { ensureLogin } from '../../../lib/session'
import {
  canRerunTask,
  rerunFromTask,
  type GenerationTask,
} from '../../../lib/generation'
import { ASPECT_RATIO_LABELS, IMAGE_MODELS, RESOLUTION_LABELS } from '../../../lib/models'
import './index.scss'

/** 与 app.config.ts 登记的路由保持一致（另一个 agent 负责登记）。 */
const DETAIL_ROUTE = '/pages/detail/index/index'
const POLL_INTERVAL_MS = 3_000

function statusLabel(task: GenerationTask): string {
  if (task.status === 'queued') return '排队中'
  if (task.status === 'running') return '生成中'
  if (task.status === 'succeeded') return '已完成'
  if (task.status === 'failed') return '生成失败'
  if (task.status === 'cancelled') return '已取消'
  if (task.status === 'refunded') return '已退款'
  return '状态未知'
}

function statusTone(task: GenerationTask): string {
  if (task.status === 'succeeded') return 'pill pill--ok'
  if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'refunded') return 'pill pill--bad'
  return 'pill pill--live'
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function modelLabel(modelId: string): string {
  return IMAGE_MODELS.find((item) => item.id === modelId)?.name ?? modelId
}

interface MediaView {
  url: string
  isVideo: boolean
  isAudio: boolean
}

/** 成品地址：取第一个带 url 的结果；视频按 mimeType 判定，不看 kind（avatar/lipsync 也出片）。 */
function mediaOf(task: GenerationTask | null): MediaView | null {
  const result = task?.results?.find((item) => Boolean(item.url))
  if (!result?.url) return null
  return { url: result.url, isVideo: (result.mimeType || '').startsWith('video/'), isAudio: (result.mimeType || '').startsWith('audio/') }
}

export default function DetailPage() {
  const [task, setTask] = useState<GenerationTask | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [rerunning, setRerunning] = useState(false)
  const taskIdRef = useRef('')
  const aliveRef = useRef(true)

  useEffect(() => () => {
    aliveRef.current = false
  }, [])

  const load = useCallback(async (id: string) => {
    if (!id) return
    try {
      await ensureLogin()
      const data = await request<GenerationTask>({
        path: `/api/generation-jobs/${encodeURIComponent(id)}`,
      })
      if (!data || typeof data.taskId !== 'string') {
        throw new ApiError('作品不存在或已被删除', 404, 'task_not_found')
      }
      if (!aliveRef.current) return
      setTask(data)
      setError('')
    } catch (err) {
      if (!aliveRef.current) return
      setError(err instanceof Error ? err.message : '加载作品失败')
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [])

  useLoad((options) => {
    if (options?.historyAudio === '1') {
      const source = Taro.getStorageSync('eimu_history_audio_preview') as { url?: string; prompt?: string } | undefined
      Taro.removeStorageSync('eimu_history_audio_preview')
      if (source?.url) {
        setTask({ taskId: '', modelId: '', kind: 'tts', status: 'succeeded', prompt: source.prompt, requestedCount: 1, completedCount: 1, createdAt: '', updatedAt: '', results: [{ resultId: '', taskId: '', outputIndex: 0, url: source.url, mimeType: 'audio/mpeg', width: null, height: null }] })
        setLoading(false)
        return
      }
    }
    const id = options?.id ? String(options.id) : ''
    taskIdRef.current = id
    if (!id) {
      setLoading(false)
      setError('缺少作品 id，无法打开详情')
      return
    }
    void load(id)
  })

  const isLive = task?.status === 'queued' || task?.status === 'running'

  useEffect(() => {
    if (!isLive) return
    const timer = setTimeout(() => {
      void load(taskIdRef.current)
    }, POLL_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [isLive, task?.updatedAt, task?.status, load])

  const media = mediaOf(task)

  useShareAppMessage(() => {
    const prompt = (task?.prompt ?? '').trim()
    const title = prompt ? prompt.slice(0, 20) : 'Eimu 作品'
    // 分享卡只吃图片；视频作品没有可用缩略图时交给微信默认截图。
    const imageUrl = media && !media.isVideo && !media.isAudio ? media.url : undefined
    return {
      title,
      path: task?.taskId ? `${DETAIL_ROUTE}?id=${encodeURIComponent(task.taskId)}` : '/pages/agent/index',
      ...(imageUrl ? { imageUrl } : {}),
    }
  })

  async function handleCopyPrompt() {
    const prompt = task?.prompt
    if (!prompt) return
    try {
      await Taro.setClipboardData({ data: prompt })
      Taro.showToast({ title: '已复制描述', icon: 'success' })
    } catch {
      Taro.showToast({ title: '复制失败', icon: 'none' })
    }
  }

  function handlePreview() {
    if (!media || media.isVideo || media.isAudio) return
    Taro.previewImage({ urls: [media.url], current: media.url })
  }

  async function handleSave() {
    if (!media || saving) return
    setSaving(true)
    try {
      const download = await Taro.downloadFile({ url: media.url })
      if (download.statusCode !== 200) {
        throw new Error(`文件下载失败（${download.statusCode}）`)
      }
      if (media.isVideo) {
        await Taro.saveVideoToPhotosAlbum({ filePath: download.tempFilePath })
      } else if (media.isAudio) {
        await Taro.shareFileMessage({ filePath: download.tempFilePath, fileName: 'eimu-audio.mp3' })
      } else {
        await Taro.saveImageToPhotosAlbum({ filePath: download.tempFilePath })
      }
      Taro.showToast({ title: media.isAudio ? '文件已交给微信分享' : '已保存到相册', icon: 'success' })
    } catch (err) {
      const detail = (err as { errMsg?: string; message?: string } | null)
      const message = detail?.errMsg || detail?.message || '保存失败，请稍后重试'
      if (/auth\s*deni|authorize|权限/i.test(message)) {
        Taro.showModal({
          title: '需要相册权限',
          content: '请在右上角「…」→ 设置中打开「保存到相册」权限后重试。',
          showCancel: false,
        })
      } else {
        Taro.showModal({ title: '保存失败', content: message, showCancel: false })
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleRerun() {
    if (!task || rerunning) return
    if (!canRerunTask(task)) {
      Taro.showToast({ title: '视频与编辑作品请到网页端重跑', icon: 'none' })
      return
    }
    setRerunning(true)
    try {
      await ensureLogin()
      const submitted = await rerunFromTask(task)
      // 提交成功后的跳转失败不能报成「重跑失败」——任务已经建单并会扣费。
      try {
        await Taro.redirectTo({
          url: `${DETAIL_ROUTE}?id=${encodeURIComponent(submitted.taskId)}`,
        })
        Taro.showToast({ title: '已提交重跑', icon: 'success' })
      } catch {
        Taro.showModal({
          title: '已提交重跑',
          content: '新任务已提交，可到「作品」页查看进度。',
          showCancel: false,
        })
      }
    } catch (err) {
      const content = err instanceof Error ? err.message : '重跑失败，请稍后重试'
      Taro.showModal({
        title: err instanceof ApiError && err.status === 402 ? '额度不足' : '重跑失败',
        content,
        showCancel: false,
      })
    } finally {
      if (aliveRef.current) setRerunning(false)
    }
  }

  return (
    <View className='page detail'>
      {loading && !task ? (
        <View className='card detail__hint'>
          <Text className='muted'>正在加载作品…</Text>
        </View>
      ) : null}

      {error && !task ? (
        <View className='card detail__hint'>
          <Text className='error-text'>{error}</Text>
          {taskIdRef.current ? (
            <Button
              className='btn btn--ghost detail__retry'
              onClick={() => {
                setLoading(true)
                void load(taskIdRef.current)
              }}
            >
              重试
            </Button>
          ) : null}
        </View>
      ) : null}

      {task ? (
        <>
          <View className='card detail__media-card'>
            {media ? (
              media.isAudio ? <Audio src={media.url} controls name={task.prompt?.slice(0, 40) || '音乐作品'} /> : media.isVideo ? (
                <Video
                  className='detail__video'
                  src={media.url}
                  controls
                  showCenterPlayBtn
                  objectFit='contain'
                />
              ) : (
                <Image
                  className='detail__image'
                  src={media.url}
                  mode='widthFix'
                  onClick={handlePreview}
                />
              )
            ) : (
              <View className='detail__placeholder'>
                <Text className='muted'>
                  {isLive ? '正在生成，完成后自动刷新' : `${statusLabel(task)}，暂无成品`}
                </Text>
              </View>
            )}
          </View>

          {task.errorMessage && (task.status === 'failed' || task.status === 'cancelled' || task.status === 'refunded') ? (
            <View className='card detail__error-card'>
              <Text className='section-title'>失败原因</Text>
              <Text className='error-text'>{task.errorMessage}</Text>
            </View>
          ) : null}

          <View className='card detail__meta-card'>
            <View className='detail__status-row'>
              <Text className={statusTone(task)}>{statusLabel(task)}</Text>
              {isLive ? <Text className='muted'>完成后自动刷新</Text> : null}
            </View>
            <View className='detail__field'>
              <Text className='detail__field-label'>模型</Text>
              <Text className='detail__field-value'>{modelLabel(task.submittedConfig?.modelId || task.modelId)}</Text>
            </View>
            <View className='detail__field'>
              <Text className='detail__field-label'>画幅</Text>
              <Text className='detail__field-value'>
                {ASPECT_RATIO_LABELS[task.submittedConfig?.aspectRatio as keyof typeof ASPECT_RATIO_LABELS]
                  || task.submittedConfig?.aspectRatio
                  || '—'}
              </Text>
            </View>
            <View className='detail__field'>
              <Text className='detail__field-label'>清晰度</Text>
              <Text className='detail__field-value'>
                {RESOLUTION_LABELS[task.submittedConfig?.outputResolution || '']
                  || task.submittedConfig?.outputResolution
                  || '—'}
              </Text>
            </View>
            <View className='detail__field'>
              <Text className='detail__field-label'>创建时间</Text>
              <Text className='detail__field-value'>{formatDateTime(task.createdAt)}</Text>
            </View>
          </View>

          <View className='card detail__prompt-card'>
            <Text className='section-title'>画面描述</Text>
            {task.prompt ? (
              <Text className='detail__prompt' onLongPress={handleCopyPrompt}>{task.prompt}</Text>
            ) : (
              <Text className='muted'>这条作品没有保存描述</Text>
            )}
            {task.prompt ? <Text className='muted detail__prompt-hint'>长按复制</Text> : null}
          </View>

          <View className='detail__actions'>
            {canRerunTask(task) ? (
              <Button
                className='btn btn--primary detail__action'
                loading={rerunning}
                disabled={rerunning}
                onClick={handleRerun}
              >
                再来一张
              </Button>
            ) : null}
            <Button
              className={`btn btn--ghost detail__action ${media ? '' : 'btn--disabled'}`}
              loading={saving}
              disabled={!media || saving}
              onClick={handleSave}
            >
              {media?.isAudio ? '分享音频文件' : media?.isVideo ? '保存视频' : '保存到相册'}
            </Button>
            {task.taskId ? <Button className='btn btn--ghost detail__action' openType='share'>
              分享
            </Button> : null}
          </View>
        </>
      ) : null}
    </View>
  )
}
