"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { applySkillPick, moveActiveIndex, type SlashMenuSkill } from "./SkillSlashMenu";
import { autoGrow } from "./AgentComposer.attachments";
import type { PendingAttachment } from "./AgentComposer.types";

interface ComposerInteractionProps {
  composerRef: RefObject<HTMLDivElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  setText: Dispatch<SetStateAction<string>>;
  setSlashArmed: Dispatch<SetStateAction<boolean>>;
  setSlashIndex: Dispatch<SetStateAction<number>>;
  slashSkillsRef: RefObject<SlashMenuSkill[]>;
  slashMenuOpen: boolean;
  slashIndex: number;
  canSend: boolean;
  handleSend: () => void;
  disabled: boolean;
  enqueueFiles: (files: File[]) => Promise<void>;
  attachments: PendingAttachment[];
}

export function useComposerInteraction(P: ComposerInteractionProps): {
  handleSlashPick: (skill: SlashMenuSkill) => void;
  handleSlashSkills: (skills: SlashMenuSkill[]) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  handlePaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  dragActive: boolean;
  handleDragEnter: (event: DragEvent<HTMLDivElement>) => void;
  handleDragOver: (event: DragEvent<HTMLDivElement>) => void;
  handleDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  handleDrop: (event: DragEvent<HTMLDivElement>) => void;
  canAttach: boolean;
  videoPreviews: (PendingAttachment & { videoUrl: string })[];
} {
  /**
   * 移动端虚拟键盘规避。
   *
   * iOS 弹键盘时 window.innerHeight 不变，只有 visualViewport 缩小，
   * composer 所在的卡片是定高（AGENT_SURFACE_HEIGHT），系统自动滚页未必
   * 能把输入区完全抬出键盘——于是 composer 被盖住、看不到自己在打什么。
   * 这里监听 visualViewport 的 resize/scroll（弹键盘、滚页都会触发），
   * 量出 composer 底部相对键盘顶部的实际越界量，用 transform 抬到键盘上方；
   * 不假设窗口高度，也不依赖具体布局。桌面（fine pointer）完全不介入。
   */
  useEffect(() => {
    const el = P.composerRef.current;
    if (!el) return;
    if (window.matchMedia("(pointer: fine)").matches) return;
    const vv = window.visualViewport ?? null;
    const KEYBOARD_GAP = 8;
    const apply = () => {
      const rect = el.getBoundingClientRect();
      const offsetTop = vv ? vv.offsetTop : 0;
      const height = vv ? vv.height : window.innerHeight;
      // composer 底部在可视区里比键盘顶（= 可视区底）低多少。
      const overlap = rect.bottom - offsetTop - height + KEYBOARD_GAP;
      if (overlap > 4) {
        el.style.transform = "translateY(" + -overlap + "px)";
        el.style.transition = window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "none"
          : "transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)";
      } else {
        el.style.transform = "";
        el.style.transition = "";
      }
    };
    if (vv) {
      vv.addEventListener("resize", apply);
      vv.addEventListener("scroll", apply);
    }
    window.addEventListener("resize", apply);
    apply();
    return () => {
      if (vv) {
        vv.removeEventListener("resize", apply);
        vv.removeEventListener("scroll", apply);
      }
      window.removeEventListener("resize", apply);
      el.style.transform = "";
      el.style.transition = "";
    };
  }, []);

  /**
   * 选中一条技能（点行，或菜单开着时的 Enter/Tab）：
   * **只把「/技能名 」写回输入框**——不自动送出（送出=立刻扣费，与 D-5 花钱前必
   * 交用户确认冲突）、不动附件、不改送出逻辑。焦点与高度回收照打字路径走，
   * 光标落到末尾＝使用者下一个动作就是接着打需求。
   */
  const handleSlashPick = useCallback((skill: SlashMenuSkill) => {
    P.setText((current) => applySkillPick(current, skill));
    P.setSlashArmed(false);
    P.setSlashIndex(0);
    requestAnimationFrame(() => {
      const el = P.textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      autoGrow(el);
    });
  }, []);

  /** 菜单上报可见列表（进 ref，不触渲染）。 */
  const handleSlashSkills = useCallback((skills: SlashMenuSkill[]) => {
    P.slashSkillsRef.current = skills;
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      /*
        打「/」直呼 Skill：菜单开着时上下键移动、Enter/Tab 选中、Esc 收起。
        只有菜单开着才走这一段；关着时下面每一行逐字不变（送出/换行/IME 契约不动）。
        IME 组字中的按键先让开：候选词要用上下键翻页、Enter 确认，不能被菜单吃掉。
      */
      if (P.slashMenuOpen) {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          P.setSlashIndex((index) => moveActiveIndex(index, delta, P.slashSkillsRef.current.length));
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          // 选中 ≠ 送出：把技能名写回输入框就停手。没有可选项时也吞掉这次 Enter
          // （框里正打着一个指令，送出半截「/关键词」不是使用者要的）。
          event.preventDefault();
          const picked = P.slashSkillsRef.current[P.slashIndex];
          if (picked) handleSlashPick(picked);
          return;
        }
        if (event.key === "Escape") {
          // 收起菜单：不送出、不清输入框（清掉等于吃掉使用者打的指令）。
          event.preventDefault();
          P.setSlashArmed(false);
          return;
        }
      }
      // Enter 发送，Shift+Enter 换行。
      if (event.key === "Enter" && !event.shiftKey) {
        // 输入法组字中的 Enter 属于输入法（确认候选词），不是送出指令。
        // 必须在 preventDefault 之前返回：对组字中的 Enter 调用 preventDefault
        // 会让部分浏览器吃不到候选词确认，变成「按了 Enter 字不见」。
        // keyCode 229 是旧式 IME 的残留判定（Android/部分输入法不补 isComposing）。
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        if (!P.canSend) return;
        P.handleSend();
      }
    },
    [P.canSend, P.handleSend, handleSlashPick, P.slashIndex, P.slashMenuOpen],
  );

  /** Ctrl+V 粘贴：有文件时走附件管道，纯文本/HTML 放行。 */
  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (P.disabled) return;
      const files = event.clipboardData?.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      void P.enqueueFiles(Array.from(files));
    },
    [P.disabled, P.enqueueFiles],
  );

  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (P.disabled) return;
      dragDepthRef.current += 1;
      setDragActive(true);
    },
    [P.disabled],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [],
  );

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepthRef.current -= 1;
      if (dragDepthRef.current <= 0) {
        dragDepthRef.current = 0;
        setDragActive(false);
      }
    },
    [],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      dragDepthRef.current = 0;
      setDragActive(false);
      const files = event.dataTransfer.files;
      if (files.length === 0) return;
      // 有文件进来必须先拦下浏览器的默认行为（否则会直接打开文件/跳页），
      // 再判断 disabled —— 禁用的输入区拖文件进来同样不能触发打开。
      event.preventDefault();
      if (P.disabled) return;
      void P.enqueueFiles(Array.from(files));
    },
    [P.disabled, P.enqueueFiles],
  );

  const canAttach = !P.disabled;
  // 有原片 Object URL 的影片就进预览区：直传成功（无 frames）与降级抽帧都适用。
  const videoPreviews = P.attachments.filter(
    (a): a is PendingAttachment & { videoUrl: string } => Boolean(a.videoUrl),
  );

  return {
    handleSlashPick,
    handleSlashSkills,
    handleKeyDown,
    handlePaste,
    dragActive,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    canAttach,
    videoPreviews,
  };
}
