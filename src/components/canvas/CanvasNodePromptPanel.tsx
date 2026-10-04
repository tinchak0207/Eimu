"use client";

// CanvasNodePromptPanel —— 节点内嵌可编辑生成面板。
//
// 每个节点下方展开，就地编辑 prompt / 模型 / 比例 / 数量，点「生成」后
// 结果作为相连子节点插回画布。
//
// 诚实原则（2026-08-15 修正）：模型清单来自站上真实供给
// （PROVIDERS.image_tinchak.models + generationModel 显示名），不再摆
// dall-e-3 / midjourney 这种站上根本不路由的假选项；生成按钮旁标「约 N 币」
// 与扣费同源估价——花费喂到面前，暴君不用算帐。
//
// @引用（2026-08-16 升级，对标 infinite-canvas 的 @mention 体验）：
// - 输入框改为 contentEditable：行首或空白后键入「@」唤起悬浮候选选单，
//   锚定在 caret 像素位置（Range#getBoundingClientRect，换算画布缩放后
//   绝对定位于面板内），↑↓ 导航、Enter/点击选中、Esc 关闭、续键过滤标题。
// - 选中后插入原子 chip（contentEditable=false 的 inline span：16px 缩图 +
//   标题截 8 字，蓝底圆角，带 data-node-id）；Backspace 在 chip 后缘整块删除。
// - chip 与「引用上游图片」缩图列双向同步：插入 chip 自动选取引用、chip
//   全部消失自动取消；点缩图列亦同步输入框内 chip 的插入/移除。
// - 生成时序列化：chip → `@图片N`（N = 该 chip 在 selectedReferenceIds 的
//   序号+1），其余文字原样；onGenerate 契约不变。
// - 贴上只取 text/plain；IME 组合输入期间不解析 @ 选单。
//
// 素材卡 @引用（2026-09-24 扩充，WS3）：@ 选单加开第二组候选——项目锁定的角色/场景/
// 风格/道具卡。选中插入紫色原子 chip（同几何、异色票），生成时序列化成行内 token
// `@[角色:霍辞渊]`（与图片 chip 的 `@图片N` 走同一个 serializeEditor 分派，靠 dataset.cardId
// 判定），让「这一镜要谁/哪个场景/用哪个道具」就地指名而不是靠整包前缀。
// 两个 chip 系统共用既有物理参数/事件监听/caret 量测逻辑（本轮对此零改动）。
// 编辑器下方另挂 ShotReferencePanel：纯推导列出本镜解析出的参考素材与未匹配 token。

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Bot, Settings2, X } from "lucide-react";
import { PROVIDERS, imageGenerationCoins } from "@/lib/provider-config";
import { generationModel } from "@/lib/generation-model-catalog";
import { DEFAULT_IMAGE_MODEL_ID } from "@/lib/image-model-ids.js";
import type { CharacterCardKind } from "@/lib/character-cards";
import type { CanvasNodeMetadata } from "@/lib/canvas/types";
import {
  ShotReferencePanel,
  buildMentionRows,
  deriveShotReference,
  serializeChipText,
  type ShotReferenceEntry,
} from "./ShotReferencePanel";
import { cn } from "@/lib/utils";

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

/**
 * 纯推导（本镜参考素材清单，零请求零订阅）：在既有 token/locked 推导上叠加第三种来源 shot。
 *
 * 优先序 `token` > `shot` > `locked`（同一张卡只出现一次）：
 *   1. `token`：正文真的用 `@[种类:名]` 引用了（人明写的最强意图）；
 *   2. `shot`：本镜节点 metadata 三栏（character/scene/prop）已指定，且未被 token 引用；
 *   3. `locked`：候选卡里既没被引用、也没被指定的其余卡（纯提示「有哪些没用到」）。
 *
 * `shotEntityCardIds` 中不在 `candidates` 的 id 静默跳过（候选已过作用域裁决，不在里面＝不可用），
 * 避免出现没名字的空条目。`shotEntityCardIds` 缺省／空 → 回传结果与既有三来源推导逐位元相同。
 * token/locked 条目直接沿用 `deriveShotReference` 的产物（物件与顺序不重算）；unresolvedTokens 逐字不动。
 */
export function deriveShotReferenceEntries(
  promptText: string,
  candidates: readonly CanvasEntityCandidate[],
  shotEntityCardIds?: readonly string[],
): { entries: ShotReferenceEntry[]; unresolvedTokens: string[] } {
  const base = deriveShotReference(promptText, candidates);
  const byCardId = new Map(candidates.map((cand) => [cand.cardId, cand]));
  const cardIdOf = (entry: ShotReferenceEntry) => entry.key.slice(entry.key.indexOf(":") + 1);

  const tokenEntries: ShotReferenceEntry[] = [];
  const lockedEntries: ShotReferenceEntry[] = [];
  const usedCardIds = new Set<string>();
  for (const entry of base.entries) {
    if (entry.source === "token") {
      usedCardIds.add(cardIdOf(entry));
      tokenEntries.push(entry);
    } else if (entry.source === "locked") {
      lockedEntries.push(entry);
    }
  }

  const shotEntries: ShotReferenceEntry[] = [];
  const shotCardIds = new Set<string>();
  for (const cardId of shotEntityCardIds ?? []) {
    if (!cardId || usedCardIds.has(cardId) || shotCardIds.has(cardId)) continue;
    const cand = byCardId.get(cardId);
    if (!cand) continue;
    shotCardIds.add(cardId);
    shotEntries.push({
      key: `shot:${cardId}`,
      kindLabel: cand.kindLabel,
      name: cand.name,
      previewUrl: cand.previewUrl,
      source: "shot",
    });
  }

  return {
    entries: [
      ...tokenEntries,
      ...shotEntries,
      ...lockedEntries.filter((entry) => !shotCardIds.has(cardIdOf(entry))),
    ],
    unresolvedTokens: base.unresolvedTokens,
  };
}

/**
 * 纯读取：节点 metadata 三栏（character/scene/prop）的实体卡 id 联集去重。
 * 宿主（CanvasEmbed）用它算出 `shotEntityCardIds` 供本面板；缺省／全空 → 空阵列。
 * 抽成模组级纯函式以便直接行为断言（CanvasEmbed 因 CSS import 无法在 node 测试内载入）。
 */
export function shotEntityCardIdsFromMetadata(
  metadata: Pick<CanvasNodeMetadata, "characterCardIds" | "sceneCardIds" | "propCardIds"> | undefined,
): string[] {
  return [
    ...new Set(
      [
        ...(metadata?.characterCardIds ?? []),
        ...(metadata?.sceneCardIds ?? []),
        ...(metadata?.propCardIds ?? []),
      ].filter(Boolean),
    ),
  ];
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

const SIZE_OPTIONS = [
  { value: "1:1", label: "1:1 方图" },
  { value: "4:3", label: "4:3 横向" },
  { value: "3:4", label: "3:4 纵向" },
  { value: "16:9", label: "16:9 宽幅" },
  { value: "9:16", label: "9:16 竖幅" },
];

const COUNT_OPTIONS = [1, 2, 3, 4];

/** @ 只在行首或空白后触发；query 不含空白与第二个 @。 */
const MENTION_PATTERN = /(^|\s)@([^\s@]*)$/;
const MENTION_MENU_WIDTH = 224; // 对应 w-56，clamp 用
const CHIP_TITLE_MAX = 8;

// 零宽字元（U+FEFF BOM / U+200B ZWSP）与 @侦测用 chip 占位符（U+FFFC OBJECT
// REPLACEMENT）。以 fromCharCode 构造，避免不可见字面量被编辑器/工具链吞掉。
const ZERO_WIDTH_RE = new RegExp(`[${String.fromCharCode(0xfeff)}${String.fromCharCode(0x200b)}]`, "g");
const CHIP_DETECTION_PLACEHOLDER = String.fromCharCode(0xfffc);

function stripZeroWidth(value: string): string {
  return value.replace(ZERO_WIDTH_RE, "");
}

interface MentionState {
  query: string;
  /** 面板（root）座标系内的选单绝对定位（已换算画布缩放）。 */
  left: number;
  top: number;
}

/** 站上真实图片模型清单（滤掉影片模型）。 */
function useImageModelOptions(): { id: string; label: string }[] {
  return useMemo(
    () =>
      PROVIDERS.image_tinchak.models
        .filter((id) => generationModel(id)?.kind !== "video")
        .map((id) => ({ id, label: generationModel(id)?.displayName ?? id })),
    [],
  );
}

// ---------- contentEditable 纯 DOM 工具（不经 React 渲染，React 不管理输入框子树） ----------

/** chip 元素判定：带 data-node-id（上游图片）或 data-card-id（素材卡）的元素即原子引用 chip。 */
function isChipElement(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && Boolean(node.dataset.nodeId || node.dataset.cardId);
}

/** 可忽略的文字节点（空字串或仅零宽字元）。 */
function isIgnorableTextNode(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && stripZeroWidth(node.textContent || "") === "";
}

/**
 * 递回序列化 contentEditable 子树为纯文字：
 * chip 交由 chipText 转换；<br> 与块级（div/p，浏览器换行产物）转 \n。
 */
function serializeChildren(root: Node, chipText: (chip: HTMLElement) => string): string {
  let out = "";
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent || "";
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    // chip 两种：data-node-id（图片）/ data-card-id（素材卡）——都用 chipText 转换。
    if (node.dataset.nodeId || node.dataset.cardId) {
      out += chipText(node);
      return;
    }
    if (node.tagName === "BR") {
      out += "\n";
      return;
    }
    const isBlock = node.tagName === "DIV" || node.tagName === "P";
    if (isBlock && out && !out.endsWith("\n")) out += "\n";
    out += serializeChildren(node, chipText);
  });
  return out;
}

/**
 * 生成用序列化：chip → `@图片N`（N = 在 selectedReferenceIds 的序号+1；不在清单则退回标题）。
 * 素材卡 chip（带 data-card-id）改走 `@[种类:名称]` 行内 token——分派在
 * serializeChipText 内靠 dataset.cardId 判定（纯函式，见 ShotReferencePanel）。
 */
function serializeEditor(editor: HTMLElement, selectedIds: string[]): string {
  return stripZeroWidth(
    serializeChildren(editor, (chip) =>
      serializeChipText(
        {
          nodeId: chip.dataset.nodeId,
          cardId: chip.dataset.cardId,
          cardKind: chip.dataset.cardKind,
          title: chip.dataset.title,
        },
        selectedIds,
      ),
    ),
  );
}

/** @侦测用：取 caret 之前的文字；chip 以 U+FFFC 占位，避免其字面文字（含 @）干扰正则。 */
function detectionTextBeforeCaret(editor: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return "";
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return "";
  const pre = document.createRange();
  pre.selectNodeContents(editor);
  pre.setEnd(range.startContainer, range.startOffset);
  return stripZeroWidth(serializeChildren(pre.cloneContents(), () => CHIP_DETECTION_PLACEHOLDER));
}

/** 建立原子 chip：contentEditable=false inline span，16px 缩图 + 标题截 8 字，蓝底圆角。 */
function createChipElement(cand: CanvasReferenceCandidate): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.nodeId = cand.nodeId;
  chip.dataset.title = cand.title;
  chip.title = cand.title;
  chip.className =
    "mx-0.5 inline-flex max-w-[140px] select-none items-center gap-1 rounded-md bg-ios-blue/15 px-1.5 py-0.5 align-middle text-xs font-medium text-ios-blue";
  if (cand.previewUrl) {
    const img = document.createElement("img");
    img.src = cand.previewUrl;
    img.alt = cand.title;
    img.draggable = false;
    img.className = "h-4 w-4 shrink-0 rounded-[3px] object-cover";
    chip.appendChild(img);
  }
  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = cand.title.length > CHIP_TITLE_MAX ? `${cand.title.slice(0, CHIP_TITLE_MAX)}…` : cand.title;
  chip.appendChild(label);
  return chip;
}

/**
 * 建立素材卡原子 chip：几何与 createChipElement 逐字相同（逐字复制，不精简——
 * 2026-08-25「模板旋转木马」教训：每精简一处既有物理参数＝埋一颗雷），
 * 只换色票（紫）并多一个 kindLabel 小字；data-card-id/-kind 供序列化与删除对账。
 */
function createEntityChipElement(cand: CanvasEntityCandidate): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.cardId = cand.cardId;
  chip.dataset.cardKind = cand.kind;
  chip.dataset.title = cand.name;
  chip.title = `${cand.kindLabel}:${cand.name}`;
  chip.className =
    "mx-0.5 inline-flex max-w-[140px] select-none items-center gap-1 rounded-md bg-ios-purple/15 px-1.5 py-0.5 align-middle text-xs font-medium text-ios-purple";
  if (cand.previewUrl) {
    const img = document.createElement("img");
    img.src = cand.previewUrl;
    img.alt = cand.name;
    img.draggable = false;
    img.className = "h-4 w-4 shrink-0 rounded-[3px] object-cover";
    chip.appendChild(img);
  }
  const kind = document.createElement("span");
  kind.className = "shrink-0 opacity-80";
  kind.textContent = cand.kindLabel;
  chip.appendChild(kind);
  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = cand.name.length > CHIP_TITLE_MAX ? `${cand.name.slice(0, CHIP_TITLE_MAX)}…` : cand.name;
  chip.appendChild(label);
  return chip;
}

/** caret 是否贴在某个 chip 后缘（Backspace 应整块删除该 chip）。 */
function chipBeforeCaret(editor: HTMLElement): HTMLElement | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const { startContainer, startOffset } = range;
  if (!editor.contains(startContainer)) return null;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    if (startOffset > 0) return null; // caret 前仍有字元 → 走浏览器预设删字
    return previousChipSibling(startContainer);
  }
  if (startContainer instanceof HTMLElement) {
    if (startOffset === 0) return null;
    const before = startContainer.childNodes[startOffset - 1];
    if (!before) return null;
    if (isChipElement(before)) return before;
    if (isIgnorableTextNode(before)) return previousChipSibling(before);
    return null;
  }
  return null;
}

function previousChipSibling(node: Node): HTMLElement | null {
  let current: Node | null = node.previousSibling;
  while (current && isIgnorableTextNode(current)) current = current.previousSibling;
  return current && isChipElement(current) ? current : null;
}

/** 把 caret 放到元素内容末尾。 */
function placeCaretAtEnd(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

export function CanvasNodePromptPanel({
  nodeId,
  initialPrompt = "",
  initialModel,
  initialSize = "1:1",
  initialCount = 1,
  isRunning,
  onClose,
  onGenerate,
  referenceCandidates = [],
  selectedReferenceIds = [],
  onToggleReference,
  entityCandidates = [],
  selectedEntityIds = [],
  onToggleEntity,
  shotEntityCardIds,
  onStop,
  onOpenPromptLibrary,
}: CanvasNodePromptPanelProps) {
  const modelOptions = useImageModelOptions();
  // 节点带的模型若不在真实清单里（历史资料/影片模型），落回全局预设。
  const safeInitialModel =
    initialModel && modelOptions.some((m) => m.id === initialModel) ? initialModel : DEFAULT_IMAGE_MODEL_ID;
  // promptText 只作「可否生成」判断；真正送出的文字在 handleGenerate 时从 DOM 现序列化。
  const [promptText, setPromptText] = useState(initialPrompt);
  const [model, setModel] = useState(safeInitialModel);
  const [size, setSize] = useState(initialSize);
  const [count, setCount] = useState(initialCount);
  const [showSettings, setShowSettings] = useState(false);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  const initializedRef = useRef(false);
  const blurTimerRef = useRef<number | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  /** 上一轮输入框内出现过的 chip id 集合，供删除对账（chip 消失 → 取消选取）。 */
  const prevChipIdsRef = useRef<Set<string>>(new Set());
  /** 上一轮输入框内出现过的素材卡 id 集合，供删除对账（chip 消失 → 取消引用）。 */
  const prevEntityChipIdsRef = useRef<Set<string>>(new Set());

  // 首挂载灌入 initialPrompt（纯文字；历史 prompt 不回填 chip）。
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || initializedRef.current) return;
    initializedRef.current = true;
    if (initialPrompt) editor.textContent = initialPrompt;
  }, [initialPrompt]);

  // 卸载时清掉 blur 延时。
  useEffect(() => () => {
    if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
  }, []);

  // 键盘导航时把高亮项滚进可视区。
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, mention]);

  // 估价与扣费同源（imageGenerationCoins → generationCoins → admin 覆写层）。
  const estimatedCoins = useMemo(() => {
    try {
      const per = imageGenerationCoins(model, "fast");
      return Number.isFinite(per) ? Math.round(per * count * 100) / 100 : null;
    } catch {
      return null;
    }
  }, [model, count]);

  const modelLabel = modelOptions.find((m) => m.id === model)?.label ?? model;

  // @ 候选：续键入过滤（两组共用）；摊平成单一连续索引序列（↑↓ 跨组）。
  const mentionRows = useMemo(
    () => (mention ? buildMentionRows(referenceCandidates, entityCandidates, mention.query) : []),
    [mention, referenceCandidates, entityCandidates],
  );

  // 本镜参考素材解析（纯推导，零请求零订阅）：token 命中 / 本镜已指定 / 锁定未引用 / 未匹配 token。
  const shotReference = useMemo(
    () => deriveShotReferenceEntries(promptText, entityCandidates, shotEntityCardIds),
    [promptText, entityCandidates, shotEntityCardIds],
  );

  const closeMention = () => {
    setMention(null);
    setActiveIndex(0);
  };

  /** 解析 caret 前文字，决定 @ 选单开/关与锚点（Range#getBoundingClientRect → 面板座标）。 */
  const syncMention = () => {
    const editor = editorRef.current;
    const root = rootRef.current;
    if (!editor || !root) return;
    if (composingRef.current || (referenceCandidates.length === 0 && entityCandidates.length === 0)) {
      setMention(null);
      return;
    }
    const before = detectionTextBeforeCaret(editor);
    const match = MENTION_PATTERN.exec(before);
    if (!match) {
      setMention(null);
      return;
    }
    let anchor: DOMRect | null = null;
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const caret = selection.getRangeAt(0).cloneRange();
      caret.collapse(true);
      const rect = caret.getBoundingClientRect();
      if (rect.width || rect.height || rect.left || rect.top) anchor = rect;
    }
    // 空行/空编辑器的 collapsed Range 会量出零矩形，退回输入框外框。
    const anchorRect = anchor ?? editor.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    // 画布可能整体 transform:scale：getBoundingClientRect 是缩放后座标，
    // 面板内 absolute 定位吃版面座标，需除以缩放比。
    const scale = root.offsetWidth > 0 ? rootRect.width / root.offsetWidth : 1;
    const left = (anchorRect.left - rootRect.left) / scale;
    const top = (anchorRect.bottom - rootRect.top) / scale + 6;
    const maxLeft = Math.max(8, root.offsetWidth - MENTION_MENU_WIDTH - 8);
    setMention({ query: match[2], left: Math.min(Math.max(left, 8), maxLeft), top });
    setActiveIndex(0);
  };

  /**
   * 每次内容变更后的统一同步：
   * 1) :empty 占位符正规化（全删后残留 <br> 会令 :empty 失效）；
   * 2) chip 删除对账——上轮存在、这轮消失且仍在已选清单 → onToggleReference 取消；
   *    素材卡 chip 同构对账 → onToggleEntity 取消引用；
   * 3) 更新 promptText；4) 重算 @ 选单。
   */
  const syncFromEditor = () => {
    const editor = editorRef.current;
    if (!editor) return;
    if (
      !editor.textContent &&
      !editor.querySelector("[data-node-id],[data-card-id]") &&
      editor.childNodes.length > 0
    ) {
      editor.textContent = "";
      if (document.activeElement === editor) placeCaretAtEnd(editor);
    }
    const currentChipIds = new Set<string>();
    editor.querySelectorAll<HTMLElement>("[data-node-id]").forEach((el) => {
      if (el.dataset.nodeId) currentChipIds.add(el.dataset.nodeId);
    });
    prevChipIdsRef.current.forEach((id) => {
      if (!currentChipIds.has(id) && selectedReferenceIds.includes(id)) onToggleReference?.(id);
    });
    prevChipIdsRef.current = currentChipIds;
    const currentEntityIds = new Set<string>();
    editor.querySelectorAll<HTMLElement>("[data-card-id]").forEach((el) => {
      if (el.dataset.cardId) currentEntityIds.add(el.dataset.cardId);
    });
    prevEntityChipIdsRef.current.forEach((id) => {
      if (!currentEntityIds.has(id) && selectedEntityIds.includes(id)) onToggleEntity?.(id);
    });
    prevEntityChipIdsRef.current = currentEntityIds;
    setPromptText(serializeEditor(editor, selectedReferenceIds));
    syncMention();
  };

  /** 在 caret（或末尾）插入 chip + 尾随空格。纯 DOM 操作，呼叫方负责后续 syncFromEditor。 */
  const insertChipDom = (cand: CanvasReferenceCandidate) => {
    const editor = editorRef.current;
    if (!editor) return;
    const chip = createChipElement(cand);
    const space = document.createTextNode(" ");
    const selection = window.getSelection();
    const range =
      selection && selection.rangeCount > 0 && editor.contains(selection.getRangeAt(0).startContainer)
        ? selection.getRangeAt(0)
        : null;
    if (range) {
      range.deleteContents();
      range.insertNode(space);
      range.insertNode(chip);
      range.setStartAfter(space);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      editor.append(chip, space);
    }
  };

  /**
   * 在 caret（或末尾）插入素材卡 chip + 尾随空格——与 insertChipDom 逐句同构
   * （同一套 caret 定位/接续/回落末尾逻辑，只是 chip 工厂换成紫色卡片 chip）。
   */
  const insertEntityChipDom = (cand: CanvasEntityCandidate) => {
    const editor = editorRef.current;
    if (!editor) return;
    const chip = createEntityChipElement(cand);
    const space = document.createTextNode(" ");
    const selection = window.getSelection();
    const range =
      selection && selection.rangeCount > 0 && editor.contains(selection.getRangeAt(0).startContainer)
        ? selection.getRangeAt(0)
        : null;
    if (range) {
      range.deleteContents();
      range.insertNode(space);
      range.insertNode(chip);
      range.setStartAfter(space);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      editor.append(chip, space);
    }
  };

  /** 删除 caret 前的 `@query` 触发文字（选中候选后替换成 chip）。 */
  const removeMentionTextBeforeCaret = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE) return;
    const match = MENTION_PATTERN.exec(detectionTextBeforeCaret(editor));
    if (!match) return;
    const len = match[2].length + 1; // "@" + query
    if (range.startOffset < len) return; // @query 跨节点的罕见情况：放弃删字，只插 chip
    range.setStart(range.startContainer, range.startOffset - len);
    range.deleteContents();
  };

  /** @ 选单选中：删 @query → 插 chip → 同步 → 未选中则选取该引用。 */
  const insertReference = (cand: CanvasReferenceCandidate) => {
    removeMentionTextBeforeCaret();
    insertChipDom(cand);
    closeMention();
    syncFromEditor();
    if (!selectedReferenceIds.includes(cand.nodeId)) onToggleReference?.(cand.nodeId);
  };

  /** @ 选单选中（素材卡）：删 @query → 插卡 chip → 同步 → 未引用则标记引用该卡。 */
  const insertEntityReference = (cand: CanvasEntityCandidate) => {
    removeMentionTextBeforeCaret();
    insertEntityChipDom(cand);
    closeMention();
    syncFromEditor();
    if (!selectedEntityIds.includes(cand.cardId)) onToggleEntity?.(cand.cardId);
  };

  /** 缩图列双入口：toggle 选取并同步输入框 chip 插入/移除。 */
  const handleRowToggle = (cand: CanvasReferenceCandidate) => {
    const editor = editorRef.current;
    const active = selectedReferenceIds.includes(cand.nodeId);
    if (active) {
      const chips = editor
        ? Array.from(editor.querySelectorAll<HTMLElement>("[data-node-id]")).filter(
            (el) => el.dataset.nodeId === cand.nodeId,
          )
        : [];
      if (chips.length > 0) {
        chips.forEach((el) => {
          // 顺带吃掉 chip 尾随的一个空格，避免残留连续空白。
          const next = el.nextSibling;
          if (next && next.nodeType === Node.TEXT_NODE && (next.textContent || "").startsWith(" ")) {
            next.textContent = (next.textContent || "").slice(1);
          }
          el.remove();
        });
        // 对账会自动 onToggleReference 取消，这里不再手动切换，避免双重 toggle。
        syncFromEditor();
      } else {
        onToggleReference?.(cand.nodeId);
      }
    } else {
      insertChipDom(cand);
      syncFromEditor();
      onToggleReference?.(cand.nodeId);
    }
  };

  const handleGenerate = () => {
    if (isRunning) return;
    const editor = editorRef.current;
    const text = (editor ? serializeEditor(editor, selectedReferenceIds) : promptText).trim();
    if (!text) return;
    onGenerate(nodeId, text, { model, size, quality: "standard", count });
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // 键盘事件不冒泡到画布（避免 Backspace/Delete 误触节点删除等画布快捷键）。
    e.stopPropagation();
    if (composingRef.current || e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleGenerate();
      return;
    }
    if (mention && mentionRows.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % mentionRows.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + mentionRows.length) % mentionRows.length);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const row = mentionRows[Math.min(activeIndex, mentionRows.length - 1)];
        // 两组候选共用同一个摊平索引：按列所属组取回原候选再分派插入。
        if (row.group === "image") insertReference(referenceCandidates[row.sourceIndex]);
        else insertEntityReference(entityCandidates[row.sourceIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMention();
        return;
      }
    }
    if (e.key === "Backspace") {
      const editor = editorRef.current;
      const chip = editor ? chipBeforeCaret(editor) : null;
      if (chip) {
        e.preventDefault();
        chip.remove();
        syncFromEditor();
        return;
      }
    }
    // caret 可能移动（方向键/Home/End），下一帧重算 @ 选单状态与锚点。
    requestAnimationFrame(syncMention);
  };

  /** 贴上只取 text/plain 纯文字，不吃富文本。 */
  const handleEditorPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const editor = editorRef.current;
    if (!editor) return;
    // execCommand 虽标记弃用，但对 contentEditable 插字仍最稳且保留原生 undo；
    // 成功时会触发 input 事件 → onInput 自然同步。
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0 && editor.contains(selection.getRangeAt(0).startContainer)) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        editor.append(document.createTextNode(text));
      }
      syncFromEditor();
    }
  };

  // 阻止事件冒泡到画布
  const stopPropagation = useCallback((e: React.MouseEvent | React.TouchEvent | React.PointerEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <div
      ref={rootRef}
      data-canvas-interactive
      className="absolute left-0 top-full z-50 mt-2 w-full min-w-[320px]"
      onMouseDown={stopPropagation}
      onTouchStart={stopPropagation}
      onPointerDown={stopPropagation}
      onClick={stopPropagation}
    >
      <div className="overflow-hidden rounded-xl lg-card">
        {/* @引用：上游图片缩图 chips（自动编号；与输入框内 chip 双向同步） */}
        {referenceCandidates.length > 0 && (
          <div className="border-b px-3 pb-2 pt-2.5">
            <p className="mb-1.5 text-ios-caption2 font-medium text-foreground/45">
              引用上游图片作参考（已选 {selectedReferenceIds.length}）
            </p>
            <div className="flex flex-wrap gap-1.5">
              {referenceCandidates.map((cand) => {
                const idx = selectedReferenceIds.indexOf(cand.nodeId);
                const active = idx >= 0;
                return (
                  <button
                    key={cand.nodeId}
                    type="button"
                    // preventDefault 保住输入框焦点与 caret，chip 才能插在游标处。
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleRowToggle(cand)}
                    title={cand.title}
                    aria-pressed={active}
                    className={cn(
                      "relative h-12 w-12 overflow-hidden rounded-lg border-2 transition-colors",
                      active ? "border-ios-blue" : "border-transparent opacity-70 hover:opacity-100",
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={cand.previewUrl} alt={cand.title} className="h-full w-full object-cover" draggable={false} />
                    {active && (
                      <span className="absolute left-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-ios-blue text-ios-caption2 font-semibold text-white">
                        {idx + 1}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 编辑区：contentEditable，支持 @mention 原子 chip；React 不管理其子树 */}
        <div className="p-3">
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label="提示词输入框"
            data-placeholder="编辑提示词… 输入 @ 引用图片或素材卡"
            className={cn(
              "max-h-[180px] min-h-[88px] w-full cursor-text overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-input bg-black/5 p-2.5 text-sm leading-relaxed outline-none transition-colors focus:border-ios-blue",
              // 占位符：contentEditable 用 :empty::before 呈现（syncFromEditor 会清掉残留 <br> 保住 :empty）。
              "empty:before:pointer-events-none empty:before:text-muted-foreground/70 empty:before:content-[attr(data-placeholder)]",
            )}
            onInput={() => {
              if (!composingRef.current) syncFromEditor();
            }}
            onKeyDown={handleEditorKeyDown}
            onPaste={handleEditorPaste}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              syncFromEditor();
            }}
            onBlur={() => {
              // 延时关闭，让选单项的 click 先落地。
              if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
              blurTimerRef.current = window.setTimeout(closeMention, 120);
            }}
          />
        </div>

        {/* 本镜参考素材：纯推导（token 命中 / 锁定未引用 / 未匹配 token），零空壳 */}
        <ShotReferencePanel entries={shotReference.entries} unresolvedTokens={shotReference.unresolvedTokens} />

        {/* 参数与设置 */}
        <div className="border-t px-3 py-2">
          <div className="flex items-center gap-2">
            {/* 快速参数列 */}
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="truncate rounded-md bg-black/5 px-2 py-1 text-xs font-medium text-muted-foreground">
                {modelLabel}
              </span>
              <span className="shrink-0 rounded-md bg-black/5 px-2 py-1 text-xs text-muted-foreground">
                {size}
              </span>
              <span className="shrink-0 rounded-md bg-black/5 px-2 py-1 text-xs text-muted-foreground">
                {count}张
              </span>
            </div>

            {/* 提示词库入口（宿主提供 onOpenPromptLibrary 才渲染） */}
            {onOpenPromptLibrary && (
              <button
                onClick={onOpenPromptLibrary}
                className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/45 hover:bg-black/5"
                title="提示词库"
              >
                <BookOpen className="h-3.5 w-3.5" />
              </button>
            )}

            <button
              onClick={() => setShowSettings(!showSettings)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/45 hover:bg-black/5"
              title="进阶参数"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>

            <button
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/45 hover:bg-black/5"
              title="关闭面板"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* 展开的进阶参数 */}
          {showSettings && (
            <div className="mt-2 grid grid-cols-3 gap-2 border-t pt-2">
              <div>
                <label className="mb-1 block text-ios-caption2 font-medium text-muted-foreground">
                  模型
                </label>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full rounded-md border border-input bg-black/5 px-2 py-1.5 text-xs outline-none"
                >
                  {modelOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-ios-caption2 font-medium text-muted-foreground">
                  比例
                </label>
                <select
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                  className="w-full rounded-md border border-input bg-black/5 px-2 py-1.5 text-xs outline-none"
                >
                  {SIZE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-ios-caption2 font-medium text-muted-foreground">
                  张数
                </label>
                <select
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                  className="w-full rounded-md border border-input bg-black/5 px-2 py-1.5 text-xs outline-none"
                >
                  {COUNT_OPTIONS.map((n) => (
                    <option key={n} value={n}>{n} 张</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        {/* 生成按钮（带与扣费同源的估价；算不出就不显示，不骗 0）；
            生成中拆两段：左段转圈、右段红色停止（onStop 存在才显示） */}
        <div className="border-t p-3">
          {isRunning ? (
            <div className="flex items-stretch gap-2">
              <button
                disabled
                className="flex flex-1 cursor-default items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground opacity-60"
              >
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                生成中…
              </button>
              {onStop && (
                <button
                  onClick={onStop}
                  className="shrink-0 rounded-lg bg-destructive px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
                >
                  停止
                </button>
              )}
            </div>
          ) : (
            <button
              onClick={handleGenerate}
              disabled={!promptText.trim()}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Bot className="h-4 w-4" />
              生成 {count} 张{estimatedCoins !== null ? ` · 约 ${estimatedCoins} 币` : ""}
            </button>
          )}
        </div>
      </div>

      {/* @ 候选悬浮选单：绝对定位于面板内，锚定 caret 像素位置；
          两组候选（图片 / 素材卡）共用同一个摊平索引序列，组标题在组边界插入 */}
      {mention && mentionRows.length > 0 && (
        <div
          role="listbox"
          aria-label="引用候选"
          className="absolute z-10 max-h-52 w-56 overflow-y-auto rounded-xl lg-sheet p-1"
          style={{ left: mention.left, top: mention.top }}
        >
          {mentionRows.map((row, index) => {
            const isActive = index === Math.min(activeIndex, mentionRows.length - 1);
            const header =
              index === 0 || mentionRows[index - 1].group !== row.group
                ? row.group === "image"
                  ? "图片"
                  : "素材卡"
                : null;
            if (row.group === "entity") {
              const cand = entityCandidates[row.sourceIndex];
              const referenced = selectedEntityIds.includes(cand.cardId);
              return (
                <Fragment key={`entity:${cand.cardId}`}>
                  {header ? (
                    <p className="px-2 pb-0.5 pt-1.5 text-ios-caption2 font-medium text-foreground/45">
                      {header}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    ref={isActive ? activeItemRef : undefined}
                    aria-selected={isActive}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
                      isActive ? "bg-ios-purple/10 text-ios-purple" : "text-muted-foreground hover:bg-black/5",
                    )}
                    // preventDefault 避免输入框失焦（blur 会延时关闭选单）。
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      insertEntityReference(cand);
                    }}
                  >
                    {cand.previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={cand.previewUrl}
                        alt={cand.name}
                        className="h-8 w-8 shrink-0 rounded-md object-cover"
                        draggable={false}
                      />
                    ) : (
                      <span className="h-8 w-8 shrink-0 rounded-md bg-black/5" />
                    )}
                    <span className="shrink-0 rounded-[4px] bg-ios-purple/15 px-1 font-medium">
                      {cand.kindLabel}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium" title={cand.name}>
                      {cand.name}
                    </span>
                    {referenced && (
                      <span className="shrink-0 rounded-full bg-ios-purple px-1.5 text-ios-caption2 font-semibold leading-4 text-white">
                        @
                      </span>
                    )}
                  </button>
                </Fragment>
              );
            }
            const cand = referenceCandidates[row.sourceIndex];
            const selectedIdx = selectedReferenceIds.indexOf(cand.nodeId);
            return (
              <Fragment key={`image:${cand.nodeId}`}>
                {header ? (
                  <p className="px-2 pb-0.5 pt-1.5 text-ios-caption2 font-medium text-foreground/45">
                    {header}
                  </p>
                ) : null}
                <button
                  ref={isActive ? activeItemRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
                    isActive
                      ? "bg-ios-blue/10 text-ios-blue"
                      : "text-muted-foreground hover:bg-black/5",
                  )}
                  // preventDefault 避免输入框失焦（blur 会延时关闭选单）。
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    insertReference(cand);
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={cand.previewUrl} alt={cand.title} className="h-8 w-8 shrink-0 rounded-md object-cover" draggable={false} />
                  <span className="min-w-0 flex-1 truncate font-medium" title={cand.title}>
                    {cand.title}
                  </span>
                  {selectedIdx >= 0 && (
                    <span className="shrink-0 rounded-full bg-ios-blue px-1.5 text-ios-caption2 font-semibold leading-4 text-white">
                      {selectedIdx + 1}
                    </span>
                  )}
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
