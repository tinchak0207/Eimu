"use client";

// CanvasNodePromptPanel —— 節點內嵌可編輯生成面板。
//
// 每個節點下方展開，就地編輯 prompt / 模型 / 比例 / 數量，點「生成」後
// 結果作為相連子節點插回畫布。
//
// 誠實原則（2026-08-15 修正）：模型清單來自站上真實供給
// （PROVIDERS.image_tinchak.models + generationModel 顯示名），不再擺
// dall-e-3 / midjourney 這種站上根本不路由的假選項；生成按鈕旁標「约 N 币」
// 與扣費同源估價——花費喂到面前，暴君不用算帳。
//
// @引用（2026-08-16 升級，對標 infinite-canvas 的 @mention 體驗）：
// - 輸入框改為 contentEditable：行首或空白後鍵入「@」喚起懸浮候選選單，
//   錨定在 caret 像素位置（Range#getBoundingClientRect，換算畫布縮放後
//   絕對定位於面板內），↑↓ 導航、Enter/點擊選中、Esc 關閉、續鍵過濾標題。
// - 選中後插入原子 chip（contentEditable=false 的 inline span：16px 縮圖 +
//   標題截 8 字，藍底圓角，帶 data-node-id）；Backspace 在 chip 後緣整塊刪除。
// - chip 與「引用上游图片」縮圖列雙向同步：插入 chip 自動選取引用、chip
//   全部消失自動取消；點縮圖列亦同步輸入框內 chip 的插入/移除。
// - 生成時序列化：chip → `@图片N`（N = 該 chip 在 selectedReferenceIds 的
//   序號+1），其餘文字原樣；onGenerate 契約不變。
// - 貼上只取 text/plain；IME 組合輸入期間不解析 @ 選單。
//
// 素材卡 @引用（2026-09-24 擴充，WS3）：@ 選單加開第二組候選——項目鎖定的角色/場景/
// 風格/道具卡。選中插入紫色原子 chip（同幾何、異色票），生成時序列化成行內 token
// `@[角色:霍辞渊]`（與圖片 chip 的 `@图片N` 走同一個 serializeEditor 分派，靠 dataset.cardId
// 判定），讓「這一鏡要誰/哪個場景/用哪個道具」就地指名而不是靠整包前綴。
// 兩個 chip 系統共用既有物理參數/事件監聽/caret 量測邏輯（本輪對此零改動）。
// 編輯器下方另掛 ShotReferencePanel：純推導列出本鏡解析出的參考素材與未匹配 token。

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

/** 上游可引用資源（由宿主從連線圖算出）。 */
export interface CanvasReferenceCandidate {
  nodeId: string;
  title: string;
  previewUrl: string;
}

/** @ 可引用的素材卡候選（角色/場景/風格/道具）。 */
export interface CanvasEntityCandidate {
  cardId: string;
  name: string;
  kind: CharacterCardKind;
  /** 顯示用種類字（＝CHARACTER_CARD_KIND_LABEL[kind]）。 */
  kindLabel: string;
  /** 預覽縮圖（卡的第一張參考圖；無則空字串）。 */
  previewUrl: string;
}

/**
 * 純推導（本鏡參考素材清單，零請求零訂閱）：在既有 token/locked 推導上疊加第三種來源 shot。
 *
 * 優先序 `token` > `shot` > `locked`（同一張卡只出現一次）：
 *   1. `token`：正文真的用 `@[種類:名]` 引用了（人明寫的最強意圖）；
 *   2. `shot`：本鏡節點 metadata 三欄（character/scene/prop）已指定，且未被 token 引用；
 *   3. `locked`：候選卡裡既沒被引用、也沒被指定的其餘卡（純提示「有哪些沒用到」）。
 *
 * `shotEntityCardIds` 中不在 `candidates` 的 id 靜默跳過（候選已過作用域裁決，不在裡面＝不可用），
 * 避免出現沒名字的空條目。`shotEntityCardIds` 缺省／空 → 回傳結果與既有三來源推導逐位元相同。
 * token/locked 條目直接沿用 `deriveShotReference` 的產物（物件與順序不重算）；unresolvedTokens 逐字不動。
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
 * 純讀取：節點 metadata 三欄（character/scene/prop）的實體卡 id 聯集去重。
 * 宿主（CanvasEmbed）用它算出 `shotEntityCardIds` 供本面板；缺省／全空 → 空陣列。
 * 抽成模組級純函式以便直接行為斷言（CanvasEmbed 因 CSS import 無法在 node 測試內載入）。
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
  /** 上游相連圖片節點（@引用候選）；空陣列 = 不顯示引用列。 */
  referenceCandidates?: CanvasReferenceCandidate[];
  /** 已選為參考圖的節點 id。 */
  selectedReferenceIds?: string[];
  /** 切換某個引用的選取狀態。 */
  onToggleReference?: (referenceNodeId: string) => void;
  /** @ 可引用的素材卡（第二組候選）。 */
  entityCandidates?: CanvasEntityCandidate[];
  /** 已被行內引用的卡 id（與 prompt 內 token 雙向同步）。 */
  selectedEntityIds?: string[];
  /** 切換某張卡的引用狀態（插入/移除對應 token chip）。 */
  onToggleEntity?: (cardId: string) => void;
  /** 本鏡節點已指定的實體卡 id（真源＝節點 metadata 的三個卡 id 欄；供清單的 "shot" 來源）。 */
  shotEntityCardIds?: string[];
  /** 生成中點「停止」時回呼；未提供則 isRunning 只顯示轉圈段、不顯示停止鈕。 */
  onStop?: () => void;
  /** 開啟提示詞庫；未提供則不渲染入口按鈕。 */
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

/** @ 只在行首或空白後觸發；query 不含空白與第二個 @。 */
const MENTION_PATTERN = /(^|\s)@([^\s@]*)$/;
const MENTION_MENU_WIDTH = 224; // 對應 w-56，clamp 用
const CHIP_TITLE_MAX = 8;

// 零寬字元（U+FEFF BOM / U+200B ZWSP）與 @偵測用 chip 佔位符（U+FFFC OBJECT
// REPLACEMENT）。以 fromCharCode 構造，避免不可見字面量被編輯器/工具鏈吞掉。
const ZERO_WIDTH_RE = new RegExp(`[${String.fromCharCode(0xfeff)}${String.fromCharCode(0x200b)}]`, "g");
const CHIP_DETECTION_PLACEHOLDER = String.fromCharCode(0xfffc);

function stripZeroWidth(value: string): string {
  return value.replace(ZERO_WIDTH_RE, "");
}

interface MentionState {
  query: string;
  /** 面板（root）座標系內的選單絕對定位（已換算畫布縮放）。 */
  left: number;
  top: number;
}

/** 站上真實圖片模型清單（濾掉影片模型）。 */
function useImageModelOptions(): { id: string; label: string }[] {
  return useMemo(
    () =>
      PROVIDERS.image_tinchak.models
        .filter((id) => generationModel(id)?.kind !== "video")
        .map((id) => ({ id, label: generationModel(id)?.displayName ?? id })),
    [],
  );
}

// ---------- contentEditable 純 DOM 工具（不經 React 渲染，React 不管理輸入框子樹） ----------

/** chip 元素判定：帶 data-node-id（上游圖片）或 data-card-id（素材卡）的元素即原子引用 chip。 */
function isChipElement(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && Boolean(node.dataset.nodeId || node.dataset.cardId);
}

/** 可忽略的文字節點（空字串或僅零寬字元）。 */
function isIgnorableTextNode(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && stripZeroWidth(node.textContent || "") === "";
}

/**
 * 遞迴序列化 contentEditable 子樹為純文字：
 * chip 交由 chipText 轉換；<br> 與塊級（div/p，瀏覽器換行產物）轉 \n。
 */
function serializeChildren(root: Node, chipText: (chip: HTMLElement) => string): string {
  let out = "";
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent || "";
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    // chip 兩種：data-node-id（圖片）/ data-card-id（素材卡）——都用 chipText 轉換。
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
 * 生成用序列化：chip → `@图片N`（N = 在 selectedReferenceIds 的序號+1；不在清單則退回標題）。
 * 素材卡 chip（帶 data-card-id）改走 `@[種類:名稱]` 行內 token——分派在
 * serializeChipText 內靠 dataset.cardId 判定（純函式，見 ShotReferencePanel）。
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

/** @偵測用：取 caret 之前的文字；chip 以 U+FFFC 佔位，避免其字面文字（含 @）干擾正則。 */
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

/** 建立原子 chip：contentEditable=false inline span，16px 縮圖 + 標題截 8 字，藍底圓角。 */
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
 * 建立素材卡原子 chip：幾何與 createChipElement 逐字相同（逐字複製，不精簡——
 * 2026-08-25「模板旋轉木馬」教訓：每精簡一處既有物理參數＝埋一顆雷），
 * 只換色票（紫）並多一個 kindLabel 小字；data-card-id/-kind 供序列化與刪除對賬。
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

/** caret 是否貼在某個 chip 後緣（Backspace 應整塊刪除該 chip）。 */
function chipBeforeCaret(editor: HTMLElement): HTMLElement | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const { startContainer, startOffset } = range;
  if (!editor.contains(startContainer)) return null;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    if (startOffset > 0) return null; // caret 前仍有字元 → 走瀏覽器預設刪字
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

/** 把 caret 放到元素內容末尾。 */
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
  // 節點帶的模型若不在真實清單裡（歷史資料/影片模型），落回全局預設。
  const safeInitialModel =
    initialModel && modelOptions.some((m) => m.id === initialModel) ? initialModel : DEFAULT_IMAGE_MODEL_ID;
  // promptText 只作「可否生成」判斷；真正送出的文字在 handleGenerate 時從 DOM 現序列化。
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
  /** 上一輪輸入框內出現過的 chip id 集合，供刪除對賬（chip 消失 → 取消選取）。 */
  const prevChipIdsRef = useRef<Set<string>>(new Set());
  /** 上一輪輸入框內出現過的素材卡 id 集合，供刪除對賬（chip 消失 → 取消引用）。 */
  const prevEntityChipIdsRef = useRef<Set<string>>(new Set());

  // 首掛載灌入 initialPrompt（純文字；歷史 prompt 不回填 chip）。
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || initializedRef.current) return;
    initializedRef.current = true;
    if (initialPrompt) editor.textContent = initialPrompt;
  }, [initialPrompt]);

  // 卸載時清掉 blur 延時。
  useEffect(() => () => {
    if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
  }, []);

  // 鍵盤導航時把高亮項滾進可視區。
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, mention]);

  // 估價與扣費同源（imageGenerationCoins → generationCoins → admin 覆寫層）。
  const estimatedCoins = useMemo(() => {
    try {
      const per = imageGenerationCoins(model, "fast");
      return Number.isFinite(per) ? Math.round(per * count * 100) / 100 : null;
    } catch {
      return null;
    }
  }, [model, count]);

  const modelLabel = modelOptions.find((m) => m.id === model)?.label ?? model;

  // @ 候選：續鍵入過濾（兩組共用）；攤平成單一連續索引序列（↑↓ 跨組）。
  const mentionRows = useMemo(
    () => (mention ? buildMentionRows(referenceCandidates, entityCandidates, mention.query) : []),
    [mention, referenceCandidates, entityCandidates],
  );

  // 本鏡參考素材解析（純推導，零請求零訂閱）：token 命中 / 本鏡已指定 / 鎖定未引用 / 未匹配 token。
  const shotReference = useMemo(
    () => deriveShotReferenceEntries(promptText, entityCandidates, shotEntityCardIds),
    [promptText, entityCandidates, shotEntityCardIds],
  );

  const closeMention = () => {
    setMention(null);
    setActiveIndex(0);
  };

  /** 解析 caret 前文字，決定 @ 選單開/關與錨點（Range#getBoundingClientRect → 面板座標）。 */
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
    // 空行/空編輯器的 collapsed Range 會量出零矩形，退回輸入框外框。
    const anchorRect = anchor ?? editor.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    // 畫布可能整體 transform:scale：getBoundingClientRect 是縮放後座標，
    // 面板內 absolute 定位吃版面座標，需除以縮放比。
    const scale = root.offsetWidth > 0 ? rootRect.width / root.offsetWidth : 1;
    const left = (anchorRect.left - rootRect.left) / scale;
    const top = (anchorRect.bottom - rootRect.top) / scale + 6;
    const maxLeft = Math.max(8, root.offsetWidth - MENTION_MENU_WIDTH - 8);
    setMention({ query: match[2], left: Math.min(Math.max(left, 8), maxLeft), top });
    setActiveIndex(0);
  };

  /**
   * 每次內容變更後的統一同步：
   * 1) :empty 佔位符正規化（全刪後殘留 <br> 會令 :empty 失效）；
   * 2) chip 刪除對賬——上輪存在、這輪消失且仍在已選清單 → onToggleReference 取消；
   *    素材卡 chip 同構對賬 → onToggleEntity 取消引用；
   * 3) 更新 promptText；4) 重算 @ 選單。
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

  /** 在 caret（或末尾）插入 chip + 尾隨空格。純 DOM 操作，呼叫方負責後續 syncFromEditor。 */
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
   * 在 caret（或末尾）插入素材卡 chip + 尾隨空格——與 insertChipDom 逐句同構
   * （同一套 caret 定位/接續/回落末尾邏輯，只是 chip 工廠換成紫色卡片 chip）。
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

  /** 刪除 caret 前的 `@query` 觸發文字（選中候選後替換成 chip）。 */
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
    if (range.startOffset < len) return; // @query 跨節點的罕見情況：放棄刪字，只插 chip
    range.setStart(range.startContainer, range.startOffset - len);
    range.deleteContents();
  };

  /** @ 選單選中：刪 @query → 插 chip → 同步 → 未選中則選取該引用。 */
  const insertReference = (cand: CanvasReferenceCandidate) => {
    removeMentionTextBeforeCaret();
    insertChipDom(cand);
    closeMention();
    syncFromEditor();
    if (!selectedReferenceIds.includes(cand.nodeId)) onToggleReference?.(cand.nodeId);
  };

  /** @ 選單選中（素材卡）：刪 @query → 插卡 chip → 同步 → 未引用則標記引用該卡。 */
  const insertEntityReference = (cand: CanvasEntityCandidate) => {
    removeMentionTextBeforeCaret();
    insertEntityChipDom(cand);
    closeMention();
    syncFromEditor();
    if (!selectedEntityIds.includes(cand.cardId)) onToggleEntity?.(cand.cardId);
  };

  /** 縮圖列雙入口：toggle 選取並同步輸入框 chip 插入/移除。 */
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
          // 順帶吃掉 chip 尾隨的一個空格，避免殘留連續空白。
          const next = el.nextSibling;
          if (next && next.nodeType === Node.TEXT_NODE && (next.textContent || "").startsWith(" ")) {
            next.textContent = (next.textContent || "").slice(1);
          }
          el.remove();
        });
        // 對賬會自動 onToggleReference 取消，這裡不再手動切換，避免雙重 toggle。
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
    // 鍵盤事件不冒泡到畫布（避免 Backspace/Delete 誤觸節點刪除等畫布快捷鍵）。
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
        // 兩組候選共用同一個攤平索引：按列所屬組取回原候選再分派插入。
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
    // caret 可能移動（方向鍵/Home/End），下一幀重算 @ 選單狀態與錨點。
    requestAnimationFrame(syncMention);
  };

  /** 貼上只取 text/plain 純文字，不吃富文本。 */
  const handleEditorPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const editor = editorRef.current;
    if (!editor) return;
    // execCommand 雖標記棄用，但對 contentEditable 插字仍最穩且保留原生 undo；
    // 成功時會觸發 input 事件 → onInput 自然同步。
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

  // 阻止事件冒泡到畫布
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
        {/* @引用：上游圖片縮圖 chips（自動編號；與輸入框內 chip 雙向同步） */}
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
                    // preventDefault 保住輸入框焦點與 caret，chip 才能插在游標處。
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

        {/* 編輯區：contentEditable，支持 @mention 原子 chip；React 不管理其子樹 */}
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
              // 佔位符：contentEditable 用 :empty::before 呈現（syncFromEditor 會清掉殘留 <br> 保住 :empty）。
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
              // 延時關閉，讓選單項的 click 先落地。
              if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
              blurTimerRef.current = window.setTimeout(closeMention, 120);
            }}
          />
        </div>

        {/* 本镜参考素材：純推導（token 命中 / 鎖定未引用 / 未匹配 token），零空殼 */}
        <ShotReferencePanel entries={shotReference.entries} unresolvedTokens={shotReference.unresolvedTokens} />

        {/* 參數與設置 */}
        <div className="border-t px-3 py-2">
          <div className="flex items-center gap-2">
            {/* 快速參數列 */}
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

            {/* 提示詞庫入口（宿主提供 onOpenPromptLibrary 才渲染） */}
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

          {/* 展開的進階參數 */}
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

        {/* 生成按鈕（帶與扣費同源的估價；算不出就不顯示，不騙 0）；
            生成中拆兩段：左段轉圈、右段紅色停止（onStop 存在才顯示） */}
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

      {/* @ 候選懸浮選單：絕對定位於面板內，錨定 caret 像素位置；
          兩組候選（图片 / 素材卡）共用同一個攤平索引序列，組標題在組邊界插入 */}
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
                    // preventDefault 避免輸入框失焦（blur 會延時關閉選單）。
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
                  // preventDefault 避免輸入框失焦（blur 會延時關閉選單）。
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
