/**
 * D-26 首张锚定。逐行复制自 src/lib/agent-batch-anchor.ts（行号见各段注释）。
 * 只引用事件流里真实出现过的参数（tool.invoke 的 args_summary）；凑不出就不给卡。
 */

import type { AgentItem } from './types'
import { parseToolParams, type AgentParam } from './agent-tool-params'

/** 锚定要念回给 agent 的参数键。顺序即念回顺序（:18-31）。 */
const ANCHOR_KEYS = [
  'model',
  'size',
  'aspect_ratio',
  'quality',
  'sampler',
  'sampling_method',
  'steps',
  'cfg',
  'cfg_scale',
  'seed',
  'lora',
  'lora_id',
  'lora_weight',
  'negative_prompt',
] as const

const ANCHOR_KEY_SET = new Set<string>(ANCHOR_KEYS)

export interface BatchAnchor {
  imageId: string
  seq: number
  params: AgentParam[]
  truncated: boolean
}

/** 从 transcript 找出「第一张图 + 生成它的那次工具调用参数」（:47-79）。 */
export function deriveBatchAnchor(items: readonly AgentItem[]): BatchAnchor | null {
  const imageIndex = items.findIndex((item) => item.kind === 'image')
  if (imageIndex === -1) return null
  const image = items[imageIndex]
  if (image.kind !== 'image') return null

  for (let i = imageIndex - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item.kind !== 'tool') continue
    const parsed = parseToolParams(item.argsSummary)
    if (!parsed) continue
    const params = parsed.params
      .filter((param) => ANCHOR_KEY_SET.has(param.key))
      .sort((a, b) => ANCHOR_KEYS.indexOf(a.key as never) - ANCHOR_KEYS.indexOf(b.key as never))
    if (params.length === 0) return null
    return { imageId: image.id, seq: image.seq, params, truncated: parsed.truncated }
  }
  return null
}

/** 锚定指令：参数原样念回（:86-94）。 */
export function buildAnchorMessage(anchor: BatchAnchor): string {
  const lines = anchor.params.map((param) => `- ${param.label}（${param.key}）：${param.value}`)
  return [
    `第 ${anchor.seq} 张就是我要的风格。接下来这一批都按它生成，以下参数不要改动：`,
    ...lines,
    '每张只改动必要的随机性，其余保持一致；如果某项参数无法沿用，先告诉我再继续。',
  ].join('\n')
}

/** 「换个风格重来」（:96-98）。 */
export function buildReanchorMessage(anchor: BatchAnchor): string {
  return `第 ${anchor.seq} 张不是我想要的风格。先只出 1 张换个方向给我看，满意了我再让你出整批。`
}

/** 批量意图的措辞（:101-102）。 */
const BATCH_INTENT_PATTERN = /(\d+\s*张|再来|一批|批量|多张|整批|每张|batch)/i

/** 锚定卡资格：会话里已有 ≥2 张图，或用户自己的消息带批量措辞（:104-116）。 */
export function shouldOfferBatchAnchor(items: readonly AgentItem[]): boolean {
  let imageCount = 0
  for (const item of items) {
    if (item.kind === 'image') {
      imageCount += 1
      if (imageCount >= 2) return true
    }
  }
  return items.some((item) => item.kind === 'user' && BATCH_INTENT_PATTERN.test(item.text))
}
