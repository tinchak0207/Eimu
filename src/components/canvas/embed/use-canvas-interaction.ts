/**
 * use-canvas-interaction —— CanvasEmbed 交互域（自 CanvasEmbed.tsx 機械搬遷，符號/依賴陣列不變）：
 *   L227-237 交互 state + 最新值鏡像 refs、L378-620 選取/框選/複製貼上/對齊/連線/下載、
 *   L884-951 建節點/導入、L954-1077 埠拖拽/建節點選單/右鍵選單定位/存為卡。
 * 鏡像 refs 由本 hook 持有並回傳，鍵盤 effect（use-canvas-shortcuts）依賴其「最新值」語義。
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import {
  CANVAS_NODE_DEFAULT_SIZE,
  CanvasNodeType,
  type CanvasConnection,
  type CanvasNode,
  type CanvasPosition,
  type Scene3dCardMetadata,
} from "@/lib/canvas/types";
import { authHeaders } from "@/lib/canvas/client";
import { uploadDirect } from "@/lib/direct-upload-client";
import {
  MAX_SCENE_3D_BYTES,
  SCENE_3D_MAGIC_BYTES,
  SCENE_3D_SIZE_HINT,
  scene3dImportCardMetadata,
  scene3dImportTitle,
  validateScene3dUpload,
} from "@/lib/canvas/scene-3d-import";
import {
  alignNodes,
  arrangeGrid,
  cloneForPaste,
  distributeNodes,
  nodesInRect,
  type AlignMode,
  type WorldRect,
} from "@/lib/canvas/interaction";
import { toReferenceImageRole } from "@/lib/image-types";
import type { ReferenceImageRole } from "@/lib/image-types";
import { CHARACTER_CARD_KIND_LABEL, type CharacterCard, type CharacterCardKind } from "@/lib/character-cards";
import {
  IMPORT_STAGGER,
  fileToDataUrl,
  fetchImageBlob,
  imageUrlOf,
  safeFilename,
  triggerDownload,
  wouldCreateCycle,
  type CreateMenuState,
  type EditorState,
  type MenuState,
  type PortDragState,
} from "./embed-helpers";

export interface UseCanvasInteractionInput {
  /** canvas 最新值鏡像 ref（由組件殼持有並傳入）。 */
  canvasStateRef: RefObject<UseCanvasChatReturn>;
  /** 畫布容器（座標換算用）。 */
  containerRef: RefObject<HTMLDivElement | null>;
  /** 視口裁剪後的可見節點（框選命中計算）。 */
  visibleNodes: CanvasNode[];
  /** 批次子節點 → 父節點索引（刪除轉發）。 */
  childToParent: Map<string, string>;
  /** 生成面板節點 id setter（乾淨點擊開面板，A2）。 */
  setPromptPanelNodeId: Dispatch<SetStateAction<string | null>>;
}

/** 建卡結果：要寫入的卡 + 存卡成功的提示文案。 */
export interface BuiltNodeCard {
  card: CharacterCard;
  /** 提示文案（變體卡帶母卡名，使用者看得出這是變體）。 */
  message: string;
}

/**
 * 建卡純邏輯（P2 存為卡）：無 React / 無 DOM，可直接單測。
 *
 * - 預設名與 toast 標籤一律查 CHARACTER_CARD_KIND_LABEL（五種 kind 一致，不再手寫三元式）。
 * - variantOf 的三態（唯一生產者語義）：只在 `kind === "character"` **且**該 id 在既有卡清單裡
 *   真的存在（trim 後非空）時才寫入；kind 非 character / id 不存在 / 空字串一律不寫該欄位
 *   ——在建卡處就擋，不靠 normalize 事後丟。新卡 id 是當場生成的，必然不在既有卡清單裡，
 *   故「等於自身 id」也被同一條 find 擋住。
 * - 節點無可用圖（imageUrlOf 為空）→ 回 null（呼叫端原樣早退，與抽函式前行為一致）。
 */
export function buildNodeCard(
  node: CanvasNode,
  kind: CharacterCardKind,
  options: { variantOf?: string } | undefined,
  existingCards: readonly CharacterCard[],
): BuiltNodeCard | null {
  const url = imageUrlOf(node);
  if (!url) return null;
  const now = new Date().toISOString();
  const label = CHARACTER_CARD_KIND_LABEL[kind];
  const wantedVariant = typeof options?.variantOf === "string" ? options.variantOf.trim() : "";
  const mother =
    kind === "character" && wantedVariant
      ? existingCards.find((card) => card.id === wantedVariant && card.kind === "character")
      : undefined;
  const card: CharacterCard = {
    id: `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: node.title || `${label}卡`,
    kind,
    // 純參考圖卡：locked 片段為空，鎖定的是參考圖與角色（可日後補描述）。
    prompt: "",
    references: [
      {
        url,
        role: node.type === CanvasNodeType.Reference ? toReferenceImageRole(node.metadata?.referenceRole) : "general",
        name: node.title || "参考图",
      },
    ],
    createdAt: now,
    updatedAt: now,
    ...(mother ? { variantOf: mother.id } : {}),
  };
  const message = mother
    ? `已存为角色变体卡并锁定：${card.name}（母卡：${mother.name}）`
    : `已存为${label}卡并锁定：${card.name}`;
  return { card, message };
}

/** 交互域回傳：state + 鏡像 refs + handlers（消費端：組件殼 / 生成 hook / 快捷鍵 hook / menuItems 工廠）。 */
export function useCanvasInteraction({ canvasStateRef, containerRef, visibleNodes, childToParent, setPromptPanelNodeId }: UseCanvasInteractionInput) {
  // ── 交互狀態
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [connecting, setConnecting] = useState<{ sourceId: string; cursor: CanvasPosition | null } | null>(null);
  const [portDrag, setPortDrag] = useState<PortDragState | null>(null);
  const [createMenu, setCreateMenu] = useState<CreateMenuState | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [panelRefIds, setPanelRefIds] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const clipboardRef = useRef<{ nodes: CanvasNode[]; connections: CanvasConnection[] } | null>(null);
  const pasteCountRef = useRef(0);
  const modifiersRef = useRef({ ctrl: false, shift: false });

  // ── 最新值 refs
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const connectingRef = useRef(connecting);
  connectingRef.current = connecting;
  const portDragRef = useRef(portDrag);
  portDragRef.current = portDrag;
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const selectedConnectionRef = useRef(selectedConnectionId);
  selectedConnectionRef.current = selectedConnectionId;
  const createMenuRef = useRef(createMenu);
  createMenuRef.current = createMenu;

  const showError = useCallback((message: string) => {
    setActionError(message);
    window.setTimeout(() => setActionError((prev) => (prev === message ? null : prev)), 6000);
  }, []);

  // ── 座標工具
  const screenToWorld = useCallback((clientX: number, clientY: number): CanvasPosition | null => {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const vp = canvasStateRef.current.viewport;
    return { x: (clientX - rect.left - vp.x) / vp.k, y: (clientY - rect.top - vp.y) / vp.k };
  }, [containerRef, canvasStateRef]);

  const screenInContainer = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const el = containerRef.current;
    const rect = el?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, [containerRef]);

  // ── 選取
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectedConnectionId(null);
    canvasStateRef.current.selectNode(null);
  }, [canvasStateRef]);

  /** 手動建線（環路阻止 + 去重提示）。 */
  const tryConnect = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      const state = canvasStateRef.current;
      if (wouldCreateCycle(state.connections, fromId, toId)) {
        showError("会形成循环连接，已阻止");
        return;
      }
      state.addConnection(fromId, toId);
    },
    [showError, canvasStateRef],
  );

  const handleSelectNode = useCallback((nodeId: string) => {
    const conn = connectingRef.current;
    if (conn) {
      if (conn.sourceId !== nodeId) {
        const state = canvasStateRef.current;
        if (wouldCreateCycle(state.connections, conn.sourceId, nodeId)) {
          setActionError("会形成循环连接，已阻止");
        } else {
          state.addConnection(conn.sourceId, nodeId);
        }
      }
      setConnecting(null);
      return;
    }
    setSelectedConnectionId(null);
    const { ctrl, shift } = modifiersRef.current;
    setSelectedIds((prev) => {
      if (ctrl) {
        const next = new Set(prev);
        if (next.has(nodeId)) next.delete(nodeId);
        else next.add(nodeId);
        return next;
      }
      if (shift) {
        const next = new Set(prev);
        next.add(nodeId);
        return next;
      }
      return new Set([nodeId]);
    });
    canvasStateRef.current.selectNode(nodeId);
  }, [canvasStateRef]);

  /** A2：乾淨點擊 → 開節點面板（修飾鍵/連線模式/Group/Prompt 除外——
   *  prompt 節點是備忘卡不是生成落地位，雙擊正文直編即可，不開生成面板）。 */
  const handleNodeClick = useCallback((nodeId: string) => {
    if (modifiersRef.current.ctrl || modifiersRef.current.shift) return;
    if (connectingRef.current || portDragRef.current) return;
    const node = canvasStateRef.current.nodes.find((n) => n.id === nodeId);
    if (
      !node ||
      node.type === CanvasNodeType.Group ||
      node.type === CanvasNodeType.Video ||
      node.type === CanvasNodeType.Audio ||
      node.type === CanvasNodeType.Prompt ||
      node.type === CanvasNodeType.Scene3d // 3D 場景卡 P1 只讀+播放，無生成面板語義
    ) return;
    setPromptPanelNodeId(nodeId);
  }, [canvasStateRef, setPromptPanelNodeId]);

  const handleMarqueeSelect = useCallback(
    (rect: WorldRect, additive: boolean) => {
      const ids = nodesInRect(visibleNodes, rect);
      setSelectedIds((prev) => {
        const next = additive ? new Set(prev) : new Set<string>();
        for (const id of ids) next.add(id);
        return next;
      });
      if (ids.length > 0) canvasStateRef.current.selectNode(ids[ids.length - 1]);
    },
    [visibleNodes, canvasStateRef],
  );

  const handleNodeMove = useCallback((nodeId: string, position: CanvasPosition) => {
    const state = canvasStateRef.current;
    const sel = selectedIdsRef.current;
    const dragged = state.nodes.find((n) => n.id === nodeId);
    if (!dragged) return;
    if (sel.has(nodeId) && sel.size > 1) {
      const dx = position.x - dragged.position.x;
      const dy = position.y - dragged.position.y;
      const moves = state.nodes
        .filter((n) => sel.has(n.id))
        .map((n) => ({
          nodeId: n.id,
          position: n.id === nodeId ? position : { x: n.position.x + dx, y: n.position.y + dy },
        }));
      state.moveNodes(moves);
    } else {
      state.moveNode(nodeId, position);
    }
  }, [canvasStateRef]);

  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      const parentId = childToParent.get(nodeId);
      if (parentId) canvasStateRef.current.deleteBatchChild(parentId, nodeId);
      else canvasStateRef.current.removeNode(nodeId);
      setSelectedIds((prev) => {
        if (!prev.has(nodeId)) return prev;
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
    },
    [childToParent, canvasStateRef],
  );

  const deleteSelected = useCallback(() => {
    const ids = [...selectedIdsRef.current];
    if (ids.length === 0) return;
    canvasStateRef.current.deleteNodes(ids);
    setSelectedIds(new Set());
  }, [canvasStateRef]);

  // ── 複製 / 貼上 / 複本
  const copySelection = useCallback(() => {
    const state = canvasStateRef.current;
    const sel = selectedIdsRef.current;
    if (sel.size === 0) return;
    clipboardRef.current = {
      nodes: state.nodes.filter((n) => sel.has(n.id)),
      connections: state.connections,
    };
    pasteCountRef.current = 0;
  }, [canvasStateRef]);

  const pasteClipboard = useCallback((at?: CanvasPosition) => {
    const clip = clipboardRef.current;
    const state = canvasStateRef.current;
    if (!clip || clip.nodes.length === 0) return;
    pasteCountRef.current += 1;
    const existingIds = new Set<string>([...state.nodes.map((n) => n.id), ...state.connections.map((c) => c.id)]);
    const offset = at ? { x: 0, y: 0 } : { x: 32 * pasteCountRef.current, y: 32 * pasteCountRef.current };
    const clone = cloneForPaste(clip.nodes, clip.connections, clip.nodes.map((n) => n.id), existingIds, offset);
    if (at && clone.nodes.length > 0) {
      const minX = Math.min(...clone.nodes.map((n) => n.position.x));
      const minY = Math.min(...clone.nodes.map((n) => n.position.y));
      for (const n of clone.nodes) {
        n.position = { x: n.position.x - minX + at.x, y: n.position.y - minY + at.y };
      }
    }
    state.addNodes(clone.nodes, clone.connections);
    setSelectedIds(new Set(clone.nodes.map((n) => n.id)));
    if (clone.nodes.length > 0) state.selectNode(clone.nodes[0].id);
  }, [canvasStateRef]);

  const duplicateSelection = useCallback(() => {
    copySelection();
    pasteClipboard();
  }, [copySelection, pasteClipboard]);

  // ── 對齊 / 均分 / 整理
  const applyMoves = useCallback((moves: { nodeId: string; position: CanvasPosition }[]) => {
    if (moves.length === 0) return;
    const state = canvasStateRef.current;
    state.commitInteraction();
    state.moveNodes(moves);
  }, [canvasStateRef]);

  const alignSelection = useCallback(
    (mode: AlignMode) => applyMoves(alignNodes(canvasStateRef.current.nodes, [...selectedIdsRef.current], mode)),
    [applyMoves, canvasStateRef],
  );
  const distributeSelection = useCallback(
    (axis: "h" | "v") => applyMoves(distributeNodes(canvasStateRef.current.nodes, [...selectedIdsRef.current], axis)),
    [applyMoves, canvasStateRef],
  );
  const arrangeSelection = useCallback(
    () => applyMoves(arrangeGrid(canvasStateRef.current.nodes, [...selectedIdsRef.current])),
    [applyMoves, canvasStateRef],
  );

  // ── 下載
  const downloadNode = useCallback(
    async (nodeId: string) => {
      const node = canvasStateRef.current.nodes.find((n) => n.id === nodeId);
      const url = imageUrlOf(node);
      if (!node || !url) return;
      try {
        triggerDownload(await fetchImageBlob(url), `${safeFilename(node.title)}.png`);
      } catch (error) {
        showError(error instanceof Error ? error.message : "下载失败");
      }
    },
    [showError, canvasStateRef],
  );

  const downloadBatch = useCallback(
    async (parentId: string) => {
      const state = canvasStateRef.current;
      const parent = state.nodes.find((n) => n.id === parentId);
      if (!parent) return;
      const children = (parent.batchChildren ?? [])
        .map((id) => state.nodes.find((n) => n.id === id))
        .filter((n): n is CanvasNode => !!n && !!imageUrlOf(n));
      if (children.length === 0) {
        showError("批次里没有可下载的图片");
        return;
      }
      try {
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        for (const child of children) {
          const blob = await fetchImageBlob(imageUrlOf(child)!);
          zip.file(`${safeFilename(child.title)}.png`, blob);
        }
        triggerDownload(await zip.generateAsync({ type: "blob" }), `${safeFilename(parent.title)}-批次.zip`);
      } catch (error) {
        showError(error instanceof Error ? error.message : "打包下载失败");
      }
    },
    [showError, canvasStateRef],
  );

  // ── 建節點（雙擊/連線拖放/庫插入/導入共用）
  const createNodeAt = useCallback(
    (
      type: "text" | "image" | "prompt" | "reference" | "scene3d",
      world: CanvasPosition,
      extras?: {
        content?: string;
        title?: string;
        width?: number;
        height?: number;
        referenceRole?: ReferenceImageRole;
        /** scene3d：本機導入卡（source:"import"，只帶 glb_path）的 metadata。 */
        sceneCard?: Scene3dCardMetadata;
      },
    ) => {
      const state = canvasStateRef.current;
      const id = `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const nodeType =
        type === "text"
          ? CanvasNodeType.Text
          : type === "prompt"
            ? CanvasNodeType.Prompt
            : type === "reference"
              ? CanvasNodeType.Reference
              : type === "scene3d"
                ? CanvasNodeType.Scene3d
                : CanvasNodeType.Image;
      const defaultTitle =
        type === "text"
          ? "文本"
          : type === "prompt"
            ? "提示词"
            : type === "reference"
              ? "参考图"
              : type === "scene3d"
                ? CANVAS_NODE_DEFAULT_SIZE[CanvasNodeType.Scene3d].title
                : "图片";
      const role = extras?.referenceRole;
      const size = CANVAS_NODE_DEFAULT_SIZE[nodeType];
      const node: CanvasNode = {
        id,
        type: nodeType,
        title: extras?.title ?? defaultTitle,
        position: world,
        // 四個既有型別的尺寸逐字不變（reference 300×240、prompt 340×200、其餘 340×240）；
        // 只有新增的 scene3d 取契約預設 420×360。
        width: extras?.width ?? (type === "reference" ? 300 : type === "scene3d" ? size.width : 340),
        height: extras?.height ?? (type === "prompt" ? 200 : type === "scene3d" ? size.height : 240),
        moved: true,
        metadata:
          type === "scene3d"
            ? // 導入卡：glb_path 落地即完成（status:success 讓卡不顯示生成中骨架）；
              // 其餘五欄缺席就是缺席，卡面走減法（Scene3dCardBody）。
              { ...(extras?.sceneCard ? { sceneCard: extras.sceneCard } : {}), status: "success" }
            : type === "text" || type === "prompt"
              ? { content: extras?.content ?? "", status: "idle" }
              : extras?.content
                ? { content: extras.content, status: "success", ...(role ? { referenceRole: role } : {}) }
                : { status: "idle", ...(role ? { referenceRole: role } : {}) },
      };
      state.addNodes([node]);
      setSelectedIds(new Set([id]));
      state.selectNode(id);
      return id;
    },
    [canvasStateRef],
  );

  /** 本地圖片檔 → 畫布節點（壓縮後 dataURL；多檔階梯錯位）。
   *  kind="reference" → 建成帶角色的 reference 節點（默認 general，節點上可切換）。 */
  const importImageFiles = useCallback(
    async (files: File[], world: CanvasPosition, kind: "image" | "reference" = "image") => {
      let index = 0;
      for (const file of files.slice(0, 8)) {
        if (!file.type.startsWith("image/")) continue;
        try {
          const { dataUrl, width, height } = await fileToDataUrl(file);
          const nodeW = kind === "reference" ? 300 : 340;
          const nodeH = width > 0 ? Math.min(Math.max(Math.round((nodeW * height) / width), 120), 460) : 240;
          const id = createNodeAt(kind, { x: world.x + index * IMPORT_STAGGER, y: world.y + index * IMPORT_STAGGER }, {
            content: dataUrl,
            title: safeFilename(file.name.replace(/\.[^.]+$/, "")) || (kind === "reference" ? "参考图" : "图片"),
            width: nodeW,
            height: nodeH,
            ...(kind === "reference" ? { referenceRole: "general" as ReferenceImageRole } : {}),
          });
          canvasStateRef.current.patchNodeMetadata(id, { naturalWidth: width, naturalHeight: height, bytes: file.size, mimeType: file.type }, { history: false });
          index += 1;
        } catch {
          showError(`「${file.name}」导入失败`);
        }
      }
    },
    [createNodeAt, showError, canvasStateRef],
  );

  /**
   * 本機 3D 模型（.glb/.gltf）→ 3D 場景卡節點（2026-09-27 本機導入刀）。
   *
   * 前後端同一把尺（`scene-3d-import.validateScene3dUpload`）：這裡先擋副檔名/體積/魔數，
   * 服務端 `/api/canvas/scene-3d` 再驗一次（不信任客戶端）。成功才建卡：
   * 標題＝檔名去副檔名、`scene_summary`＝真實來源文字、`source:"import"`；
   * **不編造場景描述**（沒人看過這個模型）。
   */
  const importScene3dFile = useCallback(
    async (file: File, world: CanvasPosition) => {
      try {
        const head = new Uint8Array(await file.slice(0, SCENE_3D_MAGIC_BYTES).arrayBuffer());
        // 形狀（副檔名／魔數）一律先用同一支契約函式驗；體積不在此定死：
        //  ≤ MAX_SCENE_3D_BYTES → 既有站內代理路（原狀不變）；
        //  > MAX_SCENE_3D_BYTES → 兩段式直傳（瀏覽器直傳物件存儲），
        //    真實上限取直傳憑證回應的 maxBytes（不是常數）。
        const checked = validateScene3dUpload({
          name: file.name,
          size: file.size,
          head,
          maxBytes: Number.POSITIVE_INFINITY,
        });
        if (!checked.ok) {
          showError(checked.message);
          return;
        }
        const headers = authHeaders();
        if (!headers) {
          showError("请先登录再导入 3D 模型");
          return;
        }
        if (file.size > MAX_SCENE_3D_BYTES) {
          // 大檔：站內代理路受平台 ~4.5MB 請求體硬頂，改走兩段式直傳；
          // 拿回 downloadUrl 餵給下面同一條建卡流程（下游只吃 URL，不變）。
          try {
            const uploaded = await uploadDirect(file, { title: scene3dImportTitle(file.name), headers });
            createNodeAt("scene3d", world, {
              title: scene3dImportTitle(file.name),
              sceneCard: scene3dImportCardMetadata({ url: uploaded.downloadUrl, fileName: file.name }),
            });
          } catch (error) {
            showError(error instanceof Error ? error.message : "模型导入失败");
          }
          return;
        }
        const form = new FormData();
        form.append("file", file);
        let res: Response;
        try {
          res = await fetch("/api/canvas/scene-3d", { method: "POST", headers, body: form });
        } catch {
          showError("模型导入失败：网络连接失败");
          return;
        }
        if (!res.ok) {
          let message = `模型导入失败（HTTP ${res.status}）`;
          try {
            const body = (await res.json()) as { error?: unknown };
            if (typeof body?.error === "string" && body.error) message = body.error;
            else if (res.status === 413) {
              message = SCENE_3D_SIZE_HINT;
            }
          } catch {
            // 非 JSON 錯誤體：保留狀態碼訊息，不讓 parse 異常蓋掉真正原因。
          }
          showError(message);
          return;
        }
        const data = (await res.json()) as { url?: unknown };
        if (typeof data?.url !== "string" || !data.url) {
          showError("模型导入失败：服务端未返回模型地址");
          return;
        }
        createNodeAt("scene3d", world, {
          title: scene3dImportTitle(file.name),
          sceneCard: scene3dImportCardMetadata({ url: data.url, fileName: file.name }),
        });
      } catch (error) {
        showError(error instanceof Error ? error.message : "模型导入失败");
      }
    },
    [createNodeAt, showError],
  );

  // ── A1：port 拖線（window 級 move/up，capture 保證不被節點吃掉）
  const startPortDrag = useCallback((nodeId: string, side: "left" | "right", clientX: number, clientY: number) => {
    setMenu(null);
    setConnecting(null);
    setPortDrag({ sourceId: nodeId, side, cursor: screenToWorld(clientX, clientY) });
  }, [screenToWorld]);

  useEffect(() => {
    if (!portDrag) return;
    const onMove = (e: PointerEvent) => {
      setPortDrag((prev) => (prev ? { ...prev, cursor: screenToWorld(e.clientX, e.clientY) } : prev));
    };
    const onUp = (e: PointerEvent) => {
      const drag = portDragRef.current;
      setPortDrag(null);
      if (!drag) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const nodeEl = el?.closest<HTMLElement>("[data-canvas-node]");
      const targetId = nodeEl?.getAttribute("data-canvas-node");
      if (targetId && targetId !== drag.sourceId) {
        // 右 port = 出邊（source→target）、左 port = 入邊（target→source）
        if (drag.side === "right") tryConnect(drag.sourceId, targetId);
        else tryConnect(targetId, drag.sourceId);
        return;
      }
      if (!targetId) {
        // 鬆手在空白 → 就地建節點選單，建完自動連線（藤蔓式生長）。
        const world = screenToWorld(e.clientX, e.clientY);
        if (world) {
          setCreateMenu({
            position: screenInContainer(e.clientX, e.clientY),
            world,
            connectFrom: { nodeId: drag.sourceId, side: drag.side },
          });
        }
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPortDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { capture: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp, { capture: true });
      window.removeEventListener("keydown", onKey);
    };
  }, [portDrag, screenToWorld, screenInContainer, tryConnect]);

  /** 建節點選單確認（雙擊空白 / 連線拖放共用）。 */
  const handleCreateFromMenu = useCallback(
    (type: "text" | "image" | "prompt") => {
      const cm = createMenuRef.current;
      if (!cm) return;
      setCreateMenu(null);
      const id = createNodeAt(type, cm.world);
      if (cm.connectFrom) {
        if (cm.connectFrom.side === "right") tryConnect(cm.connectFrom.nodeId, id);
        else tryConnect(id, cm.connectFrom.nodeId);
      }
    },
    [createNodeAt, tryConnect],
  );

  const handleCreateMenuUpload = useCallback(
    (files: File[], kind: "image" | "reference" = "image") => {
      const cm = createMenuRef.current;
      setCreateMenu(null);
      if (!cm) return;
      void importImageFiles(files, cm.world, kind).then(() => {
        // 連線拖放上傳：與第一個導入節點連線（importImageFiles 已選中最後一個，
        // 簡化：不強行連線，交用戶手動——多檔語義不明確時不猜）。
      });
    },
    [importImageFiles],
  );

  /** 建節點選單的「導入 3D 模型…」入口：落點取選單開出時的 world 座標（同上傳圖片形）。 */
  const handleImportScene3d = useCallback(
    (file: File) => {
      const cm = createMenuRef.current;
      setCreateMenu(null);
      if (!cm) return;
      void importScene3dFile(file, cm.world);
    },
    [importScene3dFile],
  );

  // ── 右鍵選單（沿用 v4 + 連線右鍵 + 字號）
  const openNodeMenu = useCallback((nodeId: string, clientX: number, clientY: number) => {
    const vpPos = screenInContainer(clientX, clientY);
    const world = screenToWorld(clientX, clientY) ?? { x: 0, y: 0 };
    if (!selectedIdsRef.current.has(nodeId)) {
      setSelectedIds(new Set([nodeId]));
      canvasStateRef.current.selectNode(nodeId);
    }
    setMenu({ position: vpPos, world, targetNodeId: nodeId });
  }, [screenInContainer, screenToWorld, canvasStateRef]);

  const openCanvasMenu = useCallback((screen: { x: number; y: number }, world: { x: number; y: number }) => {
    setMenu({ position: screen, world, targetNodeId: null });
  }, []);

  /** P2：從 reference 節點「存為卡」——取節點圖 + 角色建卡，存檔並鎖定到本畫布。
   *  options.variantOf（C）：指到存在的角色母卡時寫入卡物件的 variantOf（變體母卡）。 */
  const saveNodeAsCard = useCallback(
    async (node: CanvasNode, kind: CharacterCardKind, options?: { variantOf?: string }) => {
      const built = buildNodeCard(node, kind, options, canvasStateRef.current.characterCards);
      if (!built) return;
      const { card, message } = built;
      const ok = await canvasStateRef.current.upsertCharacterCard(card);
      if (!ok) {
        showError("存卡失败，请稍后再试");
        return;
      }
      canvasStateRef.current.toggleCharacterCard(card.id); // 存為卡即鎖定（生成自動攜帶）
      showError(message);
    },
    [showError, canvasStateRef],
  );

  return {
    // 交互 state + setters
    selectedIds,
    setSelectedIds,
    selectedConnectionId,
    setSelectedConnectionId,
    hoveredNodeId,
    setHoveredNodeId,
    menu,
    setMenu,
    connecting,
    setConnecting,
    portDrag,
    setPortDrag,
    createMenu,
    setCreateMenu,
    editor,
    setEditor,
    panelRefIds,
    setPanelRefIds,
    actionError,
    setActionError,
    showError,
    // 最新值鏡像 refs（鍵盤 effect 依賴）
    selectedIdsRef,
    connectingRef,
    portDragRef,
    menuRef,
    editorRef,
    selectedConnectionRef,
    createMenuRef,
    clipboardRef,
    modifiersRef,
    // 座標工具
    screenToWorld,
    screenInContainer,
    // handlers
    clearSelection,
    tryConnect,
    handleSelectNode,
    handleNodeClick,
    handleMarqueeSelect,
    handleNodeMove,
    handleDeleteNode,
    deleteSelected,
    copySelection,
    pasteClipboard,
    duplicateSelection,
    applyMoves,
    alignSelection,
    distributeSelection,
    arrangeSelection,
    downloadNode,
    downloadBatch,
    createNodeAt,
    importImageFiles,
    startPortDrag,
    handleCreateFromMenu,
    handleCreateMenuUpload,
    handleImportScene3d,
    openNodeMenu,
    openCanvasMenu,
    saveNodeAsCard,
  };
}
