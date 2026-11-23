import { useCallback, useRef, useState } from 'react'
import { Text, Textarea, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { cn } from '../../lib/cn'
import { Icon } from './icons'
import {
  SkillSlashMenu,
  shouldOpenSlashMenu,
  slashQueryOf,
  type SlashMenuSkill,
} from './SkillSlashMenu'
import { ThinkingLevelMenu } from './AgentComposer.menus'
import { LocalFileModeHint } from './AgentComposer.local-file-mode'
import { useComposerAttachments } from './AgentComposer.attachments'
import { useComposerSendPipeline } from './AgentComposer.send-pipeline'
import { useComposerInteraction } from './AgentComposer.interaction'
import { resolveMiniappPlaceholder } from './AgentComposer.placeholder'
import { MAX_COMPOSER_CHARS } from './AgentComposer.upload-limits'
import type { AgentComposerProps } from './AgentComposer.types'

/**
 * 输入卡（小程序版）。结构与类名逐行照 src/components/agent-chat/AgentComposer.tsx：
 *   - 外框      :507-526   agent-composer agent-composer-shell lg-float rounded-[24px] …
 *   - 附件 chips :556-628
 *   - 输入      :705-731   textarea 字级/内距/placeholder
 *   - 斜线菜单   :731-741   SkillSlashMenu（absolute bottom-full）
 *   - 工具行    :751-860   「+」/ 语言 / 思考级别 / 桌面版提示 / 停止·发送
 *
 * 拆档对应关系：
 *   AgentComposer.menus.tsx           思考级别（网页 ThinkingLevelMenu）
 *   AgentComposer.local-file-mode.tsx 桌面专属入口（置灰）
 *   AgentComposer.attachments.ts      附件 chips / 上传 / 纯函数
 *   AgentComposer.send-pipeline.ts    预检 + 送出锁 + 硬保险
 *   AgentComposer.interaction.ts      斜线选中 + 中断模式（steer）
 *   AgentComposer.placeholder.ts      placeholder 决策
 *   AgentComposer.types.ts            props 与附件型别
 */

function readWindowWidth(): number {
  try {
    const info =
      typeof Taro.getWindowInfo === 'function' ? Taro.getWindowInfo() : Taro.getSystemInfoSync()
    return Number(info?.windowWidth ?? 0)
  } catch {
    return 0
  }
}

export function AgentComposer({
  value,
  onChange,
  onSend,
  onStop,
  turnActive,
  sending,
  stopPending = false,
  disabled = false,
  thinkingLevel,
  onThinkingLevelChange,
  sessionId,
  onEnsureSession,
  onSendText,
  externalSendPending = false,
}: AgentComposerProps) {
  /** 打「/」直呼 Skill：slashArmed＝使用者真的打出那一颗「/」的动作。 */
  const [slashArmed, setSlashArmed] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const slashSkillsRef = useRef<SlashMenuSkill[]>([])
  /** 选中技能后把焦点还给输入框（原生键盘继续弹出）。 */
  const [inputFocused, setInputFocused] = useState(false)
  const [placeholder] = useState(() => resolveMiniappPlaceholder(readWindowWidth()))

  const shellClass = 'agent-composer agent-composer-shell lg-float relative flex cursor-text flex-col rounded-[24px] px-2 pb-1.5 pt-2'
  const externalSending = sending || externalSendPending
  const trimmed = value.trim()
  const slashQuery = slashQueryOf(value)
  const slashMenuOpen = slashArmed && shouldOpenSlashMenu(value)
  const canAttach = !disabled

  const {
    attachments,
    pickMedia,
    removeAttachment,
    cancelAttachment,
    retryAttachment,
    removeAttachments,
  } = useComposerAttachments({ disabled, sessionId, onEnsureSession })

  const { canSend, busy, sendError, handleSend } = useComposerSendPipeline({
    trimmed,
    attachments,
    externalSending,
    disabled,
    onSend,
    onSendText,
    onChange,
    onSent: removeAttachments,
  })

  const { handleSlashPick, handleSlashSkills, handleKeyboardConfirm, steerActive } =
    useComposerInteraction({
      text: value,
      setText: onChange,
      setSlashArmed,
      setSlashIndex,
      slashSkillsRef,
      slashMenuOpen,
      slashIndex,
      requestFocus: () => setInputFocused(true),
    })

  /** 输入框变化：只在「刚打进 /」的当下开菜单（选完技能接着打需求不再弹）。 */
  const handleInput = useCallback(
    (next: string) => {
      setSlashArmed(next.startsWith('/') && !value.startsWith('/'))
      if (next.startsWith('/')) setSlashIndex(0)
      onChange(next)
    },
    [onChange, value],
  )

  const confirm = useCallback(() => {
    setInputFocused(false)
    handleKeyboardConfirm(handleSend)
  }, [handleKeyboardConfirm, handleSend])

  // 停止钮：与网页版同条件（AgentComposer.tsx:313）——投递在途（busy）仍显示「送出转圈钮」，
  // 回合中且输入框为空才落红方块；不能用在途盖掉送出钮。
  const stopVisible = !busy && turnActive && !canSend

  return (
    <View className={shellClass}>
      {/* 顶缘 specular 亮线（AgentComposer.tsx:530-533） */}
      <View className='pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80' />

      <View className='flex min-w-0 flex-col px-1'>
        {/* 待发送附件 chip 行：上传中 / 成功 / 错误 三态都带移除按钮。 */}
        {attachments.length > 0 ? (
          <View className='mb-1 flex flex-wrap gap-1.5'>
            {attachments.map((att) => {
              const inFlight = att.status === 'uploading'
              return (
                <View
                  key={att.id}
                  className={cn(
                    'inline-flex max-w-[14rem] items-center gap-1.5 rounded-full px-2.5 py-1 text-ios-caption1',
                    att.status === 'error' && 'bg-destructive/10 text-destructive',
                    att.status === 'ready' && 'bg-ios-blue/10 text-muted-foreground',
                    inFlight && 'bg-black/5 text-foreground/45',
                  )}
                >
                  {inFlight ? <Icon name='loader-2-a45' className='ic-spin h-3 w-3 shrink-0' /> : null}
                  <Text className='min-w-0 flex-1 truncate'>
                    {att.status === 'error' && att.errorMessage
                      ? `${att.fileName}：${att.errorMessage}`
                      : att.fileName}
                  </Text>
                  {inFlight ? (
                    <Text
                      className='shrink-0 rounded-full px-1.5 py-0.5 font-medium text-foreground/60'
                      onClick={() => cancelAttachment(att.id)}
                    >
                      取消
                    </Text>
                  ) : null}
                  {att.status === 'error' && att.file ? (
                    <Text
                      className='shrink-0 rounded-full px-1.5 py-0.5 font-medium text-ios-blue'
                      onClick={() => retryAttachment(att.id)}
                    >
                      重试
                    </Text>
                  ) : null}
                  <View className='shrink-0 rounded-full p-2 text-current' onClick={() => removeAttachment(att.id)}>
                    <Icon name='x-a45' className='h-3.5 w-3.5' />
                  </View>
                </View>
              )
            })}
          </View>
        ) : null}

        <Textarea
          id='agent-composer-input'
          value={value}
          onInput={(event) => handleInput(event.detail.value)}
          onConfirm={confirm}
          onBlur={() => setInputFocused(false)}
          focus={inputFocused}
          confirmType='send'
          cursorSpacing={24}
          maxlength={MAX_COMPOSER_CHARS}
          autoHeight
          disabled={disabled}
          placeholder={placeholder}
          placeholderClass='text-foreground/35'
          className='block min-h-[1.875rem] max-h-[15rem] w-full bg-transparent px-1.5 pb-1 pt-1 text-[1.0625rem] leading-[1.375rem] text-foreground'
          style={{ minHeight: '1.875rem', maxHeight: '15rem' }}
        />

        {/* 管线自己的失败/超时文案（超长、发送超时）；父层错误横幅之外的另一条兜底。 */}
        {sendError ? (
          <Text className='block px-1.5 pb-0.5 text-ios-caption1 leading-snug text-ios-red'>
            {sendError}
          </Text>
        ) : null}
      </View>

      {/* 打「/」直呼技能：贴在输入卡正上方（自身 absolute bottom-full，零 layout shift）。 */}
      {slashMenuOpen ? (
        <SkillSlashMenu
          query={slashQuery}
          activeIndex={slashIndex}
          onActiveIndexChange={setSlashIndex}
          onPick={handleSlashPick}
          onClose={() => setSlashArmed(false)}
          onSkillsChange={handleSlashSkills}
        />
      ) : null}

      {/* 工具行：素材「+」/ 思考级别（带下拉）/ 桌面版提示（左）｜停止或发送（右）。 */}
      <View className='agent-composer-toolbar flex items-center justify-between gap-1'>
        <View className='flex min-w-0 flex-1 items-center'>
          <View className='relative shrink-0'>
            <View
              className={cn(
                // 网页版窄屏补 44px 触控区（max-sm:h-11 w-11，AgentComposer.tsx:298）；小程序常驻窄屏。
                'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground/50',
                !canAttach && 'opacity-25',
              )}
              onClick={() => {
                if (canAttach) pickMedia()
              }}
            >
              <Icon name='plus-a50' className='h-5 w-5' />
            </View>
          </View>

          {/* 语言不再单独占一颗硬编码「中」：思考级别自带下拉且同样显示当前档位，
              两颗「中」并排会被误读成两个语言控件。 */}
          <ThinkingLevelMenu
            level={thinkingLevel}
            onChange={onThinkingLevelChange}
            disabled={disabled}
          />

          {/* 本机文件模式（桌面专属）：保留入口与提示文案，整颗置灰。 */}
          <LocalFileModeHint />
        </View>

        {stopVisible ? (
          <View
            className={cn(
              // 红方块：lucide Square（空心描边）h-3.5、44×44 隐形触控圆（网页版 :325-342）。
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ios-red',
              stopPending && 'opacity-60',
            )}
            onClick={() => {
              if (!stopPending) onStop()
            }}
          >
            {stopPending ? (
              <Icon name='loader-2-red' className='ic-spin h-3.5 w-3.5' />
            ) : (
              <Icon name='square-red' className='h-3.5 w-3.5' />
            )}
          </View>
        ) : (
          <View
            className={cn(
              // 在途＝送出转圈（实色）；仅空闲且不可送时褪色（网页版 disabled:opacity-40 saturate-[0.7]）。
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
              !busy && (disabled || !canSend) && 'opacity-40 saturate-[0.7]',
            )}
            onClick={() => {
              if (disabled || busy) return
              handleSend()
            }}
          >
            {busy ? (
              <Icon name='loader-2-lav' className='ic-spin h-4 w-4' />
            ) : steerActive && turnActive && canSend ? (
              <Icon name='navigation-lav' className='h-4 w-4' />
            ) : (
              <Icon name='arrow-up-lav' className='h-[22px] w-[22px]' />
            )}
          </View>
        )}
      </View>
    </View>
  )
}

export { COMPACT_PLACEHOLDER, DEFAULT_PLACEHOLDER, TOUCH_PLACEHOLDER } from './AgentComposer.placeholder'
