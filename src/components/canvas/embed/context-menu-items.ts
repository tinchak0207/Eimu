/**
 * context-menu-items —— CanvasEmbed 右鍵選單工廠（自 CanvasEmbed.tsx L1079-1228 機械搬遷，項目 id/label/shortcut 不變）。
 * 原 useMemo 閉包捕獲 20+ handlers；工廠化後顯式傳參，組件殼仍以原依賴陣列 memo 呼叫。
 */
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import { CanvasNodeType, type CanvasConnection, type CanvasNode, type CanvasPosition } from "@/lib/canvas/types";
import type { AlignMode } from "@/lib/canvas/interaction";
import type { CharacterCardKind } from "@/lib/character-cards";
import type { CanvasMenuItem } from "../CanvasContextMenu";
import { imageUrlOf, type CreateMenuState, type EditorState, type MenuState } from "./embed-helpers";

export interface CanvasEmbedMenuItemsInput {
  menu: MenuState | null;
  nodeById: Map<string, CanvasNode>;
  childToParent: Map<string, string>;
  visibleNodes: CanvasNode[];
  upscalingIds: Set<string>;
  selectedIdsRef: RefObject<Set<string>>;
  canvasStateRef: RefObject<UseCanvasChatReturn>;
  clipboardRef: RefObject<{ nodes: CanvasNode[]; connections: CanvasConnection[] } | null>;
  viewportSizeRef: RefObject<{ width: number; height: number }>;
  alignSelection: (mode: AlignMode) => void;
  distributeSelection: (axis: "h" | "v") => void;
  arrangeSelection: () => void;
  setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
  setCreateMenu: Dispatch<SetStateAction<CreateMenuState | null>>;
  pasteClipboard: (at?: CanvasPosition) => void;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setLibraryOpen: Dispatch<SetStateAction<boolean>>;
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
  setPromptPanelNodeId: Dispatch<SetStateAction<string | null>>;
  handleRerun: (nodeId: string) => Promise<void>;
  retryNode: (nodeId: string) => void;
  setConnecting: Dispatch<SetStateAction<{ sourceId: string; cursor: CanvasPosition | null } | null>>;
  copySelection: () => void;
  duplicateSelection: () => void;
  saveNodeAsCard: (node: CanvasNode, kind: CharacterCardKind) => Promise<void>;
  saveNodeToAssets: (nodeId: string) => Promise<void>;
  setEditor: Dispatch<SetStateAction<EditorState | null>>;
  upscaleNode: (nodeId: string) => Promise<void>;
  downloadNode: (nodeId: string) => Promise<void>;
  downloadBatch: (parentId: string) => Promise<void>;
  handleDeleteNode: (nodeId: string) => void;
  deleteSelected: () => void;
}

export function buildCanvasEmbedMenuItems({
  menu,
  nodeById,
  childToParent,
  visibleNodes,
  upscalingIds,
  selectedIdsRef,
  canvasStateRef,
  clipboardRef,
  viewportSizeRef,
  alignSelection,
  distributeSelection,
  arrangeSelection,
  setSelectedConnectionId,
  setCreateMenu,
  pasteClipboard,
  setSelectedIds,
  setLibraryOpen,
  setHelpOpen,
  setPromptPanelNodeId,
  handleRerun,
  retryNode,
  setConnecting,
  copySelection,
  duplicateSelection,
  saveNodeAsCard,
  saveNodeToAssets,
  setEditor,
  upscaleNode,
  downloadNode,
  downloadBatch,
  handleDeleteNode,
  deleteSelected,
}: CanvasEmbedMenuItemsInput): (CanvasMenuItem | "separator")[] {
  if (!menu) return [];
  const state = canvasStateRef.current;
  const sel = selectedIdsRef.current;
  const alignChildren: CanvasMenuItem[] = [
    { id: "align-left", label: "左对齐", onSelect: () => alignSelection("left") },
    { id: "align-right", label: "右对齐", onSelect: () => alignSelection("right") },
    { id: "align-top", label: "顶对齐", onSelect: () => alignSelection("top") },
    { id: "align-bottom", label: "底对齐", onSelect: () => alignSelection("bottom") },
    { id: "align-ch", label: "水平居中", onSelect: () => alignSelection("center-h") },
    { id: "align-cv", label: "垂直居中", onSelect: () => alignSelection("center-v") },
    { id: "dist-h", label: "水平均分", disabled: sel.size < 3, onSelect: () => distributeSelection("h") },
    { id: "dist-v", label: "垂直均分", disabled: sel.size < 3, onSelect: () => distributeSelection("v") },
    { id: "arrange", label: "网格整理", onSelect: () => arrangeSelection() },
  ];
  if (menu.targetConnectionId) {
    return [
      {
        id: "delete-connection",
        label: "删除连线",
        danger: true,
        shortcut: "Del",
        onSelect: () => {
          state.removeConnection(menu.targetConnectionId!);
          setSelectedConnectionId(null);
        },
      },
    ];
  }
  if (!menu.targetNodeId) {
    return [
      { id: "new-node", label: "新建节点…", onSelect: () => setCreateMenu({ position: menu.position, world: menu.world }) },
      { id: "paste", label: "粘贴", shortcut: "Ctrl+V", disabled: !clipboardRef.current?.nodes.length, onSelect: () => pasteClipboard(menu.world) },
      { id: "select-all", label: "全选", shortcut: "Ctrl+A", disabled: visibleNodes.length === 0, onSelect: () => setSelectedIds(new Set(visibleNodes.map((n) => n.id))) },
      ...(sel.size >= 2 ? ([{ id: "align", label: "对齐与排列", children: alignChildren }] as CanvasMenuItem[]) : []),
      "separator" as const,
      { id: "library", label: "提示词库 / 素材", onSelect: () => setLibraryOpen(true) },
      { id: "fit", label: "适应视图", onSelect: () => {
        const size = viewportSizeRef.current;
        if (size.width > 0) state.fitView(size.width, size.height);
      } },
      { id: "bg", label: "切换背景", onSelect: () => state.cycleBackground() },
      { id: "help", label: "快捷键帮助", onSelect: () => setHelpOpen(true) },
    ];
  }
  const node = nodeById.get(menu.targetNodeId);
  if (!node) return [];
  const url = imageUrlOf(node);
  const parentId = childToParent.get(node.id);
  const isWorkflowNode = !!(node.metadata?.workflow_id && node.metadata?.session_id);
  const items: (CanvasMenuItem | "separator")[] = [
    { id: "edit-prompt", label: "编辑提示词并生成", onSelect: () => setPromptPanelNodeId(node.id) },
    ...(isWorkflowNode ? ([{ id: "rerun", label: "重新生成（工作流）", onSelect: () => void handleRerun(node.id) }] as CanvasMenuItem[]) : []),
    ...(node.metadata?.status === "error" && node.metadata?.prompt
      ? ([{ id: "retry", label: "重试（沿用参数）", onSelect: () => retryNode(node.id) }] as CanvasMenuItem[])
      : []),
    { id: "connect", label: "连线到其他节点", onSelect: () => setConnecting({ sourceId: node.id, cursor: null }) },
    { id: "rename", label: "重命名", onSelect: () => {
      // 觸發節點內編輯：直接改 title 為當前值走 NodeView 雙擊路徑成本更高，
      // 這裡用 prompt() 太醜——選單觸發交給 NodeView 的雙擊；此項用瀏覽器原生輸入。
      const next = window.prompt("重命名节点", node.title);
      if (next && next.trim() && next.trim() !== node.title) state.renameNode(node.id, next.trim());
    } },
    "separator",
    { id: "copy", label: "复制", shortcut: "Ctrl+C", onSelect: copySelection },
    { id: "paste", label: "粘贴", shortcut: "Ctrl+V", disabled: !clipboardRef.current?.nodes.length, onSelect: () => pasteClipboard(menu.world) },
    { id: "duplicate", label: "创建副本", shortcut: "Ctrl+D", onSelect: duplicateSelection },
  ];
  if (node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Prompt) {
    items.push("separator");
    items.push({ id: "font-up", label: "放大字号", onSelect: () => state.patchNodeMetadata(node.id, { fontSize: Math.min(28, (node.metadata?.fontSize ?? 14.5) + 2) }) });
    items.push({ id: "font-down", label: "缩小字号", onSelect: () => state.patchNodeMetadata(node.id, { fontSize: Math.max(10, (node.metadata?.fontSize ?? 14.5) - 2) }) });
    items.push({ id: "save-asset-text", label: "存入素材库", onSelect: () => void saveNodeToAssets(node.id) });
  }
  // P2：reference 節點 → 存為角色/場景卡（鎖定到本畫布，所有生成自動攜帶）。
  if (node.type === CanvasNodeType.Reference && url) {
    items.push("separator");
    items.push({
      id: "save-as-card",
      label: "存为卡并锁定",
      children: [
        { id: "save-card-character", label: "存为角色卡", onSelect: () => void saveNodeAsCard(node, "character") },
        { id: "save-card-scene", label: "存为场景卡", onSelect: () => void saveNodeAsCard(node, "scene") },
      ],
    });
  }
  // 圖片節點 → 帶角色的參考圖節點（保留位置/尺寸/圖片，補默認角色）。
  if (node.type === CanvasNodeType.Image && url) {
    items.push("separator");
    items.push({
      id: "to-reference",
      label: "转为参考图节点",
      onSelect: () => {
        state.addNodes([
          {
            ...node,
            type: CanvasNodeType.Reference,
            metadata: { ...node.metadata, referenceRole: node.metadata?.referenceRole ?? "general" },
          },
        ]);
      },
    });
  }
  if (url) {
    items.push("separator");
    items.push({ id: "download", label: "下载图片", onSelect: () => void downloadNode(node.id) });
    items.push({
      id: "edit-image",
      label: "编辑图片",
      children: [
        { id: "crop", label: "裁剪", onSelect: () => setEditor({ nodeId: node.id, mode: "crop" }) },
        { id: "split", label: "切图", onSelect: () => setEditor({ nodeId: node.id, mode: "split" }) },
        { id: "mask", label: "抠除 / AI 重绘", onSelect: () => setEditor({ nodeId: node.id, mode: "mask" }) },
        { id: "rotate", label: "旋转", onSelect: () => setEditor({ nodeId: node.id, mode: "rotate" }) },
        { id: "angle", label: "角度（AI 重绘）", onSelect: () => setEditor({ nodeId: node.id, mode: "angle" }) },
      ],
    });
    if (url.startsWith("http")) {
      items.push({ id: "upscale", label: "高清放大", disabled: upscalingIds.has(node.id), onSelect: () => void upscaleNode(node.id) });
    }
    items.push({ id: "save-asset-image", label: "存入素材库", onSelect: () => void saveNodeToAssets(node.id) });
  }
  if (parentId) {
    items.push("separator");
    items.push({ id: "set-primary", label: "设为主图", onSelect: () => state.setBatchPrimary(parentId, node.id) });
    items.push({ id: "remove-from-batch", label: "从批次中删除", danger: true, onSelect: () => handleDeleteNode(node.id) });
  }
  if ((node.batchChildren?.length ?? 0) > 0) {
    items.push("separator");
    items.push({ id: "toggle-batch", label: node.batchExpanded === false ? "展开批次" : "收起批次", onSelect: () => state.toggleBatchExpanded(node.id) });
    items.push({ id: "download-all", label: "下载全部子图 (zip)", onSelect: () => void downloadBatch(node.id) });
  }
  if (sel.size >= 2) {
    items.push("separator");
    items.push({ id: "align", label: "对齐与排列", children: alignChildren });
  }
  items.push("separator");
  items.push({
    id: "delete",
    label: sel.size > 1 ? `删除 ${sel.size} 个节点` : "删除节点",
    shortcut: "Del",
    danger: true,
    onSelect: () => (sel.size > 1 ? deleteSelected() : handleDeleteNode(node.id)),
  });
  return items;
}
