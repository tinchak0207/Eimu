import type { CharacterCardKind } from "@/lib/character-cards";

/** 上游可引用资源（由宿主从连线图算出）。 */
export interface CanvasReferenceCandidate {
  nodeId: string;
  title: string;
  previewUrl: string;
}

/** @ 可引用的素材卡候选（角色/场景/风格/道具）。 */
export interface CanvasEntityCandidate {
  cardId: string;
  name: string;
  kind: CharacterCardKind;
  /** 显示用种类字（＝CHARACTER_CARD_KIND_LABEL[kind]）。 */
  kindLabel: string;
  /** 预览缩图（卡的第一张参考图；无则空字串）。 */
  previewUrl: string;
}

export interface CanvasNodePromptPanelProps {
  nodeId: string;
  initialPrompt: string;
  initialModel?: string;
  initialSize?: string;
  initialCount?: number;
  isRunning: boolean;
  onClose: () => void;
  onGenerate: (nodeId: string, prompt: string, options: {
    model?: string;
    size?: string;
    quality?: string;
    count?: number;
  }) => void;
  /** 上游相连图片节点（@引用候选）；空阵列 = 不显示引用列。 */
  referenceCandidates?: CanvasReferenceCandidate[];
  /** 已选为参考图的节点 id。 */
  selectedReferenceIds?: string[];
  /** 切换某个引用的选取状态。 */
  onToggleReference?: (referenceNodeId: string) => void;
  /** @ 可引用的素材卡（第二组候选）。 */
  entityCandidates?: CanvasEntityCandidate[];
  /** 已被行内引用的卡 id（与 prompt 内 token 双向同步）。 */
  selectedEntityIds?: string[];
  /** 切换某张卡的引用状态（插入/移除对应 token chip）。 */
  onToggleEntity?: (cardId: string) => void;
  /** 本镜节点已指定的实体卡 id（真源＝节点 metadata 的三个卡 id 栏；供清单的 "shot" 来源）。 */
  shotEntityCardIds?: string[];
  /** 生成中点「停止」时回呼；未提供则 isRunning 只显示转圈段、不显示停止钮。 */
  onStop?: () => void;
  /** 开启提示词库；未提供则不渲染入口按钮。 */
  onOpenPromptLibrary?: () => void;
}
