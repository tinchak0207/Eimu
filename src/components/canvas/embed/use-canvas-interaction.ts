/**
 * use-canvas-interaction —— CanvasEmbed 交互域（自 CanvasEmbed.tsx 机械搬迁，符号/依赖阵列不变）：
 *   L227-237 交互 state + 最新值镜像 refs、L378-620 选取/框选/复制贴上/对齐/连线/下载、
 *   L884-951 建节点/导入、L954-1077 埠拖拽/建节点选单/右键选单定位/存为卡。
 * 镜像 refs 由本 hook 持有并回传，键盘 effect（use-canvas-shortcuts）依赖其「最新值」语义。
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
import { DirectUploadError, uploadDirect } from "@/lib/direct-upload-client";
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
  /** canvas 最新值镜像 ref（由组件壳持有并传入）。 */
  canvasStateRef: RefObject<UseCanvasChatReturn>;
  /** 画布容器（座标换算用）。 */
  containerRef: RefObject<HTMLDivElement | null>;
  /** 视口裁剪后的可见节点（框选命中计算）。 */
  visibleNodes: CanvasNode[];
  /** 批次子节点 → 父节点索引（删除转发）。 */
  childToParent: Map<string, string>;
  /** 生成面板节点 id setter（干净点击开面板，A2）。 */
  setPromptPanelNodeId: Dispatch<SetStateAction<string | null>>;
}

/** 建卡结果：要写入的卡 + 存卡成功的提示文案。 */
export interface BuiltNodeCard {
  card: CharacterCard;
  /** 提示文案（变体卡带母卡名，使用者看得出这是变体）。 */
  message: string;
}

/**
 * 建卡纯逻辑（P2 存为卡）：无 React / 无 DOM，可直接单测。
 *
 * - 预设名与 toast 标签一律查 CHARACTER_CARD_KIND_LABEL（五种 kind 一致，不再手写三元式）。
 * - variantOf 的三态（唯一生产者语义）：只在 `kind === "character"` **且**该 id 在既有卡清单里
 *   真的存在（trim 后非空）时才写入；kind 非 character / id 不存在 / 空字串一律不写该栏位
 *   ——在建卡处就挡，不靠 normalize 事后丢。新卡 id 是当场生成的，必然不在既有卡清单里，
 *   故「等于自身 id」也被同一条 find 挡住。
 * - 节点无可用图（imageUrlOf 为空）→ 回 null（呼叫端原样早退，与抽函式前行为一致）。
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
    // 纯参考图卡：locked 片段为空，锁定的是参考图与角色（可日后补描述）。
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

/** 交互域回传：state + 镜像 refs + handlers（消费端：组件壳 / 生成 hook / 快捷键 hook / menuItems 工厂）。 */
export function useCanvasInteraction({ canvasStateRef, containerRef, visibleNodes, childToParent, setPromptPanelNodeId }: UseCanvasInteractionInput) {
  // ── 交互状态
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

  // ── 座标工具
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

  // ── 选取
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectedConnectionId(null);
    canvasStateRef.current.selectNode(null);
  }, [canvasStateRef]);

  /** 手动建线（环路阻止 + 去重提示）。 */
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

  /** A2：干净点击 → 开节点面板（修饰键/连线模式/Group/Prompt 除外——
   *  prompt 节点是备忘卡不是生成落地位，双击正文直编即可，不开生成面板）。 */
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
      node.type === CanvasNodeType.Scene3d // 3D 场景卡 P1 只读+播放，无生成面板语义
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

  // ── 复制 / 贴上 / 复本
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

  // ── 对齐 / 均分 / 整理
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

  // ── 下载
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

  // ── 建节点（双击/连线拖放/库插入/导入共用）
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
        /** scene3d：本机导入卡（source:"import"，只带 glb_path）的 metadata。 */
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
        // 四个既有型别的尺寸逐字不变（reference 300×240、prompt 340×200、其余 340×240）；
        // 只有新增的 scene3d 取契约预设 420×360。
        width: extras?.width ?? (type === "reference" ? 300 : type === "scene3d" ? size.width : 340),
        height: extras?.height ?? (type === "prompt" ? 200 : type === "scene3d" ? size.height : 240),
        moved: true,
        metadata:
          type === "scene3d"
            ? // 导入卡：glb_path 落地即完成（status:success 让卡不显示生成中骨架）；
              // 其余五栏缺席就是缺席，卡面走减法（Scene3dCardBody）。
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

  /** 本地图片档 → 画布节点（压缩后 dataURL；多档阶梯错位）。
   *  kind="reference" → 建成带角色的 reference 节点（默认 general，节点上可切换）。 */
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
   * 本机 3D 模型（.glb/.gltf）→ 3D 场景卡节点（2026-09-27 本机导入刀）。
   *
   * 前后端同一把尺（`scene-3d-import.validateScene3dUpload`）：这里先挡副档名/体积/魔数，
   * 服务端 `/api/canvas/scene-3d` 再验一次（不信任客户端）。成功才建卡：
   * 标题＝档名去副档名、`scene_summary`＝真实来源文字、`source:"import"`；
   * **不编造场景描述**（没人看过这个模型）。
   */
  const importScene3dFile = useCallback(
    async (file: File, world: CanvasPosition) => {
      try {
        const head = new Uint8Array(await file.slice(0, SCENE_3D_MAGIC_BYTES).arrayBuffer());
        // 形状（副档名／魔数）一律先用同一支契约函式验；体积不在此定死：
        //  ≤ MAX_SCENE_3D_BYTES → 既有站内代理路（原状不变）；
        //  > MAX_SCENE_3D_BYTES → 两段式直传（浏览器直传物件存储），
        //    真实上限取直传凭证回应的 maxBytes（不是常数）。
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
          // 大档：站内代理路受平台 ~4.5MB 请求体硬顶，改走两段式直传；
          // 拿回 downloadUrl 喂给下面同一条建卡流程（下游只吃 URL，不变）。
          try {
            const uploaded = await uploadDirect(file, { title: scene3dImportTitle(file.name), headers });
            createNodeAt("scene3d", world, {
              title: scene3dImportTitle(file.name),
              sceneCard: scene3dImportCardMetadata({ url: uploaded.downloadUrl, fileName: file.name }),
            });
          } catch (error) {
            // DirectUploadError 的 message 已是给用户看的人话（超限/后端不支援/网路失败）；
            // 其余（例如浏览器原生的 TypeError）不外泄原文，统一给人话。
            showError(error instanceof DirectUploadError ? error.message : "模型导入失败：请检查网络后重试");
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
            // 非 JSON 错误体：保留状态码讯息，不让 parse 异常盖掉真正原因。
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

  // ── A1：port 拖线（window 级 move/up，capture 保证不被节点吃掉）
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
        // 右 port = 出边（source→target）、左 port = 入边（target→source）
        if (drag.side === "right") tryConnect(drag.sourceId, targetId);
        else tryConnect(targetId, drag.sourceId);
        return;
      }
      if (!targetId) {
        // 松手在空白 → 就地建节点选单，建完自动连线（藤蔓式生长）。
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

  /** 建节点选单确认（双击空白 / 连线拖放共用）。 */
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
        // 连线拖放上传：与第一个导入节点连线（importImageFiles 已选中最后一个，
        // 简化：不强行连线，交用户手动——多档语义不明确时不猜）。
      });
    },
    [importImageFiles],
  );

  /** 建节点选单的「导入 3D 模型…」入口：落点取选单开出时的 world 座标（同上传图片形）。 */
  const handleImportScene3d = useCallback(
    (file: File) => {
      const cm = createMenuRef.current;
      setCreateMenu(null);
      if (!cm) return;
      void importScene3dFile(file, cm.world);
    },
    [importScene3dFile],
  );

  // ── 右键选单（沿用 v4 + 连线右键 + 字号）
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

  /** P2：从 reference 节点「存为卡」——取节点图 + 角色建卡，存档并锁定到本画布。
   *  options.variantOf（C）：指到存在的角色母卡时写入卡物件的 variantOf（变体母卡）。 */
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
      canvasStateRef.current.toggleCharacterCard(card.id); // 存为卡即锁定（生成自动携带）
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
    // 最新值镜像 refs（键盘 effect 依赖）
    selectedIdsRef,
    connectingRef,
    portDragRef,
    menuRef,
    editorRef,
    selectedConnectionRef,
    createMenuRef,
    clipboardRef,
    modifiersRef,
    // 座标工具
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
