import { useCallback, useRef, type MutableRefObject } from 'react'
import { readCachedAgentSettings } from '../../lib/agent'
import { applySkillPick, moveActiveIndex, type SlashMenuSkill } from './SkillSlashMenu'

/**
 * 输入交互钩子。网页版 AgentComposer.interaction.ts 的职责在本端裁到平台可用面：
 *   保留：斜线技能选中/列表上报、IME 安全的送出、键盘确认（onConfirm）；
 *   中断模式：读缓存 settings 的 interrupt_mode（steer/queue），决定回合中送出
 *     是「引导」（Navigation 图标）还是「排队」；
 *   删除（平台差异白名单）：拖拽（drag*）、Ctrl+V 粘贴、visualViewport 键盘规避
 *     —— 小程序没有这组 DOM 能力，输入框由原生键盘自行避让。
 */

export type InterruptMode = 'steer' | 'queue'

/**
 * 读本地设定缓存里的 interrupt_mode。真源＝lib/agent-settings.ts
 * （白名单校验 + 默认值），本层不再自己解析 storage，避免第二套语义。
 */
export function readCachedInterruptMode(): InterruptMode {
  return readCachedAgentSettings().interrupt_mode
}

interface ComposerInteractionOptions {
  /** 当前输入文本（受控）；选中技能时据此替换。 */
  text: string
  setText: (value: string) => void
  setSlashArmed: (armed: boolean) => void
  setSlashIndex: (index: number) => void
  slashSkillsRef: MutableRefObject<SlashMenuSkill[]>
  slashMenuOpen: boolean
  slashIndex: number
  requestFocus: () => void
}

export interface ComposerInteractionHandle {
  handleSlashPick: (skill: SlashMenuSkill) => void
  handleSlashSkills: (skills: SlashMenuSkill[]) => void
  /** 键盘「发送/完成」：菜单开着时选中当前项，否则交回调用端送出。 */
  handleKeyboardConfirm: (onSend: () => void) => void
  /** 回合中是否以 steer（引导）语义送出。 */
  steerActive: boolean
}

export function useComposerInteraction({
  text,
  setText,
  setSlashArmed,
  setSlashIndex,
  slashSkillsRef,
  slashMenuOpen,
  slashIndex,
  requestFocus,
}: ComposerInteractionOptions): ComposerInteractionHandle {
  // 受控组件没有函数式 setState：把最新文本镜像进 ref，选中时替换的是「此刻」的值。
  const textRef = useRef(text)
  textRef.current = text
  const slashIndexRef = useRef(slashIndex)
  slashIndexRef.current = slashIndex

  /**
   * 选中一条技能：只把「/技能名 」写回输入框——不自动送出（送出=立刻扣费，
   * 与 D-5 花钱前必交用户确认冲突）。
   */
  const handleSlashPick = useCallback(
    (skill: SlashMenuSkill) => {
      setText(applySkillPick(textRef.current, skill))
      setSlashArmed(false)
      setSlashIndex(0)
      requestFocus()
    },
    [requestFocus, setSlashArmed, setSlashIndex, setText],
  )

  /** 菜单上报可见列表（进 ref，不触渲染）。 */
  const handleSlashSkills = useCallback(
    (skills: SlashMenuSkill[]) => {
      slashSkillsRef.current = skills
    },
    [slashSkillsRef],
  )

  const handleKeyboardConfirm = useCallback(
    (onSend: () => void) => {
      if (slashMenuOpen) {
        // 选中 ≠ 送出：把技能名写回输入框就停手；没有可选项时也吞掉这次确认
        // （框里正打着一个指令，送出半截「/关键词」不是使用者要的）。
        const picked = slashSkillsRef.current[slashIndexRef.current]
        if (picked) handleSlashPick(picked)
        return
      }
      onSend()
    },
    [handleSlashPick, slashMenuOpen, slashSkillsRef],
  )

  // 每次渲染现读（Taro storage 同步、开销极小）：设定弹层改档后下一拍即生效。
  const steerActive = readCachedInterruptMode() === 'steer'

  return { handleSlashPick, handleSlashSkills, handleKeyboardConfirm, steerActive }
}

/** 纯函数转发：菜单点击/后续键盘扩展共用同一套回绕规则。 */
export function moveSlashIndex(index: number, delta: number, length: number): number {
  return moveActiveIndex(index, delta, length)
}
