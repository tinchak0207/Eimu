import type { CanvasNodeMetadata } from "@/lib/canvas/types";
import { deriveShotReference, serializeChipText, type ShotReferenceEntry } from "../ShotReferencePanel";
import type { CanvasEntityCandidate, CanvasReferenceCandidate } from "./prompt-panel-types";

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

export const SIZE_OPTIONS = [
  { value: "1:1", label: "1:1 方图" },
  { value: "4:3", label: "4:3 横向" },
  { value: "3:4", label: "3:4 纵向" },
  { value: "16:9", label: "16:9 宽幅" },
  { value: "9:16", label: "9:16 竖幅" },
];

export const COUNT_OPTIONS = [1, 2, 3, 4];

/** @ 只在行首或空白后触发；query 不含空白与第二个 @。 */
export const MENTION_PATTERN = /(^|\s)@([^\s@]*)$/;
export const MENTION_MENU_WIDTH = 224; // 对应 w-56，clamp 用
export const CHIP_TITLE_MAX = 8;

// 零宽字元（U+FEFF BOM / U+200B ZWSP）与 @侦测用 chip 占位符（U+FFFC OBJECT
// REPLACEMENT）。以 fromCharCode 构造，避免不可见字面量被编辑器/工具链吞掉。
export const ZERO_WIDTH_RE = new RegExp(`[${String.fromCharCode(0xfeff)}${String.fromCharCode(0x200b)}]`, "g");
export const CHIP_DETECTION_PLACEHOLDER = String.fromCharCode(0xfffc);

export function stripZeroWidth(value: string): string {
  return value.replace(ZERO_WIDTH_RE, "");
}

// ---------- contentEditable 纯 DOM 工具（不经 React 渲染，React 不管理输入框子树） ----------

/** chip 元素判定：带 data-node-id（上游图片）或 data-card-id（素材卡）的元素即原子引用 chip。 */
export function isChipElement(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && Boolean(node.dataset.nodeId || node.dataset.cardId);
}

/** 可忽略的文字节点（空字串或仅零宽字元）。 */
export function isIgnorableTextNode(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && stripZeroWidth(node.textContent || "") === "";
}

/**
 * 递回序列化 contentEditable 子树为纯文字：
 * chip 交由 chipText 转换；<br> 与块级（div/p，浏览器换行产物）转 \n。
 */
export function serializeChildren(root: Node, chipText: (chip: HTMLElement) => string): string {
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
export function serializeEditor(editor: HTMLElement, selectedIds: string[]): string {
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
export function detectionTextBeforeCaret(editor: HTMLElement): string {
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
export function createChipElement(cand: CanvasReferenceCandidate): HTMLSpanElement {
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
export function createEntityChipElement(cand: CanvasEntityCandidate): HTMLSpanElement {
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
export function chipBeforeCaret(editor: HTMLElement): HTMLElement | null {
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

export function previousChipSibling(node: Node): HTMLElement | null {
  let current: Node | null = node.previousSibling;
  while (current && isIgnorableTextNode(current)) current = current.previousSibling;
  return current && isChipElement(current) ? current : null;
}

/** 把 caret 放到元素内容末尾。 */
export function placeCaretAtEnd(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}
