// Agent 设定（思考级别 / 交互模式…）的白名单校验与持久化。
//
// 真源逐行照搬 src/lib/agent-chat-client/settings.ts（133 行）：
//   - sanitizeAgentSettings：localStorage 与网关的脏数据逐字段落回默认值；
//   - readCachedAgentSettings / writeCachedAgentSettings：零网络本地缓存；
//   - getAgentSettings / saveAgentSettings：网关为准，失败静默回默认/保留本地；
//   - 思考级别四档是 persona / cost_mode / beast_mode 三栏的联合快捷档，
//     AGENT_THINKING_LEVEL_SETTINGS 是唯一真源，组件不许另抄一份 mapping。
//
// 平台差异：本地缓存从 window.localStorage 换成 Taro storage（同步 API，
// 隐私模式同样可能抛错，读失败一律回默认值）。

import Taro from '@tarojs/taro'
import { getUserId } from './storage'
import { request } from './request'

export type AgentInterruptMode = 'steer' | 'queue'
export type AgentPersonaMode = 'efficient' | 'thoughtful'
export type AgentCostMode = 'economy' | 'balanced' | 'premium'
export type AgentInteractionMode = 'collaborate' | 'preset' | 'auto'
export type AgentThinkingLevel = 'low' | 'medium' | 'high' | 'extreme'

export interface AgentSettings {
  interrupt_mode: AgentInterruptMode
  persona: AgentPersonaMode
  cost_mode: AgentCostMode
  interaction_mode: AgentInteractionMode
  beast_mode: boolean
  memory_use: boolean
  memory_generate: boolean
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  interrupt_mode: 'steer',
  persona: 'efficient',
  cost_mode: 'balanced',
  interaction_mode: 'preset',
  beast_mode: false,
  memory_use: true,
  memory_generate: true,
}

export const AGENT_SETTINGS_STORAGE_KEY = 'agent-settings-v1'
export const AGENT_THINKING_LEVEL_STORAGE_KEY = 'agent-thinking-level-v1'

export const INTERRUPT_MODES: readonly AgentInterruptMode[] = ['steer', 'queue']
export const PERSONA_MODES: readonly AgentPersonaMode[] = ['efficient', 'thoughtful']
export const COST_MODES: readonly AgentCostMode[] = ['economy', 'balanced', 'premium']
export const INTERACTION_MODES: readonly AgentInteractionMode[] = ['collaborate', 'preset', 'auto']
export const AGENT_THINKING_LEVELS: readonly AgentThinkingLevel[] = ['low', 'medium', 'high', 'extreme']

/** 级别 → AgentSettings 三栏映射（唯一真源）。 */
export const AGENT_THINKING_LEVEL_SETTINGS: Record<
  AgentThinkingLevel,
  Pick<AgentSettings, 'persona' | 'cost_mode' | 'beast_mode'>
> = {
  low: { persona: 'efficient', cost_mode: 'economy', beast_mode: false },
  medium: { persona: 'efficient', cost_mode: 'balanced', beast_mode: false },
  high: { persona: 'thoughtful', cost_mode: 'balanced', beast_mode: false },
  extreme: { persona: 'thoughtful', cost_mode: 'premium', beast_mode: true },
}

/** 逐字段白名单校验：本地缓存与网关的脏数据一律落回默认值。 */
export function sanitizeAgentSettings(raw: unknown): AgentSettings {
  const d = (raw ?? {}) as Record<string, unknown>
  return {
    interrupt_mode: INTERRUPT_MODES.includes(d.interrupt_mode as AgentInterruptMode)
      ? (d.interrupt_mode as AgentInterruptMode)
      : DEFAULT_AGENT_SETTINGS.interrupt_mode,
    persona: PERSONA_MODES.includes(d.persona as AgentPersonaMode)
      ? (d.persona as AgentPersonaMode)
      : DEFAULT_AGENT_SETTINGS.persona,
    cost_mode: COST_MODES.includes(d.cost_mode as AgentCostMode)
      ? (d.cost_mode as AgentCostMode)
      : DEFAULT_AGENT_SETTINGS.cost_mode,
    interaction_mode: INTERACTION_MODES.includes(d.interaction_mode as AgentInteractionMode)
      ? (d.interaction_mode as AgentInteractionMode)
      : DEFAULT_AGENT_SETTINGS.interaction_mode,
    // beast_mode：布尔白名单（=== true 才为 ON，其余脏数据一律默认 OFF）。
    beast_mode: d.beast_mode === true,
    memory_use: d.memory_use !== false,
    memory_generate: d.memory_generate !== false,
  }
}

/** 读本地设定缓存（无缓存 / 脏数据 / 读取抛错都回默认值）。 */
export function readCachedAgentSettings(): AgentSettings {
  try {
    const raw: unknown = Taro.getStorageSync(`${AGENT_SETTINGS_STORAGE_KEY}:${getUserId() ?? "guest"}`)
    if (raw == null || raw === '') return { ...DEFAULT_AGENT_SETTINGS }
    if (typeof raw === 'string') {
      try {
        return sanitizeAgentSettings(JSON.parse(raw))
      } catch {
        return { ...DEFAULT_AGENT_SETTINGS }
      }
    }
    // 旧版小程序直接存对象；仍然走同一套白名单。
    return sanitizeAgentSettings(raw)
  } catch {
    return { ...DEFAULT_AGENT_SETTINGS }
  }
}

/** 只写本地缓存（不触网）；隐私模式写失败只影响下次冷启动。 */
export function writeCachedAgentSettings(settings: AgentSettings): void {
  try {
    Taro.setStorageSync(`${AGENT_SETTINGS_STORAGE_KEY}:${getUserId() ?? "guest"}`, JSON.stringify(sanitizeAgentSettings(settings)))
  } catch {
    // 不挡聊天。
  }
}

/** 与网页版同源：失败不能伪装成默认设置，保存只发实际改动栏位。 */
export type AgentSettingsResult =
  | { ok: true; settings: AgentSettings }
  | { ok: false; message: string }

export async function getAgentSettings(): Promise<AgentSettingsResult> {
  try {
    const data = await request<unknown>({ path: '/api/agent/settings' })
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, message: '设置读取失败' }
    return { ok: true, settings: sanitizeAgentSettings(data) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '设置读取失败' }
  }
}

export async function saveAgentSettings(patch: Partial<AgentSettings>): Promise<AgentSettingsResult> {
  const full = sanitizeAgentSettings(patch)
  const clean: Partial<AgentSettings> = {}
  for (const key of Object.keys(patch) as (keyof AgentSettings)[]) {
    if (!(key in full) || patch[key] === undefined) continue
    if (typeof full[key] === 'boolean' ? typeof patch[key] !== 'boolean' : full[key] !== patch[key]) continue
    ;(clean as Record<string, unknown>)[key] = full[key]
  }
  if (!Object.keys(clean).length) return { ok: false, message: '设置无效，未保存' }
  const owner = getUserId()
  const before = readCachedAgentSettings()
  writeCachedAgentSettings({ ...before, ...clean })
  try {
    const data = await request<unknown>({ path: '/api/agent/settings', method: 'POST', data: clean })
    const merged = sanitizeAgentSettings({ ...before, ...(data as object), ...clean })
    writeCachedAgentSettings(merged)
    return { ok: true, settings: merged }
  } catch (error) {
    if (getUserId() === owner) writeCachedAgentSettings(before)
    return { ok: false, message: error instanceof Error ? error.message : '保存失败' }
  }
}

export function serverAgentThinkingLevel(settings: AgentSettings): AgentThinkingLevel {
  const exact = inferAgentThinkingLevel(settings)
  if (exact) return exact
  if (settings.beast_mode) return 'extreme'
  if (settings.persona === 'thoughtful') return 'high'
  if (settings.cost_mode === 'economy') return 'low'
  return 'medium'
}

/** 级别 → 写入 AgentSettings 的 patch（经 saveAgentSettings 既有链路落地）。 */
export function agentThinkingLevelPatch(level: AgentThinkingLevel): Partial<AgentSettings> {
  return { ...AGENT_THINKING_LEVEL_SETTINGS[level] }
}

/** 由 settings 反推级别：mapping 覆盖不到的组合（如 premium + efficient）回 null。 */
export function inferAgentThinkingLevel(settings: AgentSettings): AgentThinkingLevel | null {
  for (const level of AGENT_THINKING_LEVELS) {
    const spec = AGENT_THINKING_LEVEL_SETTINGS[level]
    if (
      settings.persona === spec.persona &&
      settings.cost_mode === spec.cost_mode &&
      settings.beast_mode === spec.beast_mode
    ) {
      return level
    }
  }
  return null
}

/** 读取显式保存的思考级别（无记录 / 脏数据 → null）。 */
export function readCachedAgentThinkingLevel(): AgentThinkingLevel | null {
  try {
    const raw: unknown = Taro.getStorageSync(`${AGENT_THINKING_LEVEL_STORAGE_KEY}:${getUserId() ?? "guest"}`)
    return typeof raw === 'string' && (AGENT_THINKING_LEVELS as readonly string[]).includes(raw)
      ? (raw as AgentThinkingLevel)
      : null
  } catch {
    return null
  }
}

/** 只写本地缓存（不触网）：改档立即生效，跨重载保留。 */
export function writeCachedAgentThinkingLevel(level: AgentThinkingLevel): void {
  try {
    Taro.setStorageSync(`${AGENT_THINKING_LEVEL_STORAGE_KEY}:${getUserId() ?? "guest"}`, level)
  } catch {
    // 不挡聊天。
  }
}

/**
 * 解析要显示的思考级别：显式记录优先；无记录才由 settings 反推；反推不到显示「中」。
 * 纯读取——反推不到时绝不改写用户的 settings。
 */
export function resolveAgentThinkingLevel(settings: AgentSettings): AgentThinkingLevel {
  return readCachedAgentThinkingLevel() ?? inferAgentThinkingLevel(settings) ?? 'medium'
}
