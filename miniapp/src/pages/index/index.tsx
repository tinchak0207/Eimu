import { useEffect, useMemo, useRef, useState } from 'react'
import { Image, ScrollView, Text, Textarea, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { ApiError } from '../../lib/request'
import { ensureLogin } from '../../lib/session'
import {
  ASPECT_RATIOS,
  IMAGE_MODELS,
  RESOLUTION_LABELS,
  allowedResolutions,
  clampResolution,
  type AspectRatio,
} from '../../lib/models'
import { isInspirationTemplate, type InspirationTemplate } from '../../lib/templates'
import { fetchHistoryPage, mediaOf } from '../../lib/history'
import {
  readLocalImagePayload,
  runPixaiEdit,
  runPixaiUpscale,
  submitGeneration,
  uploadPixaiMedia,
  waitForGenerationTask,
  type GenerationTask,
} from '../../lib/generation'
import { PageShell } from '../../components/pages/PageShell'
import { PageBoundary } from '../../components/pages/PageBoundary'
import { ModelSheet } from '../../components/pages/ModelSheet'
import { Icon } from '../../components/agent-chat/icons'
import {
  MODEL_META,
  STYLE_PRESETS,
  SUGGESTIONS,
  calculateGenerationProgress,
  enhancePrompt,
  modelPriceLabel,
  replacePromptSnippet,
  replacePromptStyleSuffix,
  type Suggestion,
} from '../../components/pages/playground-data'
import './index.scss'

type PlaygroundMode = 'generate' | 'edit' | 'upscale'
type EditRatioKey = 'original' | '1:1' | '4:3' | '3:4' | '9:16'

/** 改图比例 → 提交尺寸：逐字复制 use-pixai-tools-panel.ts:17-25（original 同网页回退 1024x1024）。 */
const EDIT_RATIO_KEYS: EditRatioKey[] = ['original', '1:1', '4:3', '3:4', '9:16']
const EDIT_RATIO_SIZES: Record<Exclude<EditRatioKey, 'original'>, string> = {
  '1:1': '1024x1024',
  '4:3': '1024x768',
  '3:4': '768x1024',
  '9:16': '768x1365',
}

/** 网页版 ReferenceImageUpload 的上限（ReferenceImageUpload.tsx:12）；服务端上限 8。 */
const MAX_REFERENCE_IMAGES = 6
/** 服务端单图硬上限（generation-jobs/route.ts:49）。 */
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024

/**
 * 三个开放模型是否支持参考图：真源 src/lib/generation-model-catalog/catalog.ts
 *   gpt-image-2:83 / gemini-3.1-flash-image:96 = true，pixai-tsubaki2:436 = false。
 * models.ts 不在本任务文件所有权内，因此展示开关放在页面层。
 */
const REFERENCE_SUPPORTED: Record<string, boolean> = {
  'gpt-image-2': true,
  'gemini-3.1-flash-image': true,
  'pixai-tsubaki2': false,
}

/** 展示用起价：catalog pixai-edit imageCredits 0.01 → 0.001 币；pixai-upscale fixedCoins 0.001 币。 */
const PIXAI_EDIT_COIN_LABEL = '0.001'
const PIXAI_UPSCALE_COIN_LABEL = '0.001'

interface LocalPickedImage {
  path: string
  name: string
  size: number
}

interface HistoryPickItem {
  id: string
  url: string
  prompt: string
}

function isChooseCancel(error: unknown): boolean {
  return /cancel/i.test((error as { errMsg?: string } | null)?.errMsg ?? '')
}

function fileNameFromPath(path: string, fallback: string): string {
  const clean = path.split('?')[0]
  const name = clean.slice(clean.lastIndexOf('/') + 1)
  return name || fallback
}

/**
 * 直接生成页（手机端 1:1 重做）。
 *
 * 结构逐行对应网页版手机端分支：
 *   src/components/ImagePlayground.tsx:851-966   页面外壳 / 卡片与结果栏两栏（<xl 单栏）
 *   src/components/PromptInput.tsx:499-769       lg-card 外框、描述框、圆钮、控件区、底部动作列
 *   src/components/prompt-input/GenerateControls.tsx:92-288  示例/模型/比例/画质/风格五行
 *   src/components/prompt-input/ActionRow.tsx:64-163         改图/放大/AI 助理三颗 toggle
 *   src/components/ImageDisplay.tsx:111-251                  结果卡：空态 / 进度 / 成品 / 失败
 *
 * 生成契约（提交 + 轮询）走 src/lib/generation.ts；本轮补齐三条能力：
 *   参考图 → POST /api/generation-jobs（multipart，字段契约同 use-image-generation.ts:631-660）
 *   改图   → /api/pixai/upload → /api/pixai/edit（use-pixai-tools-panel.ts:77-110）
 *   放大   → /api/pixai/upload → /api/pixai/upscale（use-pixai-tools-panel.ts:155-184）
 */
export default function IndexPage() {
  const [prompt, setPrompt] = useState('')
  const [modelIndex, setModelIndex] = useState(0)
  const [ratio, setRatio] = useState<AspectRatio>('1:1')
  const [resolution, setResolution] = useState(IMAGE_MODELS[0].defaultResolution)
  const [styleKey, setStyleKey] = useState('none')
  const [suggestions, setSuggestions] = useState<Suggestion[]>(SUGGESTIONS)
  const [modelSheetOpen, setModelSheetOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [task, setTask] = useState<GenerationTask | null>(null)
  const [imageUrl, setImageUrl] = useState('')
  const [error, setError] = useState('')
  const [quotaError, setQuotaError] = useState(false)
  const [startedAt, setStartedAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [templateChip, setTemplateChip] = useState<InspirationTemplate | null>(null)
  const [mode, setMode] = useState<PlaygroundMode>('generate')
  const [references, setReferences] = useState<LocalPickedImage[]>([])
  const [editSource, setEditSource] = useState<LocalPickedImage | null>(null)
  const [editRatio, setEditRatio] = useState<EditRatioKey>('original')
  const [editStage, setEditStage] = useState<'idle' | 'uploading' | 'generating'>('idle')
  const [editUrl, setEditUrl] = useState('')
  const [upscaleSource, setUpscaleSource] = useState<LocalPickedImage | null>(null)
  const [upscaleSourceSize, setUpscaleSourceSize] = useState<{ width: number; height: number } | null>(null)
  const [upscaleStage, setUpscaleStage] = useState<'idle' | 'uploading' | 'generating'>('idle')
  const [upscaleUrl, setUpscaleUrl] = useState('')
  /** 历史作品选择面板（改图 / 放大的原图来源）。 */
  const [sourceSheet, setSourceSheet] = useState<'edit' | 'upscale' | null>(null)
  const [historyPicks, setHistoryPicks] = useState<HistoryPickItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const cancelledRef = useRef(false)
  const promptRef = useRef('')
  promptRef.current = prompt
  const lastSuggestionRef = useRef<string | null>(null)

  const model = IMAGE_MODELS[modelIndex]
  const resolutions = useMemo(() => allowedResolutions(model, ratio), [model, ratio])
  const vendors = useMemo(() => {
    const map: Record<string, string> = {}
    for (const item of IMAGE_MODELS) map[item.id] = MODEL_META[item.id]?.vendor ?? '其他'
    return map
  }, [])

  const editBusy = editStage !== 'idle'
  const upscaleBusy = upscaleStage !== 'idle'
  const modeBusy = editBusy || upscaleBusy
  const referenceSupported = REFERENCE_SUPPORTED[model.id] !== false
  /** 结果画布按模式取各自产物：生成 / 改图 / 放大互不覆盖。 */
  const displayedUrl = mode === 'edit' ? editUrl : mode === 'upscale' ? upscaleUrl : imageUrl
  const hasImage = Boolean(displayedUrl)
  const rendering = (submitting || modeBusy) && !error
  const failed = Boolean(error) && !submitting && !modeBusy
  const progress = rendering && startedAt
    ? calculateGenerationProgress(startedAt, now)
    : 0

  function applyAspectRatio(next: AspectRatio) {
    setRatio(next)
    setResolution((current) => clampResolution(model, next, current))
  }

  function applyTemplate(template: InspirationTemplate) {
    setPrompt(template.prompt)
    lastSuggestionRef.current = null
    setTemplateChip(null)
    if (template.aspectRatio) applyAspectRatio(template.aspectRatio)
  }

  useDidShow(() => {
    let stored: unknown
    try {
      stored = Taro.getStorageSync('pending_template')
    } catch {
      return
    }
    if (!stored) return
    try {
      Taro.removeStorageSync('pending_template')
    } catch {
      // 清理失败不影响本次套用
    }
    if (!isInspirationTemplate(stored)) return

    if (promptRef.current.trim()) {
      // 用户已经手输内容：不覆盖，改成可点击 chip。
      setTemplateChip(stored)
      return
    }
    applyTemplate(stored)
  })

  useEffect(() => {
    ensureLogin().catch(() => {
      // 首次进入静默失败；提交时会重新走登录并给出可见错误。
    })
    return () => {
      cancelledRef.current = true
    }
  }, [])

  // 进度条计时：与网页版 ParticleSeaWaiting 同一节奏（250ms 采样）。
  useEffect(() => {
    if (!rendering) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [rendering])

  function handleModelChange(modelId: string) {
    const index = IMAGE_MODELS.findIndex((item) => item.id === modelId)
    if (index < 0) return
    const nextModel = IMAGE_MODELS[index]
    setModelIndex(index)
    setResolution((current) => clampResolution(nextModel, ratio, current))
    // 与网页端同义：切到不支持参考图的模型时清空已选图（ReferenceImageUpload 不挂载）。
    if (REFERENCE_SUPPORTED[nextModel.id] === false && references.length) {
      setReferences([])
      notify('该模型不支持参考图，已清空已选图片')
    }
  }

  function handleStyleChange(key: string) {
    const next = styleKey === key ? 'none' : key
    setStyleKey(next)
    // 网版：风格后缀作为独立段落写进输入框（PromptInput.tsx:381-389）。
    const meta = STYLE_PRESETS.find((preset) => preset.key === next)
    setPrompt((current) =>
      replacePromptStyleSuffix(current, meta?.suffix, STYLE_PRESETS.map((preset) => preset.suffix)),
    )
  }

  function handleSuggestionSelect(suggestion: Suggestion) {
    setPrompt((current) => replacePromptSnippet(current, lastSuggestionRef.current, suggestion.prompt))
    lastSuggestionRef.current = suggestion.prompt
  }

  function handleRefreshSuggestions() {
    const next = [...SUGGESTIONS]
    for (let index = next.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1))
      ;[next[index], next[randomIndex]] = [next[randomIndex], next[index]]
    }
    setSuggestions(next)
    lastSuggestionRef.current = null
  }

  function handleOpenTemplates() {
    void Taro.navigateTo({ url: '/pages/templates/index/index' })
  }

  function notify(title: string) {
    void Taro.showToast({ title, icon: 'none' })
  }

  /**
   * 大图先压一道（网页端 ReferenceImageUpload 也用 browser-image-compression 压到 ~1.1MB）。
   * 微信 compressImage 只降质量不缩尺寸，但对 multipart 体积已足够；失败就原图直传。
   */
  async function compressIfLarge(filePath: string, size: number): Promise<string> {
    if (size <= 1_500_000) return filePath
    try {
      const result = await Taro.compressImage({ src: filePath, quality: 60 })
      return result.tempFilePath || filePath
    } catch {
      return filePath
    }
  }

  /** 单图选择（改图 / 放大的原图）。取消不报错，超限给可见提示。 */
  async function chooseOneImage(fallbackName: string): Promise<LocalPickedImage | null> {
    try {
      const result = await Taro.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
      })
      const file = result.tempFiles?.[0]
      if (!file?.tempFilePath) return null
      if ((file.size ?? 0) > MAX_REFERENCE_BYTES) {
        notify('图片超过 12MB，请换一张')
        return null
      }
      return {
        path: await compressIfLarge(file.tempFilePath, file.size ?? 0),
        name: fileNameFromPath(file.tempFilePath, fallbackName),
        size: file.size ?? 0,
      }
    } catch (error) {
      if (!isChooseCancel(error)) notify('选择图片失败，请重试')
      return null
    }
  }

  /** 参考图多选：chooseMedia count 随剩余槽位收窄（网页版同一上限 6 张）。 */
  async function handlePickReferences() {
    if (!referenceSupported) {
      notify('当前模型不支持参考图，换一个模型再试')
      return
    }
    const remaining = MAX_REFERENCE_IMAGES - references.length
    if (remaining <= 0) {
      notify(`最多 ${MAX_REFERENCE_IMAGES} 张参考图`)
      return
    }
    try {
      const result = await Taro.chooseMedia({
        count: remaining,
        mediaType: ['image'],
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
      })
      const picked: LocalPickedImage[] = []
      let skipped = 0
      for (const file of result.tempFiles ?? []) {
        if (!file.tempFilePath) continue
        if ((file.size ?? 0) > MAX_REFERENCE_BYTES) {
          skipped += 1
          continue
        }
        picked.push({
          path: await compressIfLarge(file.tempFilePath, file.size ?? 0),
          name: fileNameFromPath(file.tempFilePath, `参考图${picked.length + 1}`),
          size: file.size ?? 0,
        })
      }
      if (picked.length) {
        setReferences((current) => [...current, ...picked].slice(0, MAX_REFERENCE_IMAGES))
      }
      if (skipped) notify(`${skipped} 张图片超过 12MB，已跳过`)
    } catch (error) {
      if (!isChooseCancel(error)) notify('选择图片失败，请重试')
    }
  }

  function handleRemoveReference(index: number) {
    setReferences((current) => current.filter((_, itemIndex) => itemIndex !== index))
  }

  async function measureImageSize(path: string): Promise<{ width: number; height: number } | null> {
    try {
      const info = await Taro.getImageInfo({ src: path })
      return info.width > 0 && info.height > 0 ? { width: info.width, height: info.height } : null
    } catch {
      return null
    }
  }

  async function handlePickSource(target: 'edit' | 'upscale') {
    const picked = await chooseOneImage(target === 'edit' ? '改图原图' : '放大原图')
    if (!picked) return
    setError('')
    setQuotaError(false)
    setStartedAt(0)
    if (target === 'edit') {
      setEditSource(picked)
      setEditUrl('')
      setEditStage('idle')
      return
    }
    setUpscaleSource(picked)
    setUpscaleUrl('')
    setUpscaleStage('idle')
    setUpscaleSourceSize(await measureImageSize(picked.path))
  }

  /** 「从作品/详情带入」：把本页刚生成的结果直接当改图 / 放大输入。 */
  function handleUseCurrentResult() {
    if (!imageUrl) return
    const picked: LocalPickedImage = { path: imageUrl, name: '当前作品', size: 0 }
    setError('')
    setQuotaError(false)
    setStartedAt(0)
    if (mode === 'edit') {
      setEditSource(picked)
      setEditUrl('')
      setEditStage('idle')
      return
    }
    if (mode === 'upscale') {
      setUpscaleSource(picked)
      setUpscaleUrl('')
      setUpscaleStage('idle')
      setUpscaleSourceSize(null)
      void measureImageSize(imageUrl).then((size) => setUpscaleSourceSize(size))
    }
  }

  /** 历史作品来源：GET /api/history（history.ts fetchHistoryPage，只读取不改造）。 */
  async function openHistoryPicker(target: 'edit' | 'upscale') {
    setSourceSheet(target)
    setHistoryLoading(true)
    setHistoryPicks([])
    try {
      const response = await fetchHistoryPage({ withImageOnly: true }, { pageSize: 18 })
      const items: HistoryPickItem[] = []
      for (const entry of response.data?.entries ?? []) {
        const media = mediaOf(entry)
        if (!media || media.kind !== 'image') continue
        items.push({ id: entry.id, url: media.url, prompt: entry.prompt })
      }
      setHistoryPicks(items)
    } catch {
      notify('历史作品加载失败，请稍后重试')
    } finally {
      setHistoryLoading(false)
    }
  }

  function handleOpenHistoryPicker() {
    void openHistoryPicker(mode === 'upscale' ? 'upscale' : 'edit')
  }

  function handlePickHistoryItem(item: HistoryPickItem) {
    const target = sourceSheet
    setSourceSheet(null)
    if (!target) return
    const picked: LocalPickedImage = { path: item.url, name: '历史作品', size: 0 }
    setError('')
    setQuotaError(false)
    setStartedAt(0)
    if (target === 'edit') {
      setEditSource(picked)
      setEditUrl('')
      setEditStage('idle')
      return
    }
    setUpscaleSource(picked)
    setUpscaleUrl('')
    setUpscaleStage('idle')
    setUpscaleSourceSize(null)
    void measureImageSize(item.url).then((size) => setUpscaleSourceSize(size))
  }

  function handleModeChange(next: PlaygroundMode) {
    setMode((current) => (current === next ? 'generate' : next))
    setError('')
    setQuotaError(false)
    setStartedAt(0)
  }

  function handlePrimaryAction() {
    if (mode === 'edit') {
      void handleEditSubmit()
      return
    }
    if (mode === 'upscale') {
      void handleUpscaleSubmit()
      return
    }
    void handleSubmit()
  }

  function handleOpenAgent() {
    void Taro.reLaunch({ url: '/pages/agent/index' })
  }

  /**
   * 改图：/api/pixai/upload → /api/pixai/edit。
   * 逐行对应网页端 use-pixai-tools-panel.ts:77-110（body { image: mediaId, prompt, size, n: 1 }）。
   */
  async function handleEditSubmit() {
    if (editBusy) return
    if (!editSource) {
      notify('请先选择原图')
      return
    }
    if (!prompt.trim()) {
      notify('请描述想改成什么样子')
      return
    }
    setError('')
    setQuotaError(false)
    setEditUrl('')
    setEditStage('uploading')
    setStartedAt(Date.now())
    setNow(Date.now())
    try {
      await ensureLogin()
      const payload = await readLocalImagePayload({ path: editSource.path })
      const mediaId = await uploadPixaiMedia(payload)
      setEditStage('generating')
      const size = editRatio === 'original' ? '1024x1024' : EDIT_RATIO_SIZES[editRatio]
      const url = await runPixaiEdit({ mediaId, prompt: prompt.trim(), size })
      setEditUrl(url)
    } catch (err) {
      const message = err instanceof Error ? err.message : '改图失败，请重试'
      setError(message)
      setQuotaError(err instanceof ApiError && (err.status === 402 || err.code === 'insufficient_quota'))
    } finally {
      setEditStage('idle')
    }
  }

  /**
   * 放大：/api/pixai/upload → /api/pixai/upscale。
   * 逐行对应网页端 use-pixai-tools-panel.ts:155-184（factor 固定 2；size 传原图 WxH 供计费）。
   */
  async function handleUpscaleSubmit() {
    if (upscaleBusy) return
    if (!upscaleSource) {
      notify('请先选择原图')
      return
    }
    setError('')
    setQuotaError(false)
    setUpscaleUrl('')
    setUpscaleStage('uploading')
    setStartedAt(Date.now())
    setNow(Date.now())
    try {
      await ensureLogin()
      const payload = await readLocalImagePayload({ path: upscaleSource.path })
      const mediaId = await uploadPixaiMedia(payload)
      setUpscaleStage('generating')
      const size = upscaleSourceSize
        ? `${upscaleSourceSize.width}x${upscaleSourceSize.height}`
        : undefined
      const url = await runPixaiUpscale({ mediaId, factor: 2, size })
      setUpscaleUrl(url)
    } catch (err) {
      const message = err instanceof Error ? err.message : '放大失败，请重试'
      setError(message)
      setQuotaError(err instanceof ApiError && (err.status === 402 || err.code === 'insufficient_quota'))
    } finally {
      setUpscaleStage('idle')
    }
  }

  async function handleSubmit() {
    if (submitting) return
    if (!prompt.trim()) {
      // 网版同一语义：按钮保持可点，点击给人话提示（PromptInput.tsx:404-407）。
      void Taro.showToast({ title: '先描述你的想法', icon: 'none' })
      return
    }

    cancelledRef.current = false
    setSubmitting(true)
    setError('')
    setQuotaError(false)
    setTask(null)
    setImageUrl('')
    setStartedAt(Date.now())
    setNow(Date.now())

    try {
      const user = await ensureLogin()
      const finalPrompt = enhancePrompt(prompt, styleKey)
      const submitted = await submitGeneration({
        prompt: finalPrompt,
        modelId: model.id,
        aspectRatio: ratio,
        outputResolution: resolution,
        qualityMode: resolution === '1k' ? 'fast' : 'quality',
        userId: user.id,
        // 有参考图走 multipart（generation.ts submitGeneration 分支），无图仍是原 JSON 契约。
        referenceImages: references.map((image, index) => ({
          id: `mp-ref-${index}-${image.size}-${image.name}`,
          name: image.name,
          role: 'general' as const,
          path: image.path,
          size: image.size,
        })),
      })

      setTask(submitted)
      const finished = submitted.status === 'succeeded'
        ? submitted
        : await waitForGenerationTask(
            submitted.taskId,
            (nextTask) => setTask(nextTask),
            () => cancelledRef.current,
          )
      setTask(finished)

      const first = finished.results?.find((result) => result.url)
      if (!first?.url) {
        throw new ApiError('任务已完成但没有取到图片地址', 0, 'missing_result')
      }
      setImageUrl(first.url)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'polling_cancelled') {
        void Taro.showToast({ title: '已停止等待，可到「生成历史」查看结果', icon: 'none' })
        return
      }
      const message = err instanceof Error ? err.message : '生成失败，请稍后重试'
      setError(message)
      setQuotaError(err instanceof ApiError && (err.status === 402 || err.code === 'insufficient_quota'))
    } finally {
      setSubmitting(false)
    }
  }

  function handleStop() {
    cancelledRef.current = true
  }

  async function handleSave() {
    if (!displayedUrl || saving) return
    setSaving(true)
    try {
      const download = await Taro.downloadFile({ url: displayedUrl })
      if (download.statusCode !== 200) {
        throw new Error(`图片下载失败（${download.statusCode}）`)
      }
      await Taro.saveImageToPhotosAlbum({ filePath: download.tempFilePath })
      Taro.showToast({ title: '已保存到相册', icon: 'success' })
    } catch (err) {
      const detail = (err as { errMsg?: string; message?: string } | null)
      const message = detail?.errMsg || detail?.message || '图片下载失败，请稍后重试'
      if (/auth\s*deni|authorize/i.test(message)) {
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

  function handlePreview() {
    if (!displayedUrl) return
    void Taro.previewImage({ urls: [displayedUrl], current: displayedUrl })
  }

  return (
    <PageBoundary>
      <PageShell>
      <View className='bg-transparent px-4 pb-16 pt-10'>
        {/* ── 描述卡片（PromptInput.tsx:499-769 的 lg-card 外框） ── */}
        <View className='lg-card relative overflow-x-clip rounded-ios-3xl p-5 pb-6'>
          <View className='pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80' />

          <View className='relative space-y-4'>
            {/* 画面描述（PromptInput.tsx:527-590） */}
            <View className='relative'>
              <Textarea
                className='box-border min-h-[180px] w-full rounded-ios-2xl border-0 bg-[rgba(0,0,0,0.04)] px-5 py-4 pb-14 text-[16px] leading-6 text-[rgba(0,0,0,0.85)]'
                value={prompt}
                onInput={(event) => setPrompt(event.detail.value)}
                placeholder={
                  mode === 'edit'
                    ? '描述想改成什么样子…'
                    : mode === 'upscale'
                      ? '放大不需要描述，选好原图直接开始'
                      : '描述你的想法。例如：让这瓶香水出现在落日海滩，自然光线，质感高级。'
                }
                placeholderClass='pg-placeholder'
                maxlength={4000}
                showConfirmBar={false}
                disableDefaultPadding
                style={{ height: '180px' }}
              />

              {/* 参考图入口：网页版 ReferenceImageUpload variant="prompt"
                  （ReferenceImageUpload.tsx:146-171）：44px 蓝底圆钮 + 48px 内联缩图，
                  缩图右上角 24px 删除钮。仅生成模式且模型支持参考图时出现。 */}
              {mode === 'generate' && referenceSupported ? (
                <View className='absolute bottom-3 left-3 z-20 flex max-w-[calc(100%-64px)] min-w-0 items-center gap-2'>
                  <View
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
                      references.length >= MAX_REFERENCE_IMAGES
                        ? 'bg-[rgba(0,0,0,0.05)]'
                        : 'bg-[rgba(0,122,255,0.10)]'
                    }`}
                    onClick={() => void handlePickReferences()}
                  >
                    <Icon name='image-plus-blue' className='h-5 w-5' />
                  </View>
                  {references.length > 0 ? (
                    <ScrollView scrollX enableFlex className='min-w-0 flex-1'>
                      <View className='flex items-center gap-1.5'>
                        {references.map((image, index) => (
                          <View
                            key={`${image.path}-${index}`}
                            className='relative h-12 w-12 shrink-0 overflow-hidden rounded-ios-md bg-[rgba(0,0,0,0.05)]'
                          >
                            <Image className='h-full w-full' src={image.path} mode='aspectFill' />
                            <View
                              className='absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-[rgba(0,0,0,0.60)]'
                              onClick={(event) => {
                                event.stopPropagation()
                                handleRemoveReference(index)
                              }}
                            >
                              <Text className='text-[13px] font-semibold leading-none text-white'>×</Text>
                            </View>
                          </View>
                        ))}
                      </View>
                    </ScrollView>
                  ) : (
                    <Text className='min-w-0 truncate text-ios-caption1 text-[rgba(0,0,0,0.45)]'>
                      参考图
                    </Text>
                  )}
                </View>
              ) : null}

              {/* 生成 / 停止圆钮（PromptInput.tsx:568-589）：
                  生成中显示停止；其余模式统一派发 handlePrimaryAction。 */}
              {submitting && !error ? (
                <View
                  className='absolute bottom-2.5 right-4 z-30 flex h-9 w-9 items-center justify-center rounded-full bg-ios-red shadow-[0_4px_16px_rgba(255,59,48,0.45)]'
                  onClick={handleStop}
                >
                  <Icon name='square-white' className='h-3.5 w-3.5' />
                </View>
              ) : (
                <View
                  className={`absolute bottom-2.5 right-4 z-30 flex h-9 w-9 items-center justify-center rounded-full bg-[#007AFF] shadow-[0_4px_18px_rgba(0,122,255,0.55)] ${
                    modeBusy ? 'opacity-50' : ''
                  }`}
                  onClick={handlePrimaryAction}
                >
                  <Icon name='sparkles-white' className='h-4 w-4' />
                </View>
              )}
            </View>

            {templateChip ? (
              <View
                className='inline-flex items-center gap-1.5 rounded-full bg-[rgba(0,122,255,0.10)] px-3 py-1.5 text-ios-footnote font-medium text-[#007AFF]'
                onClick={() => applyTemplate(templateChip)}
              >
                <Text className='truncate'>套用模板：{templateChip.title}</Text>
              </View>
            ) : null}

            {/* ── 控件区（GenerateControls.tsx:92-288 / EditPanel / UpscalePanel） ── */}
            <View className='space-y-2.5'>
              {mode === 'generate' ? (
              <>
              {/* 示例 */}
              <View className='flex min-w-0 items-center gap-2'>
                <Text className='w-8 shrink-0 text-ios-footnote font-medium text-[rgba(0,0,0,0.50)]'>示例</Text>
                <ScrollView scrollX enableFlex className='min-w-0 flex-1'>
                  <View className='flex items-center gap-1.5'>
                    {suggestions.map((suggestion) => (
                      <View
                        key={suggestion.text}
                        className='style-chip'
                        onClick={() => handleSuggestionSelect(suggestion)}
                      >
                        <Text>{suggestion.text}</Text>
                      </View>
                    ))}
                    {/* 既有「灵感模板」入口（网页版同位置没有）：
                        放进同一条胶囊滑轨，不改版面结构。 */}
                    <View className='style-chip' onClick={handleOpenTemplates}>
                      <Icon name='layout-grid-a72' className='h-3.5 w-3.5' />
                      <Text>灵感模板</Text>
                    </View>
                  </View>
                </ScrollView>
                <View
                  className='flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.52)]'
                  onClick={handleRefreshSuggestions}
                >
                  <Icon name='refresh-cw-a52' className='h-3.5 w-3.5' />
                </View>
              </View>

              {/* 模型（ModelPicker.tsx:533-550 的触发胶囊） */}
              <View className='flex min-w-0 items-center gap-2'>
                <Text className='w-8 shrink-0 text-ios-footnote font-medium text-[rgba(0,0,0,0.50)]'>模型</Text>
                <View className='flex min-w-0 flex-1 items-center gap-1.5'>
                  <View
                    className='style-chip w-fit max-w-full justify-start gap-1.5 pl-3 pr-2.5 font-medium'
                    onClick={() => setModelSheetOpen(true)}
                  >
                    <Text className='min-w-0 truncate'>{model.name}</Text>
                    {MODEL_META[model.id]?.promotionTag ? (
                      <View className='shrink-0 rounded-full bg-[rgba(52,199,89,0.14)] px-1.5 py-0.5 text-ios-caption2 font-semibold text-[#248A3D]'>
                        <Text>{MODEL_META[model.id].promotionTag}</Text>
                      </View>
                    ) : null}
                    <Icon name='chevron-down-a35' className='h-3.5 w-3.5 shrink-0' />
                  </View>
                </View>
              </View>

              {/* 比例 */}
              <View className='flex min-w-0 items-center gap-2'>
                <Text className='w-8 shrink-0 text-ios-footnote font-medium text-[rgba(0,0,0,0.50)]'>比例</Text>
                <ScrollView scrollX enableFlex className='min-w-0 flex-1'>
                  <View className='flex items-center gap-1.5'>
                    {ASPECT_RATIOS.map((item) => (
                      <View
                        key={item}
                        className={`style-chip ${ratio === item ? 'active' : ''}`}
                        onClick={() => applyAspectRatio(item)}
                      >
                        <Text>{item}</Text>
                      </View>
                    ))}
                  </View>
                </ScrollView>
              </View>

              {/* 画质 */}
              <View className='flex min-w-0 items-center gap-2'>
                <Text className='w-8 shrink-0 text-ios-footnote font-medium text-[rgba(0,0,0,0.50)]'>画质</Text>
                <ScrollView scrollX enableFlex className='min-w-0 flex-1'>
                  <View className='flex items-center gap-1.5'>
                    {resolutions.map((item) => (
                      <View
                        key={item}
                        className={`style-chip gap-1.5 ${resolution === item ? 'active' : ''}`}
                        onClick={() => setResolution(item)}
                      >
                        <Text>{RESOLUTION_LABELS[item] ?? item}</Text>
                        <Text className='tabular-nums text-[rgba(0,0,0,0.52)]'>
                          · {modelPriceLabel(model.id, item)}
                        </Text>
                      </View>
                    ))}
                  </View>
                </ScrollView>
              </View>

              {/* 风格（StylePresets.tsx:14-32，inline 分支） */}
              <View className='flex min-w-0 items-center gap-2'>
                <Text className='w-8 shrink-0 text-ios-footnote font-medium text-[rgba(0,0,0,0.50)]'>风格</Text>
                <ScrollView scrollX enableFlex className='min-w-0 flex-1'>
                  <View className='flex items-center gap-1.5'>
                    {STYLE_PRESETS.map((preset) => (
                      <View
                        key={preset.key}
                        className={`style-chip ${styleKey === preset.key ? 'active' : ''}`}
                        onClick={() => handleStyleChange(preset.key)}
                      >
                        <Text>{preset.label}</Text>
                      </View>
                    ))}
                  </View>
                </ScrollView>
              </View>
              </>
              ) : mode === 'edit' ? (
              <>
                {/* 改图面（EditPanel.tsx:71-132）：原图胶囊 / 比例 / 起价 */}
                <View className='flex min-w-0 items-center gap-2'>
                  <Text className='w-8 shrink-0 text-ios-footnote font-medium text-[rgba(0,0,0,0.50)]'>原图</Text>
                  <ScrollView scrollX enableFlex className='min-w-0 flex-1'>
                    <View className='flex items-center gap-1.5'>
                      {editSource ? (
                        <View className='style-chip gap-1.5 pr-1'>
                          <Image className='h-5 w-5 shrink-0 rounded-md' src={editSource.path} mode='aspectFill' />
                          <Text className='max-w-[120px] truncate'>{editSource.name}</Text>
                          <View
                            className='flex h-5 w-5 shrink-0 items-center justify-center rounded-full'
                            onClick={() => {
                              setEditSource(null)
                              setEditUrl('')
                              setEditStage('idle')
                            }}
                          >
                            <Icon name='x-a45' className='h-3 w-3' />
                          </View>
                        </View>
                      ) : (
                        <View className='style-chip gap-1.5' onClick={() => void handlePickSource('edit')}>
                          <Icon name='image-plus-a45' className='h-3.5 w-3.5' />
                          <Text>从相册选择</Text>
                        </View>
                      )}
                      {imageUrl ? (
                        <View className='style-chip gap-1.5' onClick={handleUseCurrentResult}>
                          <Icon name='image-a40' className='h-3.5 w-3.5' />
                          <Text>用当前作品</Text>
                        </View>
                      ) : null}
                      <View
                        className='style-chip gap-1.5'
                        onClick={handleOpenHistoryPicker}
                      >
                        <Icon name='layout-grid-a72' className='h-3.5 w-3.5' />
                        <Text>从生成历史选择</Text>
                      </View>
                    </View>
                  </ScrollView>
                </View>

                <View className='flex min-w-0 items-center gap-2'>
                  <Text className='w-8 shrink-0 text-ios-footnote font-medium text-[rgba(0,0,0,0.50)]'>比例</Text>
                  <ScrollView scrollX enableFlex className='min-w-0 flex-1'>
                    <View className='flex items-center gap-1.5'>
                      {EDIT_RATIO_KEYS.map((key) => (
                        <View
                          key={key}
                          className={`style-chip ${editRatio === key ? 'active' : ''}`}
                          onClick={() => setEditRatio(key)}
                        >
                          <Text>{key === 'original' ? '跟随原图' : key}</Text>
                        </View>
                      ))}
                    </View>
                  </ScrollView>
                </View>

                <Text className='pl-10 text-ios-caption1 text-[rgba(0,0,0,0.46)]'>
                  改图 {PIXAI_EDIT_COIN_LABEL} 币起（按解析度浮动）
                </Text>
              </>
              ) : (
              <>
                {/* 放大面（UpscalePanel.tsx:44-110）：原图 / 倍数 / 档位与价格 */}
                <View className='flex min-w-0 items-center gap-2'>
                  <Text className='w-8 shrink-0 text-ios-footnote font-medium text-[rgba(0,0,0,0.50)]'>原图</Text>
                  <ScrollView scrollX enableFlex className='min-w-0 flex-1'>
                    <View className='flex items-center gap-1.5'>
                      {upscaleSource ? (
                        <View className='style-chip gap-1.5 pr-1'>
                          <Image className='h-5 w-5 shrink-0 rounded-md' src={upscaleSource.path} mode='aspectFill' />
                          <Text className='max-w-[120px] truncate'>{upscaleSource.name}</Text>
                          <View
                            className='flex h-5 w-5 shrink-0 items-center justify-center rounded-full'
                            onClick={() => {
                              setUpscaleSource(null)
                              setUpscaleSourceSize(null)
                              setUpscaleUrl('')
                              setUpscaleStage('idle')
                            }}
                          >
                            <Icon name='x-a45' className='h-3 w-3' />
                          </View>
                        </View>
                      ) : (
                        <View className='style-chip gap-1.5' onClick={() => void handlePickSource('upscale')}>
                          <Icon name='image-plus-a45' className='h-3.5 w-3.5' />
                          <Text>从相册选择</Text>
                        </View>
                      )}
                      {imageUrl ? (
                        <View className='style-chip gap-1.5' onClick={handleUseCurrentResult}>
                          <Icon name='image-a40' className='h-3.5 w-3.5' />
                          <Text>用当前作品</Text>
                        </View>
                      ) : null}
                      <View
                        className='style-chip gap-1.5'
                        onClick={handleOpenHistoryPicker}
                      >
                        <Icon name='layout-grid-a72' className='h-3.5 w-3.5' />
                        <Text>从生成历史选择</Text>
                      </View>
                    </View>
                  </ScrollView>
                </View>

                <View className='flex min-w-0 items-center gap-2'>
                  <Text className='w-8 shrink-0 text-ios-footnote font-medium text-[rgba(0,0,0,0.50)]'>倍数</Text>
                  <View className='flex items-center gap-1.5'>
                    <View className='style-chip active'>
                      <Text>2×</Text>
                    </View>
                  </View>
                </View>

                <View className='flex min-w-0 items-center gap-2'>
                  <Text className='w-8 shrink-0 text-ios-footnote font-medium text-[rgba(0,0,0,0.50)]'>档位</Text>
                  <View className='flex items-center gap-1.5'>
                    <View className='style-chip active'>
                      <Text>2K 高清</Text>
                    </View>
                  </View>
                </View>

                <Text className='pl-10 text-ios-caption1 text-[rgba(0,0,0,0.46)]'>
                  固定 2 倍放大 · 约 {PIXAI_UPSCALE_COIN_LABEL} 币（按解析度浮动）
                  {upscaleSourceSize ? ` · 原图 ${upscaleSourceSize.width}×${upscaleSourceSize.height}` : ''}
                </Text>
              </>
              )}
            </View>

            {/* ── 底部动作列（ActionRow.tsx:64-163，手机端 flex-col 居中） ── */}
            <View className='flex min-w-0 flex-col gap-2'>
              <View className='flex shrink-0 items-center gap-1.5 self-center'>
                <View
                  className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium ${
                    mode === 'edit'
                      ? 'bg-[rgba(0,122,255,0.12)] text-[#007AFF]'
                      : 'bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.65)]'
                  }`}
                  onClick={() => handleModeChange('edit')}
                >
                  <Icon name='pencil-a65' className='h-3 w-3' />
                  <Text>改图</Text>
                </View>
                <View
                  className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium ${
                    mode === 'upscale'
                      ? 'bg-[rgba(0,122,255,0.12)] text-[#007AFF]'
                      : 'bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.65)]'
                  }`}
                  onClick={() => handleModeChange('upscale')}
                >
                  <Icon name='zoom-in-a65' className='h-3 w-3' />
                  <Text>放大</Text>
                </View>
                <View
                  className='inline-flex h-8 items-center gap-1.5 rounded-full bg-[rgba(0,0,0,0.05)] px-3.5 text-[13px] font-medium text-[rgba(0,0,0,0.65)]'
                  onClick={handleOpenAgent}
                >
                  <Icon name='bot-a40' className='h-3 w-3' />
                  <Text>AI 助理</Text>
                </View>
              </View>

              {/* 模式 CTA（ActionRow.tsx:129-162）：改图 / 放大各自的开始按钮。 */}
              {mode === 'edit' ? (
                <View
                  className={`inline-flex h-11 w-full items-center justify-center gap-2 rounded-ios-xl px-6 text-ios-body font-semibold ${
                    editBusy || !editSource || !prompt.trim()
                      ? 'bg-[rgba(0,0,0,0.16)] text-[rgba(255,255,255,0.90)]'
                      : 'bg-[#007AFF] text-white shadow-[0_6px_24px_rgba(0,122,255,0.40)]'
                  }`}
                  onClick={() => void handleEditSubmit()}
                >
                  <Icon name='pencil-a65' className='h-4 w-4' />
                  <Text>
                    {editStage === 'uploading' ? '上传中…' : editStage === 'generating' ? '改图中…' : '开始改图'}
                  </Text>
                </View>
              ) : null}
              {mode === 'upscale' ? (
                <View
                  className={`inline-flex h-11 w-full items-center justify-center gap-2 rounded-ios-xl px-6 text-ios-body font-semibold ${
                    upscaleBusy || !upscaleSource
                      ? 'bg-[rgba(0,0,0,0.16)] text-[rgba(255,255,255,0.90)]'
                      : 'bg-[#007AFF] text-white shadow-[0_6px_24px_rgba(0,122,255,0.40)]'
                  }`}
                  onClick={() => void handleUpscaleSubmit()}
                >
                  <Icon name='zoom-in-a65' className='h-4 w-4' />
                  <Text>
                    {upscaleStage === 'uploading' ? '上传中…' : upscaleStage === 'generating' ? '放大中…' : '开始放大'}
                  </Text>
                </View>
              ) : null}

              {styleKey !== 'none' ? (
                <View className='lg-tint-blue inline-flex h-9 max-w-full shrink-0 items-center gap-1 self-start rounded-full pl-3.5 pr-1 text-ios-footnote font-medium text-[#007AFF]'>
                  <Text className='truncate'>
                    已套用 {STYLE_PRESETS.find((preset) => preset.key === styleKey)?.label}
                  </Text>
                  <View
                    className='flex h-7 w-7 shrink-0 items-center justify-center rounded-full'
                    onClick={() => handleStyleChange(styleKey)}
                  >
                    <Icon name='x-a45' className='h-3.5 w-3.5' />
                  </View>
                </View>
              ) : null}
            </View>
          </View>
        </View>

        {/* 非致命错误（与 HistoryClient.tsx:613-627 同一条样式语言） */}
        {error ? (
          <View className='mt-4 flex items-center justify-between gap-3 rounded-ios-2xl bg-[rgba(255,59,48,0.08)] px-4 py-3'>
            <Text className='min-w-0 flex-1 text-ios-footnote text-[#FF3B30]'>{error}</Text>
            {quotaError ? (
              <View
                className='shrink-0 rounded-full bg-[rgba(255,59,48,0.12)] px-3 py-1.5 text-ios-caption1 font-semibold text-[#FF3B30]'
                onClick={() => void Taro.navigateTo({ url: '/pages/pricing/index' })}
              >
                <Text>去充值</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {mode === 'generate' && task && task.status === 'queued' ? (
          <Text className='mt-3 block text-center text-ios-caption1 text-[rgba(0,0,0,0.58)]'>
            已排队，等待生成
          </Text>
        ) : null}

        {/* ── 结果画布（ImageDisplay.tsx:111-251） ── */}
        <View
          className='lg-card relative mt-6 w-full overflow-hidden rounded-ios-3xl'
          style={{ height: hasImage || rendering ? 'calc(100vw - 32px)' : '240px' }}
          onClick={hasImage ? handlePreview : undefined}
        >
          <View className='pointer-events-none absolute inset-x-0 top-0 z-20 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-90' />

          {!rendering && (failed || hasImage) ? (
            <View className='absolute inset-x-0 top-0 z-10 flex items-start justify-end gap-3 p-4'>
              <View
                className={`rounded-full px-3 py-1.5 text-ios-caption1 font-semibold ${
                  failed ? 'lg-tint-red text-[#FF3B30]' : 'bg-[rgba(0,0,0,0.52)] text-white'
                }`}
              >
                <Text>{failed ? '需要重试' : '已完成'}</Text>
              </View>
            </View>
          ) : null}

          {hasImage ? (
            <>
              <Image
                className='h-full w-full'
                src={displayedUrl}
                mode='aspectFit'
                onError={() => {
                  if (mode === 'edit') setEditUrl('')
                  else if (mode === 'upscale') setUpscaleUrl('')
                  else setImageUrl('')
                  setError('图片加载失败，请重新生成，或到「生成历史」查看。')
                }}
              />
              <View
                className='pointer-events-none absolute inset-0'
                style={{
                  background:
                    'linear-gradient(180deg,rgba(255,255,255,0.16) 0%,transparent 28%,transparent 72%,rgba(45,49,66,0.12) 100%)',
                }}
              />
              <View
                className='absolute bottom-4 left-4 flex h-11 w-11 items-center justify-center rounded-full border border-[rgba(255,255,255,0.52)] bg-[rgba(255,255,255,0.64)] shadow-[0_14px_30px_rgba(45,49,66,0.08)]'
                onClick={(event) => {
                  event.stopPropagation()
                  void handleSave()
                }}
              >
                <Icon name='download-a45' className='h-4 w-4' />
              </View>
              <View className='absolute bottom-4 right-4 rounded-full bg-[rgba(255,255,255,0.18)] px-3 py-2 text-xs font-medium text-[rgba(255,255,255,0.90)]'>
                <Text>点一下放大</Text>
              </View>
            </>
          ) : rendering ? (
            /* 生成中：网页版是粒子海浪画布（ParticleSeaWaiting.tsx:222-271）；
               小程序去掉 canvas 动画，保留同一套百分比 / 副标 / 进度条版式。 */
            <View className='absolute inset-0 overflow-hidden bg-[#f4f8fc]'>
              <View className='absolute inset-0 z-[6] flex flex-col items-center justify-center'>
                <View className='flex items-end'>
                  <Text className='text-[52px] font-bold leading-none tracking-[-0.05em] text-[#223047]'>
                    {progress}
                  </Text>
                  <Text className='ml-[12px] pb-[6px] text-[24px] leading-none text-[#223047]'>%</Text>
                </View>
                <Text className='mt-2 text-[13px] font-medium tracking-[0.04em] text-[#50718c]'>
                  {mode === 'edit' ? '把原图变成新画面' : mode === 'upscale' ? '正在放大细节' : '把灵感变成画面'}
                </Text>
              </View>
              <Text className='absolute bottom-[52px] left-1/2 -translate-x-1/2 text-[11px] tracking-[0.06em] text-[rgba(45,49,66,0.62)]'>
                {mode === 'edit' ? '正在改图' : mode === 'upscale' ? '正在放大' : '正在雕刻光影与细节'}
              </Text>
              <View className='absolute bottom-[34px] left-1/2 h-[5px] w-[calc(100%-76px)] -translate-x-1/2 overflow-hidden rounded-full bg-[rgba(45,49,66,0.12)]'>
                <View
                  className='h-full rounded-full bg-gradient-to-r from-[#77a8ff] to-[#ff9ec2] transition-all duration-500'
                  style={{ width: `${progress}%` }}
                />
              </View>
            </View>
          ) : (
            <View className='absolute inset-0 flex items-center justify-center p-8'>
              <View className='flex max-w-[20rem] flex-col items-center text-center'>
                <View className='lg-float flex h-20 w-20 items-center justify-center rounded-ios-2xl'>
                  <Icon
                    name={failed ? 'alert-circle-a44' : 'image-a40'}
                    className='h-9 w-9'
                  />
                </View>
                <Text className='mt-5 text-ios-title3 font-semibold tracking-tight text-[rgba(0,0,0,0.72)]'>
                  {failed ? '这次没有成功' : '你的作品，将在这里出现。'}
                </Text>
                <Text className='mt-2 text-ios-subhead leading-relaxed text-[rgba(0,0,0,0.58)]'>
                  {failed ? '换个说法再试一次，通常很快就会恢复。' : '写下想法。第一版画面，随即呈现。'}
                </Text>
              </View>
            </View>
          )}
        </View>
      </View>

      {modelSheetOpen ? (
        <ModelSheet
          open
          models={IMAGE_MODELS}
          value={model.id}
          resolution={resolution}
          vendors={vendors}
          onSelect={handleModelChange}
          onClose={() => setModelSheetOpen(false)}
        />
      ) : null}

      {/* 历史作品选择面板（改图 / 放大原图来源）：GET /api/history withImage=1。 */}
      {sourceSheet ? (
        <View
          className='fixed inset-0 z-[80] flex flex-col justify-end bg-[rgba(0,0,0,0.35)]'
          onClick={() => setSourceSheet(null)}
        >
          <View
            className='max-h-[72vh] overflow-hidden rounded-t-ios-3xl bg-white p-5 pb-8'
            onClick={(event) => event.stopPropagation()}
          >
            <View className='flex items-center justify-between'>
              <Text className='text-ios-title3 font-semibold text-[rgba(0,0,0,0.82)]'>从生成历史选择</Text>
              <View
                className='flex h-8 w-8 items-center justify-center rounded-full bg-[rgba(0,0,0,0.05)]'
                onClick={() => setSourceSheet(null)}
              >
                <Icon name='x-a45' className='h-4 w-4' />
              </View>
            </View>
            {historyLoading ? (
              <Text className='mt-6 block text-center text-ios-footnote text-[rgba(0,0,0,0.50)]'>加载中…</Text>
            ) : historyPicks.length === 0 ? (
              <Text className='mt-6 block text-center text-ios-footnote text-[rgba(0,0,0,0.50)]'>
                还没有可用的历史作品，先在「直接生成」创作一张。
              </Text>
            ) : (
              <ScrollView scrollY className='mt-4 max-h-[52vh]'>
                <View className='flex flex-wrap gap-2'>
                  {historyPicks.map((item) => (
                    <View
                      key={item.id}
                      className='relative h-[96px] overflow-hidden rounded-ios-md bg-[rgba(0,0,0,0.05)]'
                      style={{ width: 'calc((100% - 16px) / 3)' }}
                      onClick={() => handlePickHistoryItem(item)}
                    >
                      <Image className='h-full w-full' src={item.url} mode='aspectFill' />
                    </View>
                  ))}
                </View>
              </ScrollView>
            )}
          </View>
        </View>
      ) : null}
      </PageShell>
    </PageBoundary>
  )
}
