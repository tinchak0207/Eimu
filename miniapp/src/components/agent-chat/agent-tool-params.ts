/**
 * D-19 参数解析。逐行复制自 src/lib/agent-tool-params.ts（本页只用于锚定卡
 * 念回参数，故裁掉 ParamTier 之外未用到的分级展示字段，解析规则一字不动）。
 */

export interface AgentParam {
  key: string
  label: string
  value: string
}

export interface ParsedToolParams {
  params: AgentParam[]
  raw: string
  truncated: boolean
}

/** 常用层：顺序即展示顺序（agent-tool-params.ts:39-47）。 */
const COMMON: Record<string, string> = {
  prompt: '画面描述',
  model: '模型',
  size: '尺寸',
  aspect_ratio: '比例',
  n: '张数',
  count: '张数',
  quality: '画质',
}

/** 进阶层（:50-66）。 */
const ADVANCED: Record<string, string> = {
  negative_prompt: '负面描述',
  lora: 'LoRA',
  lora_id: 'LoRA',
  lora_weight: 'LoRA 权重',
  weight: '权重',
  sampler: '采样器',
  sampling_method: '采样器',
  steps: '步数',
  cfg: 'CFG',
  cfg_scale: 'CFG',
  seed: '随机种子',
  scale: '放大倍率',
  media_id: '来源图',
  mediaId: '来源图',
  response_format: '返回格式',
  task_id: '任务号',
}

const COMMON_ORDER = Object.keys(COMMON)
const ADVANCED_ORDER = Object.keys(ADVANCED)

function stringifyValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'boolean') return value ? '开' : '关'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function classify(key: string): { label: string; tier: 'common' | 'advanced' } {
  if (key in COMMON) return { label: COMMON[key], tier: 'common' }
  if (key in ADVANCED) return { label: ADVANCED[key], tier: 'advanced' }
  return { label: key, tier: 'advanced' }
}

function orderIndex(key: string, tier: 'common' | 'advanced'): number {
  const list = tier === 'common' ? COMMON_ORDER : ADVANCED_ORDER
  const index = list.indexOf(key)
  return index === -1 ? list.length : index
}

function toParams(entries: Array<[string, unknown]>): AgentParam[] {
  const seen = new Set<string>()
  const out: AgentParam[] = []
  for (const [key, value] of entries) {
    const text = stringifyValue(value).trim()
    if (!text) continue
    const { label, tier } = classify(key)
    // 同义键（n/count、lora/lora_id）只留第一个（:124-128）。
    if (seen.has(label)) continue
    seen.add(label)
    out.push({ key, label, value: text })
  }
  return out.sort((a, b) => {
    const tierA = classify(a.key).tier
    const tierB = classify(b.key).tier
    if (tierA !== tierB) return tierA === 'common' ? -1 : 1
    return orderIndex(a.key, tierA) - orderIndex(b.key, tierB)
  })
}

function looksTruncated(raw: string): boolean {
  if (/(\.\.\.|…)\s*$/.test(raw)) return true
  const opens = (raw.match(/[{[]/g) ?? []).length
  const closes = (raw.match(/[}\]]/g) ?? []).length
  return opens > closes
}

function salvagePairs(raw: string): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = []
  const re = /"?([A-Za-z_][A-Za-z0-9_]*)"?\s*[:=]\s*("(?:[^"\\]|\\.)*"|[^,;\n}]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    const key = match[1]
    let value = match[2].trim().replace(/,$/, '')
    if (value.startsWith('"')) {
      const candidate = value.endsWith('"') && value.length > 1 ? value : `${value}"`
      try {
        value = JSON.parse(candidate) as string
      } catch {
        value = value.slice(1)
      }
    }
    out.push([key, value])
  }
  return out
}

/** 把 args_summary 解析成参数（agent-tool-params.ts:168-195）。 */
export function parseToolParams(argsSummary: string | undefined): ParsedToolParams | null {
  if (argsSummary === undefined) return null
  const raw = argsSummary.trim()
  if (!raw) return null
  const truncated = looksTruncated(raw)
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { params: toParams(Object.entries(parsed as Record<string, unknown>)), raw, truncated }
    }
  } catch {
    // 落到捞取分支
  }
  const salvaged = salvagePairs(raw)
  if (salvaged.length === 0) return { params: [], raw, truncated }
  return { params: toParams(salvaged), raw, truncated }
}
