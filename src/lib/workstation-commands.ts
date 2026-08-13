export type WorkstationCommandId =
  | "run"
  | "focus_prompt"
  | "open_lora"
  | "open_queue"
  | "open_gallery"
  | "reuse_result"
  | "download_result"
  | "prev_result"
  | "next_result"
  | "undo_annotation"
  | "show_commands"
  | "close_overlay";

export interface WorkstationCommandDefinition {
  id: WorkstationCommandId;
  label: string;
  shortcut: string;
  description: string;
}

export const WORKSTATION_COMMANDS: readonly WorkstationCommandDefinition[] = [
  { id: "run", label: "开始生成", shortcut: "Ctrl/⌘ + Enter", description: "提交当前创作配置" },
  { id: "focus_prompt", label: "聚焦提示词", shortcut: "/", description: "回到创作并定位提示词" },
  { id: "open_lora", label: "打开 LoRA", shortcut: "L", description: "打开参数中的 LoRA 资源库" },
  { id: "open_queue", label: "查看任务", shortcut: "Q", description: "打开任务队列与错误状态" },
  { id: "open_gallery", label: "查看成片", shortcut: "G", description: "打开成片库" },
  { id: "reuse_result", label: "复用当前结果", shortcut: "R", description: "把当前结果放入参考图" },
  { id: "download_result", label: "下载当前成片", shortcut: "D", description: "把画布上这张存到本地" },
  { id: "prev_result", label: "上一张", shortcut: "←", description: "在成片之间向前切换" },
  { id: "next_result", label: "下一张", shortcut: "→", description: "在成片之间向后切换" },
  { id: "undo_annotation", label: "撤销标注", shortcut: "Ctrl/⌘ + Z", description: "撤销画布上最后一笔标注" },
  { id: "show_commands", label: "快捷键", shortcut: "?", description: "查看全部工作台命令" },
  { id: "close_overlay", label: "关闭浮层", shortcut: "Esc", description: "关闭全屏、快捷键面板或下拉菜单" },
];

export interface WorkstationKeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  composing?: boolean;
  editable?: boolean;
  modalOpen?: boolean;
}

export function workstationCommandForKey(input: WorkstationKeyInput): WorkstationCommandId | null {
  if (input.defaultPrevented || input.repeat || input.composing) return null;
  const key = input.key.toLowerCase();
  if (key === "escape") return "close_overlay";
  if (input.modalOpen) return null;

  const primaryModifier = Boolean(input.ctrlKey || input.metaKey);
  if (primaryModifier && key === "enter" && !input.altKey) return "run";
  // 标注撤销只在焦点不在输入框时接管：输入框里的 Ctrl+Z 必须留给原生文本撤销，
  // 否则用户改提示词时按撤销，改动没退回、反而擦掉了画布上的标注。
  if (primaryModifier && key === "z" && !input.altKey && !input.shiftKey && !input.editable) {
    return "undo_annotation";
  }
  if (input.editable || primaryModifier || input.altKey) return null;

  if (key === "?" || (key === "/" && input.shiftKey)) return "show_commands";
  if (key === "/") return "focus_prompt";
  if (key === "l") return "open_lora";
  if (key === "q") return "open_queue";
  if (key === "g") return "open_gallery";
  if (key === "r") return "reuse_result";
  if (key === "d") return "download_result";
  // 挑片是左右快速扫的动作：一次生成 4-8 张，方向键必须能在成片之间移动，
  // 否则每比较两张就要「切成片墙 → 命中缩图 → 回画布」四次点击。
  if (key === "arrowleft") return "prev_result";
  if (key === "arrowright") return "next_result";
  return null;
}

export function isWorkstationEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable="true"]')) return true;
  return target.matches("input, textarea, select");
}
