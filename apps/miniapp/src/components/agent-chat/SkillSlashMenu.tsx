import { useEffect, useMemo, useRef, useState } from 'react'
import { ScrollView, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { cn } from '../../lib/cn'
import { BASE_URL } from '../../lib/request'
import { getToken, getUserId } from '../../lib/storage'

/**
 * 打「/」直呼技能——输入框正上方的浮层（照 src/components/agent-chat/SkillSlashMenu.tsx）。
 *
 * 职责边界不变：**纯展示＋网络只读**（GET /api/skills 公开库、GET /api/skills/mine
 * 我的技能；未登入的后者静默略过）。「选中之后干什么」由 AgentComposer 负责
 * （只把技能名写回输入框，不自动送出、不碰附件与计费）。
 *
 * 平台差异（白名单）：fetch → Taro.request；无法 AbortController，用 alive 代数守卫
 * 丢弃换代后的旧响应（先发后到的旧结果绝不覆盖新查询）。定位改为内联
 * absolute bottom-full（无 portal，父层 composer 根为 relative）。
 */

export interface SlashMenuSkill {
  id: string
  name: string
  oneLiner: string
  family: string
}

/** 单次可见列数上限（与 `/api/skills?limit=` 同值）。 */
export const SLASH_MENU_LIMIT = 8

/** 查询 debounce 下限 150ms；取 160ms 与站内其它输入防抖同量级。 */
export const SLASH_MENU_DEBOUNCE_MS = 160

/** 请求状态：loading＝在飞（含 debounce 等待），ready＝落地（含空结果），error＝不可用。 */
export type SlashMenuStatus = 'loading' | 'ready' | 'error'

/* ─────────────────────────── 纯函数层（照抄网页版） ─────────────────────────── */

/** 菜单闸门：输入框为空，或首字符是「/」才允许开菜单。 */
export function shouldOpenSlashMenu(text: string): boolean {
  return text === '' || text.startsWith('/')
}

/** 「/」之后的文字＝查询词。非指令形态一律回空串。 */
export function slashQueryOf(text: string): string {
  return text.startsWith('/') ? text.slice(1).trim() : ''
}

/** 上下键移动（回绕）；小程序无方向键，保留给点击/后续扩展与纯函数复用。 */
export function moveActiveIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  const inRange = Number.isInteger(index) && index >= 0 && index < length
  const base = inRange ? index : 0
  return (((base + delta) % length) + length) % length
}

/** 选中一条技能 → 写回输入框的文字（与网页版逐字一致）。 */
export function applySkillPick(current: string, skill: { name: string }): string {
  const command = `/${skill.name} `
  const base = current.trim()
  if (!base || current.startsWith('/')) return command
  return `${base} ${command}`
}

/** 只读列举/搜寻端点的 URL（编码交给 encodeURIComponent）。 */
export function slashMenuUrl(query: string, limit: number = SLASH_MENU_LIMIT): string {
  return `/api/skills?q=${encodeURIComponent(query.trim())}&limit=${limit}`
}

/** 我的技能端点。 */
export function slashMineUrl(): string {
  return '/api/skills/mine'
}

/** 解析 `{ skills, total, families }` 里的 skills → 菜单列（畸形条目丢掉，不猜不补）。 */
export function parseSlashSkills(payload: unknown): SlashMenuSkill[] {
  const raw = (payload as { skills?: unknown } | null | undefined)?.skills
  if (!Array.isArray(raw)) return []
  const out: SlashMenuSkill[] = []
  for (const item of raw) {
    if (out.length >= SLASH_MENU_LIMIT) break
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    if (!id || !name) continue
    out.push({
      id,
      name,
      oneLiner: typeof row.oneLiner === 'string' ? row.oneLiner.trim() : '',
      family: typeof row.family === 'string' ? row.family.trim() : '',
    })
  }
  return out
}

/** 解析 `{ families: [{id,label,count}] }` → id→简体标签（标签真源在上游）。 */
export function parseFamilyLabels(payload: unknown): Record<string, string> {
  const raw = (payload as { families?: unknown } | null | undefined)?.families
  if (!Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    if (typeof row.id === 'string' && typeof row.label === 'string' && row.label) {
      out[row.id] = row.label
    }
  }
  return out
}

export const SLASH_MINE_SECTION_LABEL = '我的技能'

export interface SlashMenuSection {
  key: 'public' | 'mine'
  /** 空串＝不渲染分区标题（公开库无标题）。 */
  label: string
  skills: SlashMenuSkill[]
}

function dedupeSkills(list: readonly SlashMenuSkill[]): SlashMenuSkill[] {
  const seen = new Set<string>()
  const out: SlashMenuSkill[] = []
  for (const skill of list) {
    if (seen.has(skill.id)) continue
    seen.add(skill.id)
    out.push(skill)
  }
  return out
}

/** 两路结果合并：公开库在上、我的技能在下（命中才出现）；按 id 去重，公开库优先。 */
export function mergeSlashResults(
  publicList: readonly SlashMenuSkill[],
  myList: readonly SlashMenuSkill[],
): SlashMenuSection[] {
  const publicRows = dedupeSkills(publicList).slice(0, SLASH_MENU_LIMIT)
  const seen = new Set(publicRows.map((skill) => skill.id))
  const myRows = dedupeSkills(myList)
    .filter((skill) => !seen.has(skill.id))
    .slice(0, SLASH_MENU_LIMIT)

  const sections: SlashMenuSection[] = []
  if (publicRows.length > 0) sections.push({ key: 'public', label: '', skills: publicRows })
  if (myRows.length > 0) sections.push({ key: 'mine', label: SLASH_MINE_SECTION_LABEL, skills: myRows })
  return sections
}

/** 选区展平：只有技能列进选区，分区标题不进。 */
export function flattenSlashRows(sections: readonly SlashMenuSection[]): SlashMenuSkill[] {
  const out: SlashMenuSkill[] = []
  for (const section of sections) out.push(...section.skills)
  return out
}

/* ─────────────────────────── 网络只读 ─────────────────────────── */

function tryAuthHeaders(): Record<string, string> | null {
  const token = getToken()
  const userId = getUserId()
  if (!token || !userId) return null
  return { Authorization: `Bearer ${token}`, 'x-user-id': String(userId) }
}

async function fetchJson(path: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await Taro.request({
    url: `${BASE_URL}${path}`,
    method: 'GET',
    header: { ...headers, accept: 'application/json' },
    timeout: 10_000,
  })
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`skills ${res.statusCode}`)
  }
  return res.data
}

/* ─────────────────────────── 元件层 ─────────────────────────── */

export interface SkillSlashMenuProps {
  /** 查询词（`/` 之后的文字）；变化即重新搜索（debounce）。 */
  query: string
  /** 当前选中行（受控：由父层记录；点击行会回报）。 */
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  /** 选中一条（点行或父层确认键）。父层负责写回输入框，本层不送出。 */
  onPick: (skill: SlashMenuSkill) => void
  /** 收起菜单（点外/父层 Esc 等价动作）。 */
  onClose: () => void
  /** 可见列表上报（父层 Enter/确认键按 activeIndex 取当前项）。 */
  onSkillsChange?: (skills: SlashMenuSkill[]) => void
}

export function SkillSlashMenu({
  query,
  activeIndex,
  onActiveIndexChange,
  onPick,
  onClose,
  onSkillsChange,
}: SkillSlashMenuProps) {
  const [publicSkills, setPublicSkills] = useState<SlashMenuSkill[]>([])
  const [mySkills, setMySkills] = useState<SlashMenuSkill[]>([])
  const [familyLabels, setFamilyLabels] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<SlashMenuStatus>('loading')

  const onSkillsChangeRef = useRef(onSkillsChange)
  onSkillsChangeRef.current = onSkillsChange
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const term = query.trim()
    let alive = true
    setStatus('loading')
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const payload = await fetchJson(slashMenuUrl(term))
          if (!alive) return
          setPublicSkills(parseSlashSkills(payload))
          setFamilyLabels(parseFamilyLabels(payload))
          setStatus('ready')
        } catch {
          if (!alive) return
          setPublicSkills([])
          setStatus('error')
        }
      })()
      void (async () => {
        // 我的技能：未登入与任何失败一律静默略过（不报错、不摆空区块、不伪造条目）。
        const headers = tryAuthHeaders()
        if (!headers) {
          if (alive) setMySkills([])
          return
        }
        try {
          const payload = await fetchJson(slashMineUrl(), headers)
          if (!alive) return
          setMySkills(parseSlashSkills(payload))
        } catch {
          if (!alive) return
          setMySkills([])
        }
      })()
    }, SLASH_MENU_DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query])

  const sections = useMemo(() => mergeSlashResults(publicSkills, mySkills), [publicSkills, mySkills])
  const rows = useMemo(() => flattenSlashRows(sections), [sections])

  useEffect(() => {
    onSkillsChangeRef.current?.(rows)
  }, [rows])

  const empty = rows.length === 0

  return (
    <>
      {/* 点外收起：小程序没有 document 级 pointerdown，用透明遮罩等价实现。 */}
      <View className='fixed inset-0 z-40' onClick={() => onCloseRef.current()} />
      <View
        data-slash-menu='true'
        className='lg-float absolute bottom-full left-1.5 right-1.5 z-50 mb-2 min-w-0 rounded-ios-xl p-1'
      >
      <View className='pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80' />

      {empty && (status === 'loading' || status === 'error') ? (
        <Text className='block px-2.5 py-2 text-ios-footnote text-foreground/45'>
          {status === 'loading' ? '正在搜索技能…' : '技能库暂时不可用'}
        </Text>
      ) : empty ? (
        <Text className='block px-2.5 py-2 text-ios-footnote text-foreground/45'>没有匹配的技能</Text>
      ) : (
        <ScrollView
          scrollY
          className='overflow-y-auto overscroll-contain'
          // weapp scroll-view 要确定高度才滚：超过 5 行固定 19rem，少量行交给内容高度。
          style={rows.length > 5 ? { height: '19rem' } : undefined}
        >
          {sections.map((section) => (
            <View key={section.key}>
              {section.label ? (
                <Text className='block px-2.5 pb-0.5 pt-1.5 text-ios-caption1 font-medium text-foreground/60'>
                  {section.label}
                </Text>
              ) : null}
              {section.skills.map((skill) => {
                const index = rows.indexOf(skill)
                const label = familyLabels[skill.family] ?? skill.family
                const active = index === activeIndex
                return (
                  <View
                    key={skill.id}
                    className={cn(
                      'block w-full rounded-[14px] px-2.5 py-2',
                      active ? 'bg-black/[0.06]' : '',
                    )}
                    onClick={() => {
                      onActiveIndexChange(index)
                      onPick(skill)
                    }}
                  >
                    <View className='flex min-w-0 items-center gap-2'>
                      <Text className='min-w-0 flex-1 truncate text-ios-footnote font-medium text-foreground'>
                        {skill.name}
                      </Text>
                      {label ? (
                        <Text className='shrink-0 rounded-full bg-black/[0.06] px-1.5 text-ios-caption1 text-foreground/55'>
                          {label}
                        </Text>
                      ) : null}
                    </View>
                    {skill.oneLiner ? (
                      <Text className='mt-0.5 block truncate text-ios-caption1 text-foreground/50'>
                        {skill.oneLiner}
                      </Text>
                    ) : null}
                  </View>
                )
              })}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
    </>
  )
}
