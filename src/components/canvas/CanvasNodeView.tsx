"use client";

// 画布单一节点：拖动 / 缩放 / 依类型渲染内文。
// 萤幕位移 → 世界位移：dx / scale。
// 互动元素（按钮、缩放手柄、影片控制）带 data-canvas-interactive，让 InfiniteCanvas 平移忽略它们。
// 行动端：
//   - 内容卷动区（文本/配置长文）用 .canvas-node-scroll + touch-pan-y：可手指卷动，
//     点击仍选取节点，但不会误触拖动。
//   - 拖动有 5px 死区：轻点 = 选取，明确移动才开始拖节点，避免 tap 与拖动冲突。
//   - 删除按钮 / 缩放手柄在 <768px 放大到 ≥44px 触控热区。
//
// 2026-08-22 拆分（refactor Task 11）：类型/标签映射与缩放手柄 → node-view/constants；
// 三套指标手势（drag/resize/scrollDrag）→ node-view/use-node-gestures；
// 正文渲染（renderBody/renderPlaceholder + 图片三段链路）→ node-view/NodeBody。
// 本档保留节点壳：标题栏 / 状态徽章 / hover 工具列 / 提示词面板 / port / 缩放手柄绑定。
// props 显式转发给 NodeBody（46 个 props 介面债就地偿还，不引入 context——避免 memo 失效）。

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { X, RefreshCw, Edit2, ChevronDown, ChevronUp, Image as ImageIcon, Download, Wrench, ShieldCheck, Lightbulb, FileText, Type, User, Mountain, Boxes, Paperclip, AudioLines, Video as VideoIcon, SlidersHorizontal, Clapperboard } from "lucide-react";
import { CanvasNodeHoverToolbar } from "./CanvasNodeHoverToolbar";
import { CanvasNodePromptPanel } from "./CanvasNodePromptPanel";
import type { CanvasEntityCandidate } from "./CanvasNodePromptPanel";
import { cn } from "@/lib/utils";
import { CanvasNodeType, type CanvasNode, type CanvasNodeStatus } from "@/lib/canvas/types";
import { REFERENCE_IMAGE_ROLES } from "../../lib/reference-image-roles";
import { toReferenceImageRole } from "@/lib/image-types";
import type { ReferenceImageRole } from "@/lib/image-types";
import { STATUS_LABEL, TYPE_LABEL, RESIZE_HANDLES } from "./node-view/constants";
import { useNodeGestures } from "./node-view/use-node-gestures";
import { useStableHandlers } from "./embed/stable-handlers";
import { NodeBody } from "./node-view/NodeBody";
import type { StoryboardShotAudioMetadata } from "@/lib/canvas/storyboard-shots";
import { EntityThumbStack, entitiesInText } from "@/components/entities/entity-chip";
import type { CanvasLod } from "@/lib/canvas/lod";
import { inspectSections, type InspectInput } from "./node-view/node-inspect";
import { NodeInspectBody } from "./node-view/NodeInspectBody";

const NO_INPUTS: readonly InspectInput[] = [];

export interface CanvasNodeViewProps {
  node: CanvasNode;
  selected: boolean;
  onSelect: (nodeId: string) => void;
  /** 拖动真正开始（越过死区）时触发（供整合层推一格撤销快照） */
  onInteractionStart?: () => void;
  onMove: (nodeId: string, position: { x: number; y: number }) => void;
  onResize?: (nodeId: string, width: number, height: number) => void;
  onDelete?: (nodeId: string) => void;
  /** P1-1: 重新生成节点 */
  onRerun?: (nodeId: string) => void;
  /** P1-2: 编辑节点参数 */
  onEdit?: (nodeId: string, patch: Record<string, unknown>) => void;
  /** 当前缩放，拖动时要把萤幕位移换算成世界位移 */
  scale: number;
  /** 首次进场的延迟（ms）：同一批节点依序淡入，营造 agent 逐颗建构的节奏 */
  enterDelay?: number;
  /** 批次相关 */
  batchExpanded?: boolean;
  batchChildCount?: number;
  onToggleBatch?: (nodeId: string) => void;
  /** 编辑面板（prompt 面板） */
  onEditPrompt: (nodeId: string) => void;
  promptPanelOpen: boolean;
  onClosePromptPanel: () => void;
  onGenerateFromNode: (nodeId: string, prompt: string, options: { model?: string; size?: string; quality?: string; count?: number }) => void;
  isGenerating: boolean;
  /** hover 工具列 */
  onAddToAssetLibrary?: (nodeId: string) => void;
  onStartConnect?: (nodeId: string) => void;
  /** 图片动作（有 URL 的图片节点才由宿主传入） */
  onDownload?: (nodeId: string) => void;
  onEditImage?: (nodeId: string) => void;
  onUpscale?: (nodeId: string) => void;
  upscaling?: boolean;
  /** 影片节点动作（2026-09-28）：「截帧／序列帧」，宿主只在 https 影片节点上传入。 */
  onExtractVideoFrames?: (nodeId: string, action: "current" | "sequence", atSec?: number) => void;
  /** 取帧进行中（按钮停用防重复提交）。 */
  extractingVideoFrames?: boolean;
  /** 批次子节点：设为主图 */
  onSetPrimary?: (nodeId: string) => void;
  /** 批次父节点：下载全部子图（zip） */
  onDownloadAll?: (nodeId: string) => void;
  /** 收起态封面：主图子节点的图片 URL（宿主从 batchPrimaryImageId 解出） */
  batchPrimaryImageUrl?: string;
  /** 节点右键选单（座标 = viewport client 座标，由宿主转容器座标） */
  onNodeContextMenu?: (nodeId: string, clientX: number, clientY: number) => void;
  /** @引用（透传给内嵌 prompt 面板） */
  referenceCandidates?: { nodeId: string; title: string; previewUrl: string }[];
  selectedReferenceIds?: string[];
  onToggleReference?: (referenceNodeId: string) => void;
  /** 素材卡 @引用（透传给内嵌 prompt 面板；角色/场景/风格/道具卡） */
  entityCandidates?: CanvasEntityCandidate[];
  selectedEntityIds?: string[];
  onToggleEntity?: (cardId: string) => void;
  /** 本镜节点已指定的实体卡 id（透传给内嵌 prompt 面板；供清单的 "shot" 来源） */
  shotEntityCardIds?: string[];
  /** A1：port 拖线起点（节点左右缘圆点按下）。 */
  onStartPortDrag?: (nodeId: string, side: "left" | "right", clientX: number, clientY: number) => void;
  /** A7：hover 上报（宿主做邻接高亮）。 */
  onHoverChange?: (nodeId: string, hovered: boolean) => void;
  /** A7：与 hover/选中节点相邻 → 淡蓝 ring。 */
  adjacent?: boolean;
  /** A10：标题就地重命名（双击标题触发）。 */
  onRename?: (nodeId: string, title: string) => void;
  /** A11：文本节点就地编辑提交（双击正文触发）。 */
  onUpdateText?: (nodeId: string, text: string) => void;
  /** reference 节点角色切换（复用 ReferenceImageRole 枚举）。 */
  onUpdateReferenceRole?: (nodeId: string, role: ReferenceImageRole) => void;
  /** 分镜音轨绑定的 metadata 写入出口（原样透传给 NodeBody）。 */
  onPatchMetadata?: (nodeId: string, patch: StoryboardShotAudioMetadata) => void;
  /** A12：失败节点就地重试（沿用保存的生成参数）。 */
  onRetry?: (nodeId: string) => void;
  /** A2：干净点击（选取且未拖动）——宿主用它「点选即开面板」。 */
  onNodeClick?: (nodeId: string) => void;
  /** 内嵌 prompt 面板的透传（W2 新增能力） */
  onStopGenerate?: () => void;
  onOpenPromptLibrary?: () => void;
  /** 语义缩放层级（2026-09-30）：3 = 工程透析层，卡内叠工程条。缺省 = 2（现状）。 */
  lod?: CanvasLod;
  /** 打开工程透析面板（LOD 3 工程条「透析」按钮／Image·Video·Audio 双击）。 */
  onOpenEngineering?: (nodeId: string) => void;
  /** 语义缩放聚合位移（节点中心 → 所属阶段质心，世界座标）；写成 --gx/--gy，由内容层 --lod-g 驱动。 */
  gatherOffset?: { x: number; y: number };
  /** 所属阶段（01–04）；供「飞向某阶段时压暗其他阶段」的 CSS 选择器用。 */
  stageId?: number | null;
  /** 透析带内且节点在可视范围：挂载拆机板，卡面（背板）随 --lod-xray 掀开。 */
  xrayVisible?: boolean;
  /** 拆机内容的「输入」段＝入边来源（宿主按连线算好、引用稳定）。 */
  boardInputs?: readonly InspectInput[];
  /** 正在被透析：卡片抬起（置顶、青色柔光）。 */
  engineeringFocused?: boolean;
}

export function CanvasNodeView({
  node,
  selected,
  onSelect,
  onInteractionStart,
  onMove,
  onResize,
  onDelete,
  onRerun,
  onEdit,
  scale,
  enterDelay = 0,
  batchExpanded,
  batchChildCount,
  onToggleBatch,
  onEditPrompt,
  promptPanelOpen,
  onClosePromptPanel,
  onGenerateFromNode,
  isGenerating,
  onAddToAssetLibrary,
  onStartConnect,
  onDownload,
  onEditImage,
  onUpscale,
  upscaling,
  onExtractVideoFrames,
  extractingVideoFrames,
  onSetPrimary,
  onDownloadAll,
  batchPrimaryImageUrl,
  onNodeContextMenu,
  referenceCandidates,
  selectedReferenceIds,
  onToggleReference,
  entityCandidates,
  selectedEntityIds,
  onToggleEntity,
  shotEntityCardIds,
  onStartPortDrag,
  onHoverChange,
  adjacent,
  onRename,
  onUpdateText,
  onUpdateReferenceRole,
  onPatchMetadata,
  onRetry,
  onNodeClick,
  onStopGenerate,
  onOpenPromptLibrary,
  lod = 2,
  onOpenEngineering,
  gatherOffset,
  stageId,
  xrayVisible = false,
  boardInputs = NO_INPUTS,
  engineeringFocused = false,
}: CanvasNodeViewProps) {
  const [mounted, setMounted] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  // A10：就地编辑态（null = 未在编辑）
  const [editingTitle, setEditingTitle] = useState<string | null>(null);

  const {
    handleScrollAreaDown,
    handleScrollAreaMove,
    handleScrollAreaEnd,
    handlePointerDown,
    handlePointerMove,
    endDrag,
    handleResizeStart,
    handleResizeMove,
    endResize,
  } = useNodeGestures({ node, scale, onSelect, onInteractionStart, onMove, onResize, onNodeClick });

  useEffect(() => {
    setMounted(true);
  }, []);

  const status: CanvasNodeStatus = node.metadata?.status ?? "idle";
  const statusLabel = STATUS_LABEL[status];

  /**
   * 类型徽章（2026-08-26 用户裁定：不同类型节点 UI 必须有区分）。
   * 每个类型一个语义色 + 图标 + 名称；text 类型按 pipelineCard metadata 再细分：
   * tool = 工具卡（蓝）、gate = 门禁卡（琥珀）、其余 = 文本（灰）。
   * （2026-08-27 起 🔧 emoji 前缀已废，识别走结构化 metadata。）
   * 着色克制（bg 12% + 文字色），不喧宾夺主。
   */
  const typeBadge = (() => {
    switch (node.type) {
      case CanvasNodeType.Image:
        return { label: "生成", Icon: ImageIcon, cls: "bg-[rgba(52,199,89,0.12)] text-[#248A3D]", bar: "bg-[#248A3D]" };
      case CanvasNodeType.Video:
        return { label: "视频", Icon: VideoIcon, cls: "bg-[rgba(90,200,250,0.14)] text-[#0E7FA8]", bar: "bg-[#0E7FA8]" };
      case CanvasNodeType.Audio:
        return { label: "音频", Icon: AudioLines, cls: "bg-[rgba(255,149,0,0.12)] text-ios-orange", bar: "bg-ios-orange" };
      case CanvasNodeType.CharacterCard:
        return { label: "角色", Icon: User, cls: "bg-[rgba(255,45,85,0.12)] text-[#D92E5E]", bar: "bg-[#D92E5E]" };
      case CanvasNodeType.SceneCard:
        return { label: "场景", Icon: Mountain, cls: "bg-[rgba(90,200,250,0.14)] text-[#0E7FA8]", bar: "bg-[#0E7FA8]" };
      case CanvasNodeType.Config:
        return { label: "产出", Icon: FileText, cls: "bg-[rgba(88,86,214,0.12)] text-[#5856D6]", bar: "bg-[#5856D6]" };
      case CanvasNodeType.Text:
        if (node.metadata?.pipelineCard === "tool") return { label: "工具", Icon: Wrench, cls: "bg-ios-blue/[0.12] text-ios-blue", bar: "bg-ios-blue" };
        if (node.metadata?.pipelineCard === "gate") return { label: "门禁", Icon: ShieldCheck, cls: "bg-[rgba(255,149,0,0.14)] text-[#B96A00]", bar: "bg-[#B96A00]" };
        if (node.metadata?.pipelineCard === "note") return { label: "配方", Icon: Lightbulb, cls: "bg-[rgba(255,204,0,0.16)] text-[#8A6D00]", bar: "bg-[#C79A00]" };
        return { label: "文本", Icon: Type, cls: "bg-black/5 text-muted-foreground", bar: "bg-black/30" };
      case CanvasNodeType.Prompt:
        return { label: "提示词", Icon: Type, cls: "bg-ios-blue/10 text-ios-blue", bar: "bg-ios-blue" };
      case CanvasNodeType.Reference:
        return { label: "参考", Icon: Paperclip, cls: "bg-ios-blue/10 text-ios-blue", bar: "bg-ios-blue" };
      case CanvasNodeType.Director:
        // 导演台：Video 色系（#0E7FA8），图标换 Clapperboard 区分身份，不新发色。
        return { label: "3D 导演", Icon: Clapperboard, cls: "bg-[rgba(90,200,250,0.14)] text-[#0E7FA8]", bar: "bg-[#0E7FA8]" };
      case CanvasNodeType.Scene3d:
        // 3D 场景卡（Astra PRD P1-3）：场景=青色系（与 SceneCard 同色源不新发色），
        // 图标换 Mountain 与 2D 场景同源、靠「3D 场景」标签区分身份。
        return { label: "3D 场景", Icon: Mountain, cls: "bg-[rgba(90,200,250,0.14)] text-[#0E7FA8]", bar: "bg-[#0E7FA8]" };
      case CanvasNodeType.Group:
        return { label: "组", Icon: Boxes, cls: "bg-black/5 text-muted-foreground", bar: "bg-black/30" };
      default:
        return { label: TYPE_LABEL[node.type] ?? node.type, Icon: SlidersHorizontal, cls: "bg-black/5 text-muted-foreground", bar: "bg-black/30" };
    }
  })();
  const TypeBadgeIcon = typeBadge.Icon;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(node.id);
    }
  };

  // 透析中的节点自己把背板滑开（--lod-xray 过渡到 1），不跟画布缩放走；关闭后保留 600ms 让背板滑回。
  const [engRelease, setEngRelease] = useState(false);
  const wasFocusedRef = useRef(engineeringFocused);
  useEffect(() => {
    if (wasFocusedRef.current && !engineeringFocused) {
      setEngRelease(true);
      const t = window.setTimeout(() => setEngRelease(false), 600);
      wasFocusedRef.current = engineeringFocused;
      return () => window.clearTimeout(t);
    }
    wasFocusedRef.current = engineeringFocused;
  }, [engineeringFocused]);
  // LOD 3 拆机内容：只在透析带内＋在视野里、或正被透析时才算（节点/入边变了才重算）。
  const inspectOn = xrayVisible || engineeringFocused || engRelease;
  const sections = useMemo(() => (inspectOn ? inspectSections(node, boardInputs) : null), [inspectOn, node, boardInputs]);
  // 「还有 N 项」只需跟缩放粗粒度同步（0.1 一档）。
  const zoomKey = Math.round(scale * 10) / 10;
  // 双击下钻：Image/Video/Audio 卡体没有既有双击行为（标题双击重命名自带 stopPropagation；
  // 文本类正文双击 = 就地编辑，故不绑）。
  const dblOpensEngineering =
    lod === 3 &&
    !!onOpenEngineering &&
    (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio);

  const showCostBadge =
    !xrayVisible &&
    (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) &&
    typeof node.metadata?.cost_coins === "number";

  // C-FE：canvas.plan 的 cost_hint（预估花费）——实际 cost_coins 落地前显示
  // 「预估 N 币」角标（与实际角标同位同款、互斥接班），无值不显示（行为同现状）。
  const showCostHintBadge =
    !xrayVisible &&
    !showCostBadge &&
    (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) &&
    typeof node.metadata?.cost_hint === "number";

  return (
    <div
      data-canvas-node={node.id}
      data-lod-stage={stageId ?? undefined}
      data-eng-focused={engineeringFocused ? "" : undefined}
      data-eng-release={engRelease ? "" : undefined}
      data-lod-xray={engineeringFocused || engRelease ? "" : undefined}
      data-lod-xray-open={engineeringFocused ? "" : undefined}
      role="button"
      tabIndex={0}
      aria-label={`画布节点：${node.title}，${statusLabel}`}
      onKeyDown={handleKeyDown}
      onDoubleClick={
        dblOpensEngineering
          ? (e) => {
              e.stopPropagation();
              onOpenEngineering?.(node.id);
            }
          : undefined
      }
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerEnter={() => {
        setIsHovered(true);
        onHoverChange?.(node.id, true);
      }}
      onPointerLeave={() => {
        setIsHovered(false);
        onHoverChange?.(node.id, false);
      }}
      onContextMenu={(e) => {
        // 节点右键：交宿主开选单（统一挡掉浏览器原生选单）。
        e.preventDefault();
        e.stopPropagation();
        onNodeContextMenu?.(node.id, e.clientX, e.clientY);
      }}
      className={cn(
        "lod-node absolute touch-manipulation select-none transition-[opacity,transform] duration-300 ease-out",
        "[-webkit-tap-highlight-color:transparent]",
        "motion-reduce:translate-y-0 motion-reduce:transition-none",
        mounted ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
      )}
      style={{
        left: node.position.x,
        top: node.position.y,
        width: node.width,
        height: node.height,
        transitionDelay: `${enterDelay}ms`,
        ...(gatherOffset ? ({ "--gx": gatherOffset.x, "--gy": gatherOffset.y } as React.CSSProperties) : null),
        ...(engineeringFocused ? ({ "--lod-xray": 1 } as React.CSSProperties) : null),
      }}
    >
      {/* 批次收起态：堆叠视觉（卡片后方两张错位幽灵卡） */}
      {typeof batchChildCount === "number" && batchChildCount > 0 && batchExpanded === false && (
        <>
          <div className="pointer-events-none absolute inset-0 -z-10 translate-x-[6px] translate-y-[6px] rounded-2xl bg-white/70 shadow-sm" aria-hidden="true" />
          <div className="pointer-events-none absolute inset-0 -z-20 translate-x-[12px] translate-y-[12px] rounded-2xl bg-white/45 shadow-sm" aria-hidden="true" />
        </>
      )}
      {/* 拆机板：垫在卡面底下；卡面（背板）随 --lod-xray 掀开后露出。 */}
      <div
        className={cn(
          "lg-card lg-card-canvas relative flex h-full flex-col overflow-hidden rounded-2xl transition-shadow duration-300",
          selected && !engineeringFocused && "ring-2 ring-ios-blue/50",
          !selected && !engineeringFocused && adjacent && "ring-2 ring-ios-blue/20",
          engineeringFocused && "shadow-[0_28px_70px_-12px_rgba(14,165,233,0.55),0_0_0_1.5px_rgba(56,189,248,0.9)]",
        )}
      >
        {/* 卡片上沿横线（2026-08-26 用户裁定）：类型色，与徽章同源——
            状态语义已由标题栏右侧状态徽章承担，顶线只表达节点身份。 */}
        <div className={cn("h-[3px] w-full shrink-0", typeBadge.bar)} />
        <div className="flex items-center gap-2 px-3 py-2">
          {/* 卡面左缘微缩图：标题字串（node.title）里引用了哪些实体一眼可见。
              无实体时 EntityThumbStack 回 null ⇒ 零 DOM、零位移。 */}
          <EntityThumbStack entities={entitiesInText(node.title)} />
          {editingTitle !== null ? (
            <input
              data-canvas-interactive
              autoFocus
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  const t = editingTitle.trim();
                  if (t && t !== node.title) onRename?.(node.id, t);
                  setEditingTitle(null);
                } else if (e.key === "Escape") {
                  setEditingTitle(null);
                }
              }}
              onBlur={() => {
                const t = editingTitle.trim();
                if (t && t !== node.title) onRename?.(node.id, t);
                setEditingTitle(null);
              }}
              className="min-w-0 flex-1 rounded-md border border-ios-blue/40 bg-white px-1.5 py-0.5 text-ios-subhead font-semibold text-foreground outline-none"
              aria-label="重命名节点"
            />
          ) : (
            <span
              className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground"
              onDoubleClick={(e) => {
                if (!onRename) return;
                e.stopPropagation();
                setEditingTitle(node.title);
              }}
              title={onRename ? "双击重命名" : undefined}
            >
              {node.title}
              {node.metadata?.role && (
                <span className="ml-2 text-ios-caption2 px-1.5 py-0.5 bg-ios-blue/15 text-ios-blue rounded">
                  {node.metadata.role}
                </span>
              )}
            </span>
          )}
          <span className={cn(typeBadge.cls, "shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-ios-caption2 font-medium leading-none")}>
            <TypeBadgeIcon className="h-3 w-3" aria-hidden="true" />
            {typeBadge.label}
          </span>
          {/* Director 节点无生成生命周期（metadata.status 恒 idle），
              「待处理」徽章语义错误，故不渲染；其他节点维持现状。 */}
          {node.type !== CanvasNodeType.Director && (
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-ios-caption1 font-medium",
                status === "idle" && "bg-black/5 text-muted-foreground",
                status === "success" && "bg-ios-green/15 text-[#248A3D]",
                status === "loading" && "bg-ios-blue/10 text-ios-blue",
                status === "error" && "bg-destructive/10 text-destructive",
              )}
            >
              {statusLabel}
            </span>
          )}
          {/* P1-1: 重新生成按钮 */}
          {onRerun && (node.type === "image" || node.type === "video") && (status === "success" || status === "error") && (
            <button
              type="button"
              data-canvas-interactive
              onClick={() => onRerun(node.id)}
              title="重新生成"
              aria-label="重新生成此节点"
              className={cn(
                "shrink-0 rounded-full p-1 text-foreground/45 transition-colors",
                "touch-manipulation [-webkit-tap-highlight-color:transparent]",
                "hover:bg-black/5 hover:text-muted-foreground",
                "max-sm:h-11 max-sm:w-11 max-sm:active:bg-black/10",
              )}
            >
              <RefreshCw className="h-3.5 w-3.5 max-sm:h-[18px] max-sm:w-[18px]" aria-hidden="true" />
            </button>
          )}

          {/* P1-2: 编辑节点按钮 */}
          {onEdit && (node.type === "image" || node.type === "video") && (
            <button
              type="button"
              data-canvas-interactive
              onClick={() => {
                const patch = {
                  prompt: node.metadata?.prompt || "",
                  model: node.metadata?.model,
                  size: node.metadata?.size,
                  shot_size: node.metadata?.shot_size || "中景",
                  camera_move: node.metadata?.camera_move || "固定",
                };
                onEdit(node.id, patch);
              }}
              title="编辑参数"
              aria-label="编辑节点参数"
              className={cn(
                "shrink-0 rounded-full p-1 text-foreground/45 transition-colors",
                "touch-manipulation [-webkit-tap-highlight-color:transparent]",
                "hover:bg-black/5 hover:text-muted-foreground",
                "max-sm:h-11 max-sm:w-11 max-sm:active:bg-black/10",
              )}
            >
              <Edit2 className="h-3.5 w-3.5 max-sm:h-[18px] max-sm:w-[18px]" aria-hidden="true" />
            </button>
          )}

          {onDelete && (
            <button
              type="button"
              data-canvas-interactive
              onClick={() => onDelete(node.id)}
              title="删除节点"
              aria-label="删除节点"
              className={cn(
                "shrink-0 rounded-full p-1 text-foreground/45 transition-colors",
                "touch-manipulation [-webkit-tap-highlight-color:transparent]",
                "hover:bg-black/5 hover:text-muted-foreground",
                // 行动端：≥44px 触控热区 + 按压回馈（行动端没有 hover）
                "max-sm:-mr-1.5 max-sm:h-11 max-sm:w-11 max-sm:active:bg-black/10 max-sm:active:text-muted-foreground max-sm:hover:bg-transparent",
              )}
            >
              <X className="h-3.5 w-3.5 max-sm:h-[18px] max-sm:w-[18px]" aria-hidden="true" />
            </button>
          )}
        </div>
        {/* Hover 工具列 */}
        {(isHovered || selected) && !promptPanelOpen && (
          <CanvasNodeHoverToolbar
            nodeId={node.id}
            scale={scale}
            isSelected={selected}
            onEdit={onEditPrompt}
            onRerun={onRerun}
            onDelete={onDelete}
            onAddToAssetLibrary={onAddToAssetLibrary}
            onConnect={onStartConnect}
            onDownload={onDownload}
            onEditImage={onEditImage}
            onUpscale={onUpscale}
            upscaling={upscaling}
            onSetPrimary={onSetPrimary}
          />
        )}
        {/* reference 节点角色 badge：复用 REFERENCE_IMAGE_ROLES，切换即改生成请求里的角色。 */}
        {node.type === CanvasNodeType.Reference && onUpdateReferenceRole && (
          <div
            data-canvas-interactive
            className="lod-cover-overlay absolute bottom-2 left-2 z-10"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <select
              aria-label="参考图角色"
              title="参考图角色（连线生成时带入）"
              value={toReferenceImageRole(node.metadata?.referenceRole)}
              onChange={(e) => {
                e.stopPropagation();
                onUpdateReferenceRole(node.id, e.target.value as ReferenceImageRole);
              }}
              className="cursor-pointer rounded-full border-0 bg-black/60 px-2 py-0.5 text-ios-caption2 font-medium text-white outline-none"
            >
              {REFERENCE_IMAGE_ROLES.map((r) => (
                <option key={r.id} value={r.id} className="bg-white text-foreground">
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {/* 批次堆叠指示器 */}
        {typeof batchChildCount === "number" && batchChildCount > 0 && (
          <button
            data-canvas-interactive
            onClick={(e) => { e.stopPropagation(); onToggleBatch?.(node.id); }}
            className="absolute bottom-2 left-2 z-10 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-ios-caption2 text-white"
          >
            <ImageIcon className="h-3 w-3" />
            <span>{batchChildCount}</span>
            {batchExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
          </button>
        )}
        <div className="relative min-h-0 flex-1">
          {/* 拆机：正文区底下垫著内部参数；原正文（lod-cover）像滑盖一样往上收，标题列与卡片外观不动。 */}
          {sections && (
            <NodeInspectBody sections={sections} zoomKey={zoomKey} onOpen={onOpenEngineering ? () => onOpenEngineering(node.id) : undefined} />
          )}
          {sections && <div className="lod-lid-edge pointer-events-none absolute inset-x-0 z-[2] h-[12px]" aria-hidden="true" />}
          <div className={cn("relative h-full", sections && "lod-cover flex flex-col bg-white")}>
          <NodeBody
            node={node}
            scale={scale}
            batchPrimaryImageUrl={batchPrimaryImageUrl}
            batchExpanded={batchExpanded}
            onRetry={onRetry}
            onEditPrompt={onEditPrompt}
            onUpdateText={onUpdateText}
            onPatchMetadata={onPatchMetadata}
            onScrollAreaPointerDown={handleScrollAreaDown}
            onScrollAreaPointerMove={handleScrollAreaMove}
            onScrollAreaPointerEnd={handleScrollAreaEnd}
            onExtractVideoFrames={onExtractVideoFrames}
            extractingVideoFrames={extractingVideoFrames}
          />
          </div>
        </div>
        {showCostBadge && (
          <span className="pointer-events-none absolute right-2 bottom-2 rounded-full bg-black/60 px-2 py-0.5 text-ios-caption1 font-medium text-white">
            {node.metadata?.cost_coins} 币
          </span>
        )}
        {showCostHintBadge && (
          <span className="pointer-events-none absolute right-2 bottom-2 rounded-full bg-black/60 px-2 py-0.5 text-ios-caption1 font-medium text-white tabular-nums">
            预估 {node.metadata?.cost_hint} 币
          </span>
        )}
      </div>
      {/* Prompt 面板 */}
      {promptPanelOpen && (
        <CanvasNodePromptPanel
          nodeId={node.id}
          initialPrompt={node.metadata?.prompt ?? ""}
          initialModel={node.metadata?.model}
          initialSize={node.metadata?.size ?? "1:1"}
          initialCount={node.metadata?.count ?? 1}
          isRunning={isGenerating}
          onClose={onClosePromptPanel}
          onGenerate={onGenerateFromNode}
          referenceCandidates={referenceCandidates}
          selectedReferenceIds={selectedReferenceIds}
          onToggleReference={onToggleReference}
          entityCandidates={entityCandidates}
          selectedEntityIds={selectedEntityIds}
          onToggleEntity={onToggleEntity}
          shotEntityCardIds={shotEntityCardIds}
          onStop={onStopGenerate}
          onOpenPromptLibrary={onOpenPromptLibrary}
        />
      )}
      {/* 批次子节点摘要列（展开时）：数量 + 下载全部 */}
      {batchExpanded && batchChildCount && batchChildCount > 0 && (
        <div
          className="absolute bottom-0 left-0 right-0 z-30 flex items-center justify-center gap-2 rounded-b-2xl bg-black/5 py-1"
          data-canvas-interactive
        >
          <span className="text-ios-caption2 text-foreground/45">
            {batchChildCount} 张结果
          </span>
          {onDownloadAll && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDownloadAll(node.id);
              }}
              className="flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 text-ios-caption2 font-medium text-ios-blue hover:bg-white"
            >
              <Download className="h-3 w-3" aria-hidden="true" />
              下载全部
            </button>
          )}
        </div>
      )}
      {/* A1：连线 port（左=入边、右=出边）。hover/选中时浮现，按下开始拖线。
          尺寸随缩放反比，任何缩放级别都是 12px 视觉 + 32px 热区。 */}
      {onStartPortDrag &&
        (isHovered || selected) &&
        (["left", "right"] as const).map((side) => (
          <div
            key={side}
            data-canvas-interactive
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onStartPortDrag(node.id, side, e.clientX, e.clientY);
            }}
            className="absolute z-20 flex cursor-crosshair items-center justify-center"
            style={{
              [side]: "calc(-16px * var(--canvas-inverse-scale, 1))",
              top: "50%",
              transform: "translateY(-50%)",
              width: "calc(32px * var(--canvas-inverse-scale, 1))",
              height: "calc(32px * var(--canvas-inverse-scale, 1))",
              touchAction: "none",
            }}
            title={side === "right" ? "拖出连线" : "拖入连线"}
            aria-label={side === "right" ? "从此节点拖出连线" : "拖入连线到此节点"}
          >
            <span
              className="rounded-full border-2 border-white bg-ios-blue shadow-sm transition-transform hover:scale-125"
              style={{
                width: "calc(12px * var(--canvas-inverse-scale, 1))",
                height: "calc(12px * var(--canvas-inverse-scale, 1))",
              }}
              aria-hidden="true"
            />
          </div>
        ))}
      {selected && onResize
        ? RESIZE_HANDLES.map((h) => (
            <div
              key={h.id}
              data-canvas-interactive
              onPointerDown={(e) => handleResizeStart(e, h.cfg)}
              onPointerMove={handleResizeMove}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              className={cn(
                "z-10 flex touch-manipulation items-center justify-center rounded-[3px]",
                "border border-ios-blue/60 bg-ios-blue/20",
                // 行动端：44px 触控热区（外框隐形，靠中心小方块提示），缩放保持世界座标不变
                "max-sm:rounded-lg max-sm:border-transparent max-sm:bg-transparent",
                "max-sm:!h-[calc(44px*var(--canvas-inverse-scale,1))] max-sm:!w-[calc(44px*var(--canvas-inverse-scale,1))]",
              )}
              style={{
                ...h.pos,
                position: "absolute",
                width: "calc(10px * var(--canvas-inverse-scale, 1))",
                height: "calc(10px * var(--canvas-inverse-scale, 1))",
              }}
            >
              <span
                className="hidden h-3 w-3 rounded-[2px] border border-ios-blue/70 bg-ios-blue/35 max-sm:block"
                aria-hidden="true"
              />
            </div>
          ))
        : null}
    </div>
  );
}

const MemoCanvasNodeView = memo(CanvasNodeView);

/** 画布用的节点（2026-10-01 效能）：memo＋稳定 on* 代理——平移/缩放时父层每帧重渲染，资料没变的卡直接跳过。 */
export function CanvasNodeViewMemo(props: CanvasNodeViewProps) {
  return <MemoCanvasNodeView {...useStableHandlers(props)} />;
}
