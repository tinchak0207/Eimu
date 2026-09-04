import { memo, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { Download, RotateCcw, Search, Trash2, X } from "lucide-react";
import type { ReferenceImage, ReferenceImageRole, ImageResult } from "@/lib/image-types";
import type { PersistedGenerationEntry } from "@/lib/generation-cache";
import type { GenerationTaskProjection } from "@/lib/generation-task-types";
import type { Suggestion } from "@/lib/suggestions";
import type { BoardFolder, SavedShotMeta } from "@/lib/boards-store";
import { cn } from "@/lib/utils";
import { STYLE_CATEGORIES, STYLE_LIBRARY } from "@/lib/style-library";
import { REFERENCE_IMAGE_ROLES, SLOT_STATE_LABELS, type SlotState } from "./workstation-constants";


// 创作模板：两份模板数据只进入这个动态 chunk，不阻塞专业模式首次绘制。占位复用真实控件的 class 与高度
// （搜索框 2rem + 3 枚 2rem 筛选钮 + 列表 21rem = .pro-resource-list 的
// max-height），chunk 落地前后零版面跳动。
export const CreatorResourcePanel = dynamic(() => import("./CreatorResourcePanel"), {
  ssr: false,
  loading: () => (
    <div className="pro-resource-library" aria-hidden="true">
      <div className="pro-resource-toolbar">
        <div className="pro-resource-search" style={{ minHeight: "2rem" }} />
        <div className="pro-resource-filter">
          <button type="button" disabled />
          <button type="button" disabled />
          <button type="button" disabled />
          <button type="button" disabled />
        </div>
      </div>
      <div className="pro-resource-list" style={{ minHeight: "21rem" }} />
    </div>
  ),
});

// 场景模板面板（PixAI 改图 / 模板出图）：体积小，但组件内会 fetch /v1/templates，
// 只在用户切到这个 tab 时才加载。占位复用 resource 面板的网格 class，避免版面跳动。
export const TemplatePanel = dynamic(() => import("./TemplatePanel"), {
  ssr: false,
  loading: () => (
    <div className="pro-template-library" aria-hidden="true">
      <div className="pro-template-grid" style={{ minHeight: "18rem" }} />
    </div>
  ),
});

export const StyleGrid = memo(function StyleGrid({
  category,
  selectedId,
  onCategoryChange,
  onToggle,
}: {
  category: string;
  selectedId: string | null;
  onCategoryChange: (category: string) => void;
  onToggle: (id: string) => void;
}) {
  // 106 条风格原本只能靠 8 个分类 chip 盲猜（想找「赛博朋克」得先猜它属于「未来」
  // 还是「艺术」），而隔壁创作模板库与 LoRA 库都有搜索。搜索时跨全库而非仅当前分类。
  const [query, setQuery] = useState("");
  const styles = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return STYLE_LIBRARY.filter((style) => style.category === category);
    return STYLE_LIBRARY.filter((style) =>
      style.name.toLowerCase().includes(keyword)
      || style.category.toLowerCase().includes(keyword)
      || style.prompt.toLowerCase().includes(keyword));
  }, [category, query]);
  return (
    <>
      <div className="pro-resource-search pro-style-search">
        <Search className="h-3 w-3" aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索风格（中文名或英文提示词）"
          aria-label="搜索风格"
        />
        {query && (
          <button type="button" onClick={() => setQuery("")} aria-label="清空搜索">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {!query.trim() && (
        <div className="pro-chip-row">
          {STYLE_CATEGORIES.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onCategoryChange(item)}
              className={cn(category === item && "is-active")}
            >
              {item}
            </button>
          ))}
        </div>
      )}
      <div className="pro-style-grid">
        {styles.map((style) => (
          <button
            key={style.id}
            type="button"
            onClick={() => onToggle(style.id)}
            className={cn(selectedId === style.id && "is-active")}
            title={style.prompt.replace("{prompt}", "…")}
          >
            <strong>{style.name}</strong>
            {/* 风格是视觉产物却只用 2-4 个中文字表示；把英文提示词摘要常驻显示，
                不再让唯一线索藏在 title 里（移动端拿不到 hover）。 */}
            <small>{style.prompt.replace("{prompt}", "…").replace(/\s+/g, " ").slice(0, 44)}</small>
          </button>
        ))}
        {!styles.length && <p className="pro-style-empty">没有匹配的风格。</p>}
      </div>
    </>
  );
});

export interface ProfessionalRunConfig {
  prompt: string;
  contextPrompt: string;
  negativePrompt: string;
  negativeHint: string;
  workflowPreset: string;
  workflowPresetLabel: string;
  promptHint: string;
  productionIntent: string;
  imageSize: string;
  imageSizes: string[];
  styleTemplate?: string;
  qualityProfile: string;
  seedHint: string;
  regionalPrompts: Array<{ text: string; weight?: number }>;
  estimatedCredits: number;
  referenceImageRoles: Record<string, ReferenceImageRole>;
  copies: number;
  concurrency: number;
  durationSeconds?: number;
  generateAudio?: boolean;
  loraModelVersionIds?: string[];
  retryOfTaskId?: string;
}

export interface InvokeInspiredWorkstationProps {
  suggestions: Suggestion[];
  referenceImages: ReferenceImage[];
  onReferenceImagesChange: (images: ReferenceImage[]) => void;
  images: ImageResult[];
  isLoading: boolean;
  recentWorkflows: PersistedGenerationEntry[];
  tasks: GenerationTaskProjection[];
  onRun: (config: ProfessionalRunConfig) => void;
  modelId: string;
  onModelChange: (modelId: string) => void;
  onExitProfessionalMode?: () => void;
  /** 仅当从普通模式 LoRA 引导末步「前往专业模式」进入时为 true：跳到参数页并播放 LoRA 教学。 */
  loraTourFromGuide?: boolean;
  capabilityNotice?: string;
  /**
   * 专业模式当前是否可见。
   *
   * 工作站在普通模式下不卸载，只是父层加了 `hidden`（保住分栏宽度、草稿、队列状态），
   * 于是它注册在 window 上的全局热键在普通模式里照样生效 —— 在首页输入框外按一下
   * Cmd+Enter 就会拿工作站的参数真的发起一次生成并扣币，用户完全不知道发生了什么。
   */
  active?: boolean;
  /** PixAI 改图/放大/模板的同步结果 URL（外部直接渲染到画布）。 */
  externalResultUrl?: string | null;
  /** 模板生成完成回调（结果 URL 已由 externalResultUrl 驱动画布，这里用于历史/提示）。 */
  onTemplateResult?: (url: string) => void;
}

export const DraggableReferenceTile = memo(function DraggableReferenceTile({
  image,
  onRoleChange,
  onStrengthChange,
}: {
  image: ReferenceImage;
  onRoleChange: (id: string, role: ReferenceImageRole) => void;
  onStrengthChange: (id: string, strength: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const imageRef = useRef(image);
  imageRef.current = image;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return draggable({
      element,
      getInitialData() {
        const current = imageRef.current;
        return { type: "reference_image", id: current.id, name: current.name, role: current.role ?? "general" };
      },
    });
  }, []);

  return (
    <div ref={ref} className="pro-reference-tile">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.previewUrl} alt={image.name} />
      <div className="pro-reference-tile-body">
        <p title={image.name}>{image.name}</p>
        <label>
          <span>用途</span>
          <select
            value={image.role ?? "general"}
            onChange={(event) => onRoleChange(image.id, event.target.value as ReferenceImageRole)}
            aria-label={`${image.name} 参考图用途`}
          >
            {REFERENCE_IMAGE_ROLES.map((role) => (
              <option key={role.id} value={role.id}>{role.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>强度</span>
          <input
            min={10}
            max={100}
            step={5}
            type="range"
            value={image.strength ?? 80}
            onChange={(event) => onStrengthChange(image.id, Number(event.target.value))}
            aria-label={`${image.name} 影响强度`}
          />
          <strong>{image.strength ?? 80}%</strong>
        </label>
      </div>
    </div>
  );
});

export interface SlotItemView {
  id: string;
  label: string;
  state: SlotState;
  detail: string;
  taskId?: string;
  resultId?: string;
}

export const QueueSlotList = memo(function QueueSlotList({
  slots,
  onSelect,
  onRetry,
}: {
  slots: SlotItemView[];
  onSelect?: (slot: SlotItemView) => void;
  onRetry?: (slot: SlotItemView) => void;
}) {
  return (
    <div className="pro-slot-list">
      {slots.map((slot) => (
        /*
          每行独立重试。旧版只有面板底部一个「重试失败任务」，它重试的是第一条 ——
          8 张里第 3、第 7 张失败时，用户点一次只修好第 3 张，第 7 张要等第 3 张
          跑完、从列表里消失，才轮得到。重试钮是行的兄弟节点而不是子节点：
          <button> 里套 <button> 是无效 HTML，浏览器会把内层拆出去。
        */
        <div key={slot.id} className="pro-slot-item">
          <button
            type="button"
            className="pro-slot-row"
            data-slot-state={slot.state}
            onClick={() => onSelect?.(slot)}
            disabled={!slot.taskId}
            title={slot.resultId ? "在画布打开结果" : "查看任务状态"}
          >
            <span className="pro-slot-dot" />
            <span>{slot.label}</span>
            <strong>{SLOT_STATE_LABELS[slot.state]}</strong>
            <em>{slot.detail}</em>
          </button>
          {slot.state === "failed" && slot.taskId && onRetry && (
            <button
              type="button"
              className="pro-slot-retry"
              onClick={() => onRetry(slot)}
              aria-label={`重试 ${slot.label}`}
              title={`只重试这一条：${slot.label}`}
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              重试
            </button>
          )}
        </div>
      ))}
    </div>
  );
});

export const BoardsPanel = memo(function BoardsPanel({
  boards,
  shots,
  shotUrls,
  shotCounts,
  totalShots,
  activeBoardId,
  newBoardName,
  hasActiveBoard,
  onSelectBoard,
  onNameChange,
  onCreate,
  onDeleteActive,
  onExport,
  onMoveShot,
  onToggleStar,
  onDeleteShot,
  onDownload,
}: {
  boards: BoardFolder[];
  shots: SavedShotMeta[];
  shotUrls: Record<string, string>;
  shotCounts: ReadonlyMap<string, number>;
  totalShots: number;
  activeBoardId: string;
  newBoardName: string;
  hasActiveBoard: boolean;
  onSelectBoard: (id: string) => void;
  onNameChange: (name: string) => void;
  onCreate: () => void;
  onDeleteActive: () => void;
  onExport: () => void;
  onMoveShot: (id: string, boardId: string) => void;
  onToggleStar: (id: string) => void;
  onDeleteShot: (id: string) => void;
  onDownload: (shot: SavedShotMeta) => void;
}) {
  return (
    <div className="pro-boards">
      <div className="pro-board-chips">
        <button
          type="button"
          onClick={() => onSelectBoard("all")}
          className={cn(activeBoardId === "all" && "is-active")}
        >
          全部 {totalShots}
        </button>
        {boards.map((board) => (
          <button
            key={board.id}
            type="button"
            onClick={() => onSelectBoard(board.id)}
            className={cn(activeBoardId === board.id && "is-active")}
          >
            {board.name} {shotCounts.get(board.id) ?? 0}
          </button>
        ))}
      </div>
      <div className="pro-board-create">
        <input
          value={newBoardName}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") onCreate(); }}
          placeholder="新文件夹名称"
        />
        <button type="button" onClick={onCreate}>新建</button>
        <button type="button" onClick={onExport} disabled={!shots.length} title="导出当前文件夹的打包文件">
          <Download className="h-3 w-3" />
          导出打包文件
        </button>
        {hasActiveBoard && (
          <button type="button" onClick={onDeleteActive} title="删除当前文件夹及其中所有图片">
            删除文件夹
          </button>
        )}
      </div>
      <div className="pro-shot-grid">
        {shots.map((shot) => (
          <div key={shot.id} className="pro-shot-card">
            {shotUrls[shot.id] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={shotUrls[shot.id]} alt={shot.name} />
            ) : (
              <div className="pro-shot-loading">正在载入</div>
            )}
            <div className="pro-shot-body">
              <p title={shot.name}>{shot.name}</p>
              <small>{[shot.presetLabel, shot.imageSize].filter(Boolean).join(" · ") || "成片"}</small>
              <div className="pro-shot-actions">
                <button
                  type="button"
                  onClick={() => onToggleStar(shot.id)}
                  className={cn(shot.starred && "is-active")}
                  title={shot.starred ? "取消入选" : "标为入选"}
                >
                  {shot.starred ? "★" : "☆"}
                </button>
                <select
                  value={shot.boardId}
                  onChange={(event) => onMoveShot(shot.id, event.target.value)}
                  aria-label="移动到文件夹"
                >
                  {boards.map((board) => (
                    <option key={board.id} value={board.id}>{board.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => onDownload(shot)}
                  aria-label="下载这张成片"
                  title="下载这张成片"
                >
                  <Download className="h-3 w-3" aria-hidden="true" />
                </button>
                {/*
                  删除和下载原本贴在一起、按钮只有 0.6rem 字高：手机上想存图，
                  很容易点掉删除。现在删除单独隔开并且用红色语义色，误触成本对得上。
                */}
                <button
                  type="button"
                  onClick={() => onDeleteShot(shot.id)}
                  aria-label="从文件夹删除这张成片"
                  title="从文件夹删除"
                  className="pro-shot-delete"
                >
                  <Trash2 className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {!shots.length && (
        <p className="pro-boards-empty">
          文件夹为空。可在成片上选择“存入文件夹”。
        </p>
      )}
    </div>
  );
});
