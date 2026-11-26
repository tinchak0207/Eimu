import { useRef, useState } from 'react'
import { Text, Textarea, View } from '@tarojs/components'
import { cn } from '../../lib/cn'
import { Icon } from './icons'
import type { AgentPendingQuestion } from './types'

/**
 * 问答卡。结构 / 类名逐行复制自
 * src/components/agent-chat/AgentQuestionCard.tsx：
 *   - 无选项的「确认式」分支 :94-149
 *   - 选项清单 / 其他… 自由输入 :175-297
 *   - OPTION_ROW_CLASS :40-46、PRIMARY/GHOST_BUTTON_CLASS :52-66、INPUT_CLASS（MySkillsDialog.tsx:229-230）
 * 平台差异（白名单）：textarea → Taro Textarea（value/onInput）；window.setTimeout → setTimeout。
 */

const OPTION_ROW_CLASS = cn(
  'flex min-h-12 w-full items-center gap-2.5 rounded-[12px] px-3 py-2.5 text-left',
  'transition-colors duration-150',
)

const PRIMARY_BUTTON_CLASS = cn(
  'flex min-h-11 items-center justify-center gap-1.5 rounded-full bg-[#2d3142] px-5 text-ios-footnote font-medium text-white',
  'shadow-[0_8px_20px_rgba(45,49,66,0.18)] transition-all duration-200',
)

const GHOST_BUTTON_CLASS = cn(
  'flex min-h-11 items-center justify-center gap-1.5 rounded-full px-4 text-ios-footnote font-medium',
  'text-muted-foreground transition-all duration-200',
)

const INPUT_CLASS =
  'w-full rounded-lg border border-input bg-black/5 px-2.5 py-1.5 text-ios-caption1 outline-none transition-colors'

export interface AgentQuestionCardProps {
  question: AgentPendingQuestion
  /** 选中的标签，依题目顺序组成 string[][]，对齐 opencode /question/{que_*}/reply。 */
  onAnswer: (requestId: string, answers: string[][]) => Promise<boolean | void>
}

/** 提交一次答案（AgentQuestionCard.tsx:21-33）。 */
async function submitQuestionAnswer(
  onAnswer: AgentQuestionCardProps['onAnswer'],
  requestId: string,
  answers: string[][],
  setBusy: (value: boolean) => void,
): Promise<void> {
  try {
    const ok = await onAnswer(requestId, answers)
    if (ok === false) setBusy(false)
  } catch {
    setBusy(false)
  }
}

export function AgentQuestionCard({ question, onAnswer }: AgentQuestionCardProps) {
  const { requestId, questions } = question
  const [current, setCurrent] = useState(0)
  const [busy, setBusy] = useState(false)
  // 被点中的选项：那颗按钮转圈 + 高亮（:71-73）。
  const [pickedLabel, setPickedLabel] = useState<string | null>(null)
  // 每题已选的答案（本地暂存）：最后一题点完才一次提交完整 answers（:74-76）。
  const picksRef = useRef<string[]>([])
  // 罪状 5：选项之外的自由输入口（:77-81）。
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherText, setOtherText] = useState('')

  const item = questions[current]
  if (!item) return null

  // 模型偶尔不给 options：渲染成「确认式」卡（:90-149）。
  const noOptions = item.options.length === 0
  if (noOptions) {
    return (
      <View className='agent-rise lg-sheet relative overflow-hidden rounded-[20px] p-4'>
        <View className='pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80' />
        <View className='flex items-start gap-3'>
          <View className='flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ios-blue/[0.12] text-ios-blue'>
            <Icon name='help-circle-blue' className='h-4 w-4' />
          </View>
          <View className='min-w-0 flex-1'>
            {item.header ? (
              <Text className='text-ios-footnote font-medium text-muted-foreground'>{item.header}</Text>
            ) : null}
            <Text className='text-ios-subhead font-semibold leading-[1.5] break-words text-foreground'>
              {item.question}
            </Text>
          </View>
        </View>
        <View className='mt-3 grid grid-cols-2 gap-2.5'>
          <View
            className={cn(GHOST_BUTTON_CLASS, busy && 'opacity-50')}
            onClick={() => {
              if (busy) return
              setBusy(true)
              void submitQuestionAnswer(onAnswer, requestId, questions.map(() => []), setBusy)
            }}
          >
            <Text>重新说明</Text>
          </View>
          <View
            className={cn(PRIMARY_BUTTON_CLASS, busy && 'bg-[#2d3142]/60')}
            onClick={() => {
              if (busy) return
              setBusy(true)
              void submitQuestionAnswer(
                onAnswer,
                requestId,
                questions.map((q) => [q.question]),
                setBusy,
              )
            }}
          >
            {busy ? <Icon name='loader-2-white' className='ic-spin h-4 w-4' /> : null}
            <Text>明白，继续</Text>
          </View>
        </View>
      </View>
    )
  }

  const pick = async (label: string): Promise<void> => {
    if (busy) return
    picksRef.current[current] = label
    setPickedLabel(label)
    setBusy(true)
    if (current < questions.length - 1) {
      // 还有下一题：短暂回馈后切到下一题（:156-166）。
      setTimeout(() => {
        setCurrent((value) => value + 1)
        setPickedLabel(null)
        setBusy(false)
        setOtherOpen(false)
        setOtherText('')
      }, 250)
      return
    }
    // 最后一题：提交全部题目的答案（:168-172）。
    const answers = questions.map((_, index) => (picksRef.current[index] ? [picksRef.current[index]] : []))
    await submitQuestionAnswer(onAnswer, requestId, answers, setBusy)
  }

  return (
    <View className='agent-rise lg-sheet relative overflow-hidden rounded-[20px] p-4'>
      <View className='pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80' />
      <View key={`${requestId}-${current}`}>
        <View className='flex items-start gap-3'>
          <View className='flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ios-blue/[0.12] text-ios-blue'>
            <Icon name='help-circle-blue' className='h-4 w-4' />
          </View>
          <View className='min-w-0 flex-1'>
            {item.header ? (
              <Text className='text-ios-footnote font-medium text-muted-foreground'>{item.header}</Text>
            ) : null}
            <Text className='text-ios-subhead font-semibold leading-[1.5] break-words text-foreground'>
              {item.question}
            </Text>
            {questions.length > 1 ? (
              <Text className='mt-0.5 text-ios-footnote text-muted-foreground'>
                {current + 1} / {questions.length}
              </Text>
            ) : null}
          </View>
        </View>
        <View className='mt-3 flex flex-col gap-2'>
          {item.options.map((option) => {
            const isPicked = pickedLabel === option.label
            return (
              <View
                key={option.label}
                className={cn(OPTION_ROW_CLASS, isPicked && 'bg-ios-blue/[0.10] ring-1 ring-ios-blue/35', busy && 'opacity-60')}
                onClick={() => void pick(option.label)}
              >
                <View className='min-w-0 flex-1'>
                  <Text className='block break-words text-ios-subhead font-semibold text-foreground'>
                    {option.label}
                  </Text>
                  {option.description ? (
                    <Text className='mt-0.5 block break-words text-sm leading-[1.5] text-foreground/60'>
                      {option.description}
                    </Text>
                  ) : null}
                </View>
                {isPicked ? <Icon name='loader-2-blue' className='ic-spin h-4 w-4 shrink-0' /> : null}
              </View>
            )
          })}
          {/* 其他…：收起时与选项同款；展开后输入框 + 提交（:240-294）。 */}
          {otherOpen ? (
            <View className='rounded-[12px] bg-black/[0.03] p-2.5'>
              <Textarea
                value={otherText}
                onInput={(event) => setOtherText(event.detail.value)}
                disabled={busy}
                maxlength={2000}
                placeholder='输入你的答案…'
                aria-label='其他答案'
                className={cn(INPUT_CLASS, 'min-h-0 resize-none text-ios-footnote leading-[1.5]')}
              />
              <View className='mt-2 flex items-center justify-end gap-2'>
                <View
                  className={cn(GHOST_BUTTON_CLASS, busy && 'opacity-50')}
                  onClick={() => {
                    setOtherOpen(false)
                    setOtherText('')
                  }}
                >
                  <Text>取消</Text>
                </View>
                <View
                  className={cn(
                    PRIMARY_BUTTON_CLASS,
                    (busy || otherText.trim().length === 0) && 'bg-[#2d3142]/60',
                  )}
                  onClick={() => {
                    const text = otherText.trim()
                    if (!text || busy) return
                    void pick(text)
                  }}
                >
                  {busy ? <Icon name='loader-2-white' className='ic-spin h-3.5 w-3.5' /> : null}
                  <Text>提交</Text>
                </View>
              </View>
            </View>
          ) : (
            <View className={OPTION_ROW_CLASS} onClick={() => setOtherOpen(true)}>
              <Text className='min-w-0 flex-1 text-ios-subhead font-medium text-muted-foreground'>其他…</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  )
}
