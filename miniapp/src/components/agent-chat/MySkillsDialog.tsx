import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Input, Picker, ScrollView, Text, Textarea, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { cn } from '../../lib/cn'
import { BASE_URL } from '../../lib/request'
import { getToken, getUserId } from '../../lib/storage'
import { Icon } from './icons'
import { parseFamilyLabels, slashMenuUrl } from './SkillSlashMenu'

/**
 * 「我的技能」管理面（照 src/components/agent-chat/MySkillsDialog.tsx）。
 *
 * 定位不变：站内没有公开市集，但使用者要能管理自己的 Skill，且自己的 Skill 要能在
 * 输入框用「/」直呼。端点沿用冻结契约：
 *   GET/POST /api/skills/mine，DELETE /api/skills/mine/<id>。
 *
 * 三条硬要求照抄：① 未登入只说真话（不摆假成功）；② 后端 reason 一律经
 * humanizeSkillError 翻译、绝不原文外泄；③ 删除二次确认。
 *
 * 平台差异（白名单）：createPortal → fixed 浮层；<select> → Taro Picker；
 * <input>/<textarea> → Taro Input/Textarea；登入交接面板（PwaHandoffPanel）不在
 * 小程序能力面内，未登入直接引导到「我的」页登录。
 */

/* ─────────────────────────── 型别与纯函式（照抄） ─────────────────────────── */

export interface MySkillRow {
  id: string
  name: string
  oneLiner: string
  family: string
  useScenario: string
  inputType: string
  outputContent: string
  outputKind: string
  tags: string[]
}

/** 输出类型选项（真源＝src/lib/agent-skills/output-kinds.ts；本档无跨包 import 条件）。 */
export const SKILL_OUTPUT_KINDS: readonly { id: string; label: string }[] = [
  { id: 'image', label: '图像' },
  { id: 'text', label: '文本' },
  { id: 'video', label: '视频' },
  { id: 'audio', label: '音频' },
  { id: 'director', label: '导演' },
  { id: 'mixed', label: '混合' },
] as const

/** 型别 → 可调用工具（后端要求 toolIds 非空；由交付形态推导，不让使用者背工具名）。 */
const TOOLS_BY_OUTPUT_KIND: Record<string, readonly string[]> = {
  image: ['image_generate'],
  text: ['doc_struct'],
  video: ['last_frame_video_chain'],
  audio: ['tts_speak'],
  director: ['director_select'],
  mixed: ['image_generate', 'last_frame_video_chain'],
}

export function deriveToolIds(outputKind: string): string[] {
  return [...(TOOLS_BY_OUTPUT_KIND[outputKind] ?? [])]
}

/** 标签输入 → 标签阵列（逗号/顿号/换行分隔；去空、去重、上限 8）。 */
export function splitSkillTags(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of String(raw ?? '').split(/[,，、\n]+/)) {
    const tag = part.trim()
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= 8) break
  }
  return out
}

export function mineSkillUrl(id: string): string {
  return `/api/skills/mine/${encodeURIComponent(id)}`
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** 解析 `{ skills }` → 管理面列（畸形条目丢掉，不猜不补）。 */
export function parseMySkills(payload: unknown): MySkillRow[] {
  const raw = (payload as { skills?: unknown } | null | undefined)?.skills
  if (!Array.isArray(raw)) return []
  const out: MySkillRow[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = str(row.id)
    const name = str(row.name)
    if (!id || !name) continue
    out.push({
      id,
      name,
      oneLiner: str(row.oneLiner),
      family: str(row.family),
      useScenario: str(row.useScenario),
      inputType: str(row.inputType),
      outputContent: str(row.outputContent),
      outputKind: str(row.outputKind),
      tags: Array.isArray(row.tags) ? row.tags.map((tag) => str(tag)).filter(Boolean) : [],
    })
  }
  return out
}

/**
 * 错误 → 人话（纯函式，任何分支都不得把输入原样回传）。
 * 后端 reason 是稳定代码；凭证类代码更不得在文案里二次外泄细节。
 */
export function humanizeSkillError(reason: unknown, status?: number): string {
  if (status === 401) return '请先登录后再管理自己的技能。'
  if (status === 404) return '这条技能已经不在了，刷新看看。'
  if (status === 409) return '已经有一条同名技能了，换个名称，或直接编辑它。'
  if (status === 429) return '今天新增的技能有点多，明天再试吧。'
  if (status === 502 || status === 503 || status === 504) return '服务暂时不可用，请稍后再试。'

  const code = typeof reason === 'string' ? reason.trim() : ''
  if (!code) return '操作没成功，请稍后重试。'
  if (code === 'network_error') return '网络不给力，请检查连接后重试。'
  if (code.startsWith('sensitive_content')) {
    return '内容里像是含有密钥或隐私信息，请移除后再保存。'
  }

  const MAP: Record<string, string> = {
    invalid_skill: '这条技能还没填完整，请检查各栏后再保存。',
    invalid_json: '提交的内容格式不对，请重试。',
    name_required: '请填写技能名称。',
    name_too_long: '技能名称太长了，请精简到 32 个字以内。',
    name_invalid: '技能名称里有不能用的字符，请换一个。',
    one_liner_required: '请写一句话介绍。',
    one_liner_too_long: '一句话介绍太长了，请精简到 24 个字以内。',
    family_invalid: '请选择一个题材家族。',
    output_kind_invalid: '请选择输出类型。',
    use_scenario_required: '请填写使用场景。',
    input_type_required: '请填写需要提供什么。',
    output_content_required: '请填写会交付什么。',
    tool_ids_required: '这条技能还没有可调用的工具，请换个输出类型。',
    tool_ids_count: '可调用的工具太多了，请精简。',
    tool_id_not_found: '有工具当前不可用，请换个输出类型。',
    tags_required: '请至少写一个标签。',
    tags_count: '标签最多 8 个。',
    tag_invalid: '标签里有不能用的字符。',
    tag_too_long: '有个标签太长了，请精简。',
    expert_not_found: '指定的专家不存在，请清除后重试。',
    id_invalid: '这条技能的标识不合法，请退出后重新新建。',
    content_too_long: '内容太长了，请精简后再保存。',
    duplicate: '已经有一条同名技能了，换个名称，或直接编辑它。',
    quota_exceeded: '今天新增技能的数量到上限了，明天再来。',
    structure: '这条技能的内容不完整，请检查后再保存。',
    rejected: '这条技能被拒绝了，请修改后再保存。',
    unauthorized: '请先登录后再管理自己的技能。',
  }
  if (MAP[code]) return MAP[code]
  if (code.startsWith('one_liner_')) return '一句话介绍里有不合适的内容，请修改。'
  if (
    code.startsWith('use_scenario_') ||
    code.startsWith('input_type_') ||
    code.startsWith('output_content_') ||
    code.startsWith('aesthetic_')
  ) {
    return '填写的内容里有不合适的地方，请修改后再保存。'
  }
  return '操作没成功，请检查填写内容后重试。'
}

/* ─────────────────────────── 网络 ─────────────────────────── */

function authHeaders(): Record<string, string> | null {
  const token = getToken()
  const userId = getUserId()
  if (!token || !userId) return null
  return { Authorization: `Bearer ${token}`, 'x-user-id': String(userId) }
}

interface ApiResult {
  status: number
  data: unknown
  /** 网络层失败（不是 HTTP 状态）。 */
  network: boolean
}

async function apiRequest(
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
): Promise<ApiResult> {
  const headers = authHeaders()
  if (!headers) return { status: 401, data: null, network: false }
  try {
    const res = await Taro.request({
      url: `${BASE_URL}${path}`,
      method,
      data: body as Taro.request.Option['data'],
      header: { ...headers, 'Content-Type': 'application/json', accept: 'application/json' },
      timeout: 15_000,
    })
    return { status: res.statusCode, data: res.data, network: false }
  } catch {
    return { status: 0, data: null, network: true }
  }
}

function reasonOf(data: unknown): string | undefined {
  if (data && typeof data === 'object') {
    const payload = data as { reason?: unknown; error?: unknown }
    if (typeof payload.reason === 'string') return payload.reason
    if (typeof payload.error === 'string') return payload.error
  }
  return undefined
}

/* ─────────────────────────── 表单 ─────────────────────────── */

interface SkillFormState {
  id: string
  name: string
  oneLiner: string
  family: string
  useScenario: string
  inputType: string
  outputContent: string
  outputKind: string
  tags: string
}

const EMPTY_FORM: SkillFormState = {
  id: '',
  name: '',
  oneLiner: '',
  family: '',
  useScenario: '',
  inputType: '',
  outputContent: '',
  outputKind: 'image',
  tags: '',
}

const INPUT_CLASS =
  'w-full rounded-lg border border-input bg-black/5 px-2.5 py-1.5 text-ios-caption1 outline-none'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className='block'>
      <Text className='mb-1 block text-ios-caption2 font-medium text-foreground/60'>{label}</Text>
      {children}
    </View>
  )
}

export interface MySkillsDialogProps {
  onClose: () => void
}

export function MySkillsDialog({ onClose }: MySkillsDialogProps) {
  // null＝载入中，[]＝已载入但为空。
  const [skills, setSkills] = useState<MySkillRow[] | null>(null)
  const [loggedOut, setLoggedOut] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [form, setForm] = useState<SkillFormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [families, setFamilies] = useState<Array<{ id: string; label: string }>>([])

  const aliveRef = useRef(true)

  const loadFamilies = useCallback(async () => {
    try {
      const res = await Taro.request({
        url: `${BASE_URL}${slashMenuUrl('', 1)}`,
        method: 'GET',
        header: { accept: 'application/json' },
        timeout: 10_000,
      })
      if (res.statusCode < 200 || res.statusCode >= 300) return
      const labels = parseFamilyLabels(res.data)
      if (!aliveRef.current) return
      setFamilies(Object.entries(labels).map(([id, label]) => ({ id, label })))
    } catch {
      // 家族表拿不到不挡保存：退回让使用者自己填 family id。
    }
  }, [])

  const loadSkills = useCallback(async () => {
    if (!authHeaders()) {
      setLoggedOut(true)
      setSkills([])
      return
    }
    setSkills(null)
    setError(null)
    const result = await apiRequest('/api/skills/mine', 'GET')
    if (!aliveRef.current) return
    if (result.network) {
      setSkills([])
      setError(humanizeSkillError('network_error'))
      return
    }
    if (result.status === 401) {
      setLoggedOut(true)
      setSkills([])
      return
    }
    if (result.status < 200 || result.status >= 300) {
      setSkills([])
      setError(humanizeSkillError(reasonOf(result.data), result.status))
      return
    }
    setLoggedOut(false)
    setSkills(parseMySkills(result.data))
  }, [])

  useEffect(() => {
    aliveRef.current = true
    void loadFamilies()
    void loadSkills()
    return () => {
      aliveRef.current = false
    }
  }, [loadFamilies, loadSkills])

  const patch = useCallback((delta: Partial<SkillFormState>) => {
    setForm((prev) => (prev ? { ...prev, ...delta } : prev))
  }, [])

  const startCreate = useCallback(() => {
    setError(null)
    setConfirmId(null)
    setForm({ ...EMPTY_FORM, family: families[0]?.id ?? '' })
  }, [families])

  const startEdit = useCallback((skill: MySkillRow) => {
    setError(null)
    setConfirmId(null)
    setForm({
      id: skill.id,
      name: skill.name,
      oneLiner: skill.oneLiner,
      family: skill.family,
      useScenario: skill.useScenario,
      inputType: skill.inputType,
      outputContent: skill.outputContent,
      outputKind: skill.outputKind || 'image',
      tags: skill.tags.join('，'),
    })
  }, [])

  /** 本地先挡一轮必填（送出前的真话），通过才打后端。 */
  const localIssue = useCallback((state: SkillFormState): string | null => {
    if (!state.name.trim()) return '请填写技能名称。'
    if (!state.oneLiner.trim()) return '请写一句话介绍。'
    if (!state.family.trim()) return '请选择一个题材家族。'
    if (!state.useScenario.trim()) return '请填写使用场景。'
    if (!state.inputType.trim()) return '请填写需要提供什么。'
    if (!state.outputContent.trim()) return '请填写会交付什么。'
    if (splitSkillTags(state.tags).length === 0) return '请至少写一个标签。'
    if (deriveToolIds(state.outputKind).length === 0) return '请选择输出类型。'
    return null
  }, [])

  const submit = useCallback(async () => {
    if (!form || saving) return
    const issue = localIssue(form)
    if (issue) {
      setError(issue)
      return
    }
    if (!authHeaders()) {
      setLoggedOut(true)
      return
    }
    setSaving(true)
    setError(null)
    const result = await apiRequest('/api/skills/mine', 'POST', {
      ...(form.id ? { id: form.id } : {}),
      name: form.name.trim(),
      oneLiner: form.oneLiner.trim(),
      family: form.family.trim(),
      useScenario: form.useScenario.trim(),
      inputType: form.inputType.trim(),
      outputContent: form.outputContent.trim(),
      outputKind: form.outputKind,
      toolIds: deriveToolIds(form.outputKind),
      tags: splitSkillTags(form.tags),
    })
    if (!aliveRef.current) return
    setSaving(false)
    if (result.network) {
      setError(humanizeSkillError('network_error'))
      return
    }
    if (result.status === 401) {
      setLoggedOut(true)
      return
    }
    if (result.status < 200 || result.status >= 300) {
      setError(humanizeSkillError(reasonOf(result.data), result.status))
      return
    }
    setForm(null)
    await loadSkills()
  }, [form, loadSkills, localIssue, saving])

  const remove = useCallback(
    async (id: string) => {
      if (!authHeaders()) {
        setLoggedOut(true)
        return
      }
      setBusyId(id)
      setError(null)
      const result = await apiRequest(mineSkillUrl(id), 'DELETE')
      if (!aliveRef.current) return
      setBusyId(null)
      if (result.network) {
        setError(humanizeSkillError('network_error'))
        return
      }
      if (result.status === 401) {
        setLoggedOut(true)
        return
      }
      if (result.status < 200 || result.status >= 300) {
        setError(humanizeSkillError(reasonOf(result.data), result.status))
        return
      }
      setConfirmId(null)
      await loadSkills()
    },
    [loadSkills],
  )

  const familyOptions = families
  const matchedFamilyIndex = familyOptions.findIndex((family) => family.id === form?.family)
  const familyIndex = Math.max(0, matchedFamilyIndex)
  const familyLabels = familyOptions.map((family) => family.label)
  const outputIndex = Math.max(
    0,
    SKILL_OUTPUT_KINDS.findIndex((kind) => kind.id === form?.outputKind),
  )

  return (
    <View className='fixed inset-0 z-[90] flex items-center justify-center p-4'>
      <View className='absolute inset-0 bg-black/25' onClick={onClose} />
      {/* 定高卡片：小程序 scroll-view 需要确定高度才能滚（网页 max-h 在 weapp 不可靠）。 */}
      <View
        className='lg-sheet relative flex w-full max-w-md flex-col overflow-hidden rounded-ios-2xl p-1'
        style={{ height: '82vh', maxHeight: '42rem' }}
      >
        <View className='pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80' />
        <View className='flex shrink-0 items-center justify-between gap-2 px-2.5 pb-1.5 pt-2'>
          <Text className='text-ios-footnote font-medium text-foreground'>我的技能</Text>
          <View
            className='flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-foreground/45'
            onClick={onClose}
          >
            <Icon name='x-a45' className='h-3.5 w-3.5' />
          </View>
        </View>

        <ScrollView scrollY className='min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-2' style={{ height: 0 }}>
          {loggedOut ? (
            <View className='flex flex-col items-start gap-2 py-3'>
              <Text className='text-ios-caption1 leading-relaxed text-foreground/55'>
                登录后可以保存自己的技能
              </Text>
              <View
                className='rounded-full bg-ios-blue px-3 py-1 text-ios-caption1 font-medium text-white'
                onClick={() => {
                  onClose()
                  void Taro.navigateTo({ url: '/pages/mine/index' })
                }}
              >
                <Text>去登录</Text>
              </View>
            </View>
          ) : form ? (
            /* ── 表单（新增／编辑）── */
            <View className='flex flex-col gap-2.5 py-1'>
              <Field label='名称'>
                <Input
                  value={form.name}
                  onInput={(event) => patch({ name: event.detail.value })}
                  maxlength={32}
                  placeholder='例如：咖啡馆开场镜头'
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label='一句话介绍'>
                <Input
                  value={form.oneLiner}
                  onInput={(event) => patch({ oneLiner: event.detail.value })}
                  maxlength={24}
                  placeholder='一句话说清它干什么（24 字内）'
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label='题材家族'>
                {familyOptions.length > 0 ? (
                  <Picker
                    mode='selector'
                    range={familyLabels}
                    value={familyIndex}
                    onChange={(event) => {
                      const picked = familyOptions[Number(event.detail.value)]
                      if (picked) patch({ family: picked.id })
                    }}
                  >
                    <View className={INPUT_CLASS}>
                      <Text className='text-ios-caption1 text-foreground'>
                        {matchedFamilyIndex >= 0
                          ? familyOptions[matchedFamilyIndex]?.label
                          : form.family || '请选择'}
                      </Text>
                    </View>
                  </Picker>
                ) : (
                  <Input
                    value={form.family}
                    onInput={(event) => patch({ family: event.detail.value })}
                    placeholder='家族标识（例如 cinema-auteur）'
                    className={INPUT_CLASS}
                  />
                )}
              </Field>
              <Field label='使用场景'>
                <Textarea
                  value={form.useScenario}
                  onInput={(event) => patch({ useScenario: event.detail.value })}
                  maxlength={600}
                  autoHeight
                  placeholder='什么情况下用它'
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label='如何使用（需要提供什么）'>
                <Textarea
                  value={form.inputType}
                  onInput={(event) => patch({ inputType: event.detail.value })}
                  maxlength={600}
                  autoHeight
                  placeholder='例如：一句场景描述 + 参考图'
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label='输出内容'>
                <Textarea
                  value={form.outputContent}
                  onInput={(event) => patch({ outputContent: event.detail.value })}
                  maxlength={600}
                  autoHeight
                  placeholder='会交付什么'
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label='类型'>
                <Picker
                  mode='selector'
                  range={SKILL_OUTPUT_KINDS.map((kind) => kind.label)}
                  value={outputIndex}
                  onChange={(event) => {
                    const picked = SKILL_OUTPUT_KINDS[Number(event.detail.value)]
                    if (picked) patch({ outputKind: picked.id })
                  }}
                >
                  <View className={INPUT_CLASS}>
                    <Text className='text-ios-caption1 text-foreground'>
                      {SKILL_OUTPUT_KINDS[outputIndex]?.label ?? '请选择'}
                    </Text>
                  </View>
                </Picker>
              </Field>
              <Field label='标签'>
                <Input
                  value={form.tags}
                  onInput={(event) => patch({ tags: event.detail.value })}
                  placeholder='用逗号分隔，最多 8 个'
                  className={INPUT_CLASS}
                />
              </Field>
              <View className='mt-0.5 flex items-center justify-end gap-2'>
                <View
                  className={cn(
                    'rounded-full px-3 py-1 text-ios-caption1 font-medium text-foreground/55',
                    saving && 'opacity-50',
                  )}
                  onClick={() => {
                    if (saving) return
                    setForm(null)
                    setError(null)
                  }}
                >
                  <Text>取消</Text>
                </View>
                <View
                  className={cn(
                    'flex items-center gap-1.5 rounded-full bg-ios-blue px-3 py-1 text-ios-caption1 font-medium text-white',
                    saving && 'opacity-70',
                  )}
                  onClick={() => {
                    if (!saving) void submit()
                  }}
                >
                  {saving ? <Icon name='loader-2-white' className='ic-spin h-3 w-3' /> : null}
                  <Text>{form.id ? '保存修改' : '保存技能'}</Text>
                </View>
              </View>
            </View>
          ) : (
            /* ── 清单 ── */
            <View className='flex flex-col gap-1'>
              <View className='flex items-center justify-between gap-2 pb-1'>
                <Text className='text-ios-caption2 text-foreground/45'>
                  {skills === null ? '正在加载…' : `共 ${skills.length} 条`}
                </Text>
                <View
                  className='flex items-center gap-1 rounded-full px-2 py-0.5 text-ios-caption1 font-medium text-ios-blue'
                  onClick={startCreate}
                >
                  <Icon name='plus-a50' className='h-3 w-3' />
                  <Text>新增</Text>
                </View>
              </View>

              {skills === null ? (
                <Text className='block px-1 py-3 text-center text-ios-caption1 text-foreground/45'>
                  正在加载我的技能…
                </Text>
              ) : skills.length === 0 && !error ? (
                <Text className='block px-1 py-3 text-center text-ios-caption1 text-foreground/45'>
                  还没有自己的技能，点「新增」建一条
                </Text>
              ) : (
                skills.map((skill) => {
                  const label = families.find((family) => family.id === skill.family)?.label ?? skill.family
                  const confirming = confirmId === skill.id
                  return (
                    <View
                      key={skill.id}
                      className='flex items-center justify-between gap-2 rounded-lg px-1.5 py-1.5'
                    >
                      <View className='flex min-w-0 flex-1 flex-col gap-0.5'>
                        <View className='flex min-w-0 items-center gap-1.5'>
                          <Text className='min-w-0 flex-1 truncate text-ios-caption1 font-medium text-foreground'>
                            {skill.name}
                          </Text>
                          {label ? (
                            <Text className='shrink-0 rounded-full bg-black/[0.06] px-1.5 text-ios-caption2 text-foreground/55'>
                              {label}
                            </Text>
                          ) : null}
                        </View>
                        {skill.oneLiner ? (
                          <Text className='block truncate text-ios-caption2 text-foreground/50'>
                            {skill.oneLiner}
                          </Text>
                        ) : null}
                      </View>
                      {confirming ? (
                        <View className='flex shrink-0 items-center gap-1.5'>
                          <Text className='text-ios-caption2 text-foreground/55'>确定删除？</Text>
                          <View
                            className={cn(
                              'rounded-full bg-ios-red px-2 py-0.5 text-ios-caption1 font-medium text-white',
                              busyId === skill.id && 'opacity-70',
                            )}
                            onClick={() => {
                              if (busyId !== skill.id) void remove(skill.id)
                            }}
                          >
                            <Text>{busyId === skill.id ? '删除中…' : '删除'}</Text>
                          </View>
                          <View
                            className='rounded-full px-2 py-0.5 text-ios-caption1 font-medium text-foreground/55'
                            onClick={() => setConfirmId(null)}
                          >
                            <Text>取消</Text>
                          </View>
                        </View>
                      ) : (
                        <View className='flex shrink-0 items-center gap-1'>
                          <View
                            className='flex h-9 items-center rounded-lg px-1.5 text-ios-caption2 text-ios-blue'
                            onClick={() => startEdit(skill)}
                          >
                            <Text>编辑</Text>
                          </View>
                          <View
                            className='flex h-9 items-center rounded-lg px-1.5 text-ios-caption2 text-ios-red'
                            onClick={() => {
                              setError(null)
                              setConfirmId(skill.id)
                            }}
                          >
                            <Text>删除</Text>
                          </View>
                        </View>
                      )}
                    </View>
                  )
                })
              )}
            </View>
          )}

          {error ? (
            <Text className='mt-2 block rounded-lg bg-ios-red/[0.08] px-2.5 py-1.5 text-ios-caption2 leading-relaxed text-ios-red'>
              {error}
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </View>
  )
}
