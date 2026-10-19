/**
 * use-canvas-shortcuts —— CanvasEmbed 键盘快捷键 + 系统剪贴簿 effects
 * （自 CanvasEmbed.tsx L1299-1402 机械搬迁；effect 依赖阵列随函数整组搬，全部为稳定引用）。
 * 依赖「最新值镜像 refs」语义：Escape/全选/复制贴上读 refs 而非闭包 state。
 */
import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import type { CanvasConnection, CanvasNode, CanvasPosition } from "@/lib/canvas/types";
import type { CreateMenuState, EditorState, MenuState, PortDragState } from "./embed-helpers";

export interface UseCanvasShortcutsInput {
  canvasStateRef: RefObject<UseCanvasChatReturn>;
  containerRef: RefObject<HTMLDivElement | null>;
  viewportSizeRef: RefObject<{ width: number; height: number }>;
  clipboardRef: RefObject<{ nodes: CanvasNode[]; connections: CanvasConnection[] } | null>;
  editorRef: RefObject<EditorState | null>;
  promptPanelRef: RefObject<string | null>;
  selectedIdsRef: RefObject<Set<string>>;
  selectedConnectionRef: RefObject<string | null>;
  connectingRef: RefObject<{ sourceId: string; cursor: CanvasPosition | null } | null>;
  portDragRef: RefObject<PortDragState | null>;
  menuRef: RefObject<MenuState | null>;
  createMenuRef: RefObject<CreateMenuState | null>;
  setPortDrag: Dispatch<SetStateAction<PortDragState | null>>;
  setConnecting: Dispatch<SetStateAction<{ sourceId: string; cursor: CanvasPosition | null } | null>>;
  setCreateMenu: Dispatch<SetStateAction<CreateMenuState | null>>;
  setMenu: Dispatch<SetStateAction<MenuState | null>>;
  setPromptPanelNodeId: Dispatch<SetStateAction<string | null>>;
  setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  clearSelection: () => void;
  copySelection: () => void;
  pasteClipboard: (at?: CanvasPosition) => void;
  duplicateSelection: () => void;
  deleteSelected: () => void;
  importImageFiles: (files: File[], world: CanvasPosition, kind?: "image" | "reference") => Promise<void>;
  createNodeAt: (
    type: "text" | "image" | "prompt" | "reference",
    world: CanvasPosition,
    extras?: { content?: string; title?: string; width?: number; height?: number; referenceRole?: import("@/lib/image-types").ReferenceImageRole },
  ) => string;
}

export function useCanvasShortcuts({
  canvasStateRef,
  containerRef,
  viewportSizeRef,
  clipboardRef,
  editorRef,
  promptPanelRef,
  selectedIdsRef,
  selectedConnectionRef,
  connectingRef,
  portDragRef,
  menuRef,
  createMenuRef,
  setPortDrag,
  setConnecting,
  setCreateMenu,
  setMenu,
  setPromptPanelNodeId,
  setSelectedConnectionId,
  setSelectedIds,
  clearSelection,
  copySelection,
  pasteClipboard,
  duplicateSelection,
  deleteSelected,
  importImageFiles,
  createNodeAt,
}: UseCanvasShortcutsInput) {
  // ── 键盘快捷键
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        e.isComposing ||
        (target &&
          (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable))
      ) {
        return;
      }
      if (editorRef.current) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        if (portDragRef.current) setPortDrag(null);
        else if (connectingRef.current) setConnecting(null);
        else if (createMenuRef.current) setCreateMenu(null);
        else if (menuRef.current) setMenu(null);
        else if (promptPanelRef.current) setPromptPanelNodeId(null);
        else clearSelection();
        return;
      }
      if (mod && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        const nodes = canvasStateRef.current.nodes;
        const byId = new Map(nodes.map((n) => [n.id, n]));
        const parentOf = new Map<string, string>();
        for (const n of nodes) for (const cid of n.batchChildren ?? []) parentOf.set(cid, n.id);
        const all = nodes.filter((n) => {
          const pid = parentOf.get(n.id);
          return !pid || byId.get(pid)?.batchExpanded !== false;
        });
        setSelectedIds(new Set(all.map((n) => n.id)));
        return;
      }
      if (mod && (e.key === "c" || e.key === "C")) {
        copySelection();
        return;
      }
      if (mod && (e.key === "v" || e.key === "V")) {
        // 内部剪贴簿优先；空的话交给 window paste 事件读系统剪贴簿。
        if (clipboardRef.current?.nodes.length) pasteClipboard();
        return;
      }
      if (mod && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) canvasStateRef.current.redo();
        else canvasStateRef.current.undo();
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        canvasStateRef.current.redo();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedConnectionRef.current) {
          e.preventDefault();
          canvasStateRef.current.removeConnection(selectedConnectionRef.current);
          setSelectedConnectionId(null);
          return;
        }
        if (selectedIdsRef.current.size > 0) {
          e.preventDefault();
          deleteSelected();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    clearSelection,
    copySelection,
    pasteClipboard,
    duplicateSelection,
    deleteSelected,
    canvasStateRef,
    clipboardRef,
    editorRef,
    promptPanelRef,
    selectedIdsRef,
    selectedConnectionRef,
    connectingRef,
    portDragRef,
    menuRef,
    createMenuRef,
    setPortDrag,
    setConnecting,
    setCreateMenu,
    setMenu,
    setPromptPanelNodeId,
    setSelectedConnectionId,
    setSelectedIds,
  ]);

  // ── A8：系统剪贴簿贴图/贴文字（画布容器有 hover/焦点语境时）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (clipboardRef.current?.nodes.length) return; // 内部剪贴簿优先（keydown 已处理）
      const el = containerRef.current;
      if (!el) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      const vp = canvasStateRef.current.viewport;
      const center = {
        x: (viewportSizeRef.current.width / 2 - vp.x) / vp.k,
        y: (viewportSizeRef.current.height / 2 - vp.y) / vp.k,
      };
      if (files.length > 0) {
        e.preventDefault();
        void importImageFiles(files, center);
        return;
      }
      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (text) {
        e.preventDefault();
        createNodeAt("text", center, { content: text, title: text.slice(0, 12) || "文本" });
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [importImageFiles, createNodeAt, canvasStateRef, containerRef, viewportSizeRef, clipboardRef]);
}
