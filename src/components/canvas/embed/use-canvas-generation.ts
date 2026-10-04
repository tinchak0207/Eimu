/**
 * use-canvas-generation —— CanvasEmbed 生成编排域（自 CanvasEmbed.tsx L621-1002 机械搬迁，符号/依赖阵列不变）：
 *   callCanvasGenerate → generateIntoNode → handleGenerateFromNode → stopGeneration/retryNode/upscaleNode → runAgentGeneration。
 * 2026-09-28 新增节点动作 extractFramesFromNode（影片节点「截帧／序列帧」：计划走 /api/canvas/video-frames，
 * 像素走 video-frames.ts 的 extractFramesAtTimes，产物落成画布图片节点）。
 * P2 挂接点：锁定的角色/场景卡在 callCanvasGenerate 注入——手动面板、agent run_generation、
 * 编辑器派生全部经过这一条路，保证项目级锁定对所有画布生成生效。
 * 认证立场：生成/超分走 Bearer + x-user-id，未登入诚实报错。
 */
import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import { CanvasNodeType, type CanvasNode } from "@/lib/canvas/types";
import {
  composeGenerationPrompt,
  mergeGenerationReferences,
  resolveGenerationInputs,
  type CanvasGenerationReference,
} from "@/lib/canvas/semantic-nodes";
import { toReferenceImageRole } from "@/lib/image-types";
import type { ReferenceImageRole } from "@/lib/image-types";
import { applyCharacterCardsToPayload, mergeTokenReferencedCards } from "@/lib/character-cards";
import type { CardAwareGeneratePayload, CharacterCard } from "@/lib/character-cards";
import { createBatchChildNode } from "@/lib/canvas/batch-utils";
import { resolveSceneDirectorReferences, sceneDirectorTraceMetadata } from "@/lib/canvas/scene-3d-reference";
import { generationCapabilities } from "@/lib/generation-model-catalog";
import { generatedImageMetadata, type CanvasGeneratedImage } from "@/lib/canvas/generated-image-metadata";
import {
  extractFramesAtTimes,
  frameFileName,
  tileFrameCount,
  waitForMetadata,
  type VideoElementSample,
} from "@/lib/video-frames";
import type { SelectedLora } from "@/components/canvas-workstation/panels/LoraLibraryPanel";
import { buildAuthHeaders, imageUrlOf } from "./embed-helpers";

/**
 * Blob → data URL（影片取帧落节点用）。用 FileReader 而不是 fetch(blob:)：
 * 与画布其余本地像素路径同款，且不依赖第三方压缩库（帧已是 512px/q0.8 JPEG）。
 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("无法读取取帧结果"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 行内 @ 引用 → 本镜参考集收窄覆写（纯函数，唯一推导入口；面板批次与原地生成共用同一契约）。
 *   - entityCardIds 缺省/空 → undefined（不覆写＝既有全量锁定行为）
 *   - 有 id 但全对不到卡 → undefined（**刻意**：收窄到空集合会让参考图静默全空，
 *     比不收窄更坏；退回既有全量行为）
 *   - 命中 → { cards, referenceScope: "referenced" }，卡顺序沿用 cards 原序（不重排；
 *     注入端稳定序由 applyCharacterCards 负责）
 */
export function resolveEntityCardsOverride(
  cards: CharacterCard[],
  entityCardIds?: string[],
): { cards: CharacterCard[]; referenceScope: "referenced" } | undefined {
  if (!entityCardIds?.length) return undefined;
  const picked = cards.filter((card) => entityCardIds.includes(card.id));
  if (!picked.length) return undefined;
  return { cards: picked, referenceScope: "referenced" };
}

/**
 * 专案风格绑定注入（P1-8／对称差 D34）：与同档 LoRA 段同款 merge（`{ ...payload, key: value }`）。
 *   - `payload` 尚未带 `style_id` 且有专案绑定 → 带上（值＝`CanvasProject.styleId`）；
 *   - 无绑定（undefined／空字串）→ 原物件逐位不变，**不新增 `style_id` 键**（不得塞 undefined
 *     或空字串；route 端「无 id ⇒ prompt 逐位零回归」的契约靠这个保证）。
 *   - 已带 `style_id`（呼叫端显式给定）→ 不覆写。
 * 抽成纯函式：本档的请求组装只有这一条路径，抽出后可对「请求真的带了风格」作真行为断言
 * （本 repo 测试范式是 node:test + 纯函式，无 React renderer）。行为与行内 merge 逐位等价。
 */
export function withProjectStyleId<T extends Record<string, unknown>>(
  payload: T,
  styleId: string | undefined,
): T {
  if (!styleId || payload.style_id !== undefined) return payload;
  return { ...payload, style_id: styleId };
}

export interface UseCanvasGenerationInput {
  /** canvas 最新值镜像 ref（由组件壳持有并传入）。 */
  canvasStateRef: RefObject<UseCanvasChatReturn>;
  /** 视口尺寸镜像 ref（生成后 fitView 用）。 */
  viewportSizeRef: RefObject<{ width: number; height: number }>;
  /** 错误提示（交互域 hook 回传）。 */
  showError: (message: string) => void;
  /** 生成面板选中的参考图节点 id。 */
  panelRefIds: string[];
  setPromptPanelNodeId: Dispatch<SetStateAction<string | null>>;
  setPanelRefIds: Dispatch<SetStateAction<string[]>>;
  /** 生成面板行内 @ 引用的素材卡 id（生成落地后清空；与 setPanelRefIds 同款）。 */
  setPanelEntityIds?: Dispatch<SetStateAction<string[]>>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  /** 当前选中的 LoRA（2026-08-27 自专业工作站迁入；null = 不带）。 */
  selectedLora?: SelectedLora | null;
}

/** 生成编排域回传：状态 + handlers（消费端：组件壳 / menuItems 工厂 / 节点挂载）。 */
export function useCanvasGeneration({
  canvasStateRef,
  viewportSizeRef,
  showError,
  panelRefIds,
  setPromptPanelNodeId,
  setPanelRefIds,
  setPanelEntityIds,
  setSelectedIds,
  selectedLora = null,
}: UseCanvasGenerationInput) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [upscalingIds, setUpscalingIds] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  // 最新 LoRA 镜像 ref：callCanvasGenerate 的 useCallback 不因 LoRA 选择换身份。
  const selectedLoraRef = useRef(selectedLora);
  selectedLoraRef.current = selectedLora;

  /**
   * 生成唯一出口。第三参数（可选）＝本镜参考集覆写：
   *   - 不传：逐位元既有行为（用 canvasStateRef 的 activeCharacterCards 全量注入）
   *   - 传：用指定的卡子集注入，并把 referenceScope 交给 applyCharacterCardsToPayload
   *     （"referenced" = 本镜只行内 @ 引用了这几张卡，其余锁定卡不进本镜）
   * 卡集最后再并入**本段 prompt token 引用到的卡**（mergeTokenReferencedCards：卡在库即可
   * 被 @ 引用，不必先手动锁定；零 token／全未命中＝同一阵列参考，逐位元等价）。
   */
  const callCanvasGenerate = useCallback(
    async (
      payload: Record<string, unknown>,
      signal: AbortSignal,
      cardsOverride?: { cards: CharacterCard[]; referenceScope: "all" | "referenced" },
    ) => {
      const headers = buildAuthHeaders(true);
      if (!headers) throw new Error("请先登录再生成图片");
      const baseCards = cardsOverride?.cards ?? canvasStateRef.current.activeCharacterCards ?? [];
      // 本段提示词 token 就地解析（2026-09-25）：卡在库即可被 @ 引用，不必先手动锁定——
      // 把命中 token 的卡并入注入集（联集，不自动锁定、不改锁定语义）。
      // 显式关闭注入（cards: []，资产重生成那条路）＝不并入：该 payload 的参考图已显式给定，
      // 再注入一次会把「要被换掉的那张图」同时当参考（把错误传染给新图）。
      const explicitOff = !!cardsOverride && cardsOverride.cards.length === 0;
      const promptText = typeof payload.prompt === "string" ? payload.prompt : "";
      const lockedCards = explicitOff
        ? baseCards
        : mergeTokenReferencedCards(baseCards, canvasStateRef.current.characterCards, promptText);
      let finalPayload: Record<string, unknown> = lockedCards.length
        ? applyCharacterCardsToPayload(payload as CardAwareGeneratePayload, lockedCards as CharacterCard[], cardsOverride ? { referenceScope: cardsOverride.referenceScope } : undefined)
        : payload;
      // 2026-08-27 LoRA 注入（自专业工作站等价接线）：模型支援才带，单选铁律一个 id。
      const lora = selectedLoraRef.current;
      if (lora) {
        const modelId = typeof finalPayload.model === "string" && finalPayload.model ? finalPayload.model : undefined;
        const supportsLora = modelId ? generationCapabilities(modelId)?.lora === true : true;
        if (supportsLora) {
          finalPayload = { ...finalPayload, loraModelVersionIds: [lora.versionId] };
        }
      }
      // 专案风格绑定注入（P1-8／对称差 D34）：呼叫端带 id 进 route（route 端只做 id→全文素材化，
      // 不自行读 CanvasProject.styleId，见 route:202-206）；无绑定＝不新增键（逐位零回归）。
      finalPayload = withProjectStyleId(finalPayload, canvasStateRef.current.styleId);
      const res = await fetch(`/api/canvas/generate`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(finalPayload),
        signal,
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; images?: CanvasGeneratedImage[]; error?: string }
        | null;
      if (!res.ok || !data?.ok || !data.images?.length) {
        throw new Error(data?.error || `生成失败（${res.status}）`);
      }
      return data.images;
    },
    [canvasStateRef],
  );

  /**
   * 原地生成：结果回填该节点本体（A4 / A12 重试 / agent run_generation 共用）。
   * 语义接线（2026-08-22）：连入的 prompt 节点文本自动作为 prompt 前缀、
   * 连入的 reference 节点自动带图+角色进生成请求——手动 UI 与 agent 同一条路。
   * entityCardIds（可选，2026-09-24 WS6）：本镜正文行内 @ 引用过的素材卡 id——非空且
   * 命中时把参考集收窄到这批（referenceScope "referenced"）；缺省/全 miss＝既有全量行为。
   */
  const generateIntoNode = useCallback(
    async (
      nodeId: string,
      params: {
        prompt: string;
        model?: string;
        size?: string;
        sourceImage?: string | null;
        references?: CanvasGenerationReference[];
        entityCardIds?: string[];
      },
    ) => {
      const state = canvasStateRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      setIsGenerating(true);
      const semantic = resolveGenerationInputs(state.nodes, state.connections, nodeId);
      const finalPrompt = composeGenerationPrompt(semantic.promptParts, params.prompt);
      const references = mergeGenerationReferences(params.references ?? [], semantic.references);
      // 回分镜溯源（P1-1）：连入的 scene_3d 舞台 → 记下 directorStageId/shotId（读得回）。
      const sceneTrace = resolveSceneDirectorReferences(state.nodes, state.connections, nodeId).trace;
      const traceMetadata = sceneDirectorTraceMetadata(sceneTrace);
      const cardsOverride = resolveEntityCardsOverride(state.activeCharacterCards, params.entityCardIds);
      state.patchNodeMetadata(nodeId, {
        status: "loading",
        prompt: finalPrompt,
        ...(params.model ? { model: params.model } : {}),
        ...(params.size ? { size: params.size } : {}),
        ...traceMetadata,
        errorDetails: undefined,
      });
      try {
        const images = await callCanvasGenerate(
          {
            prompt: finalPrompt,
            model: params.model,
            size: params.size,
            count: 1,
            source_image: params.sourceImage ?? null,
            reference_images: references.map(({ url, role, name }) => ({ url, role, name })),
          },
          controller.signal,
          cardsOverride,
        );
        const img = images[0];
        state.patchNodeMetadata(
          nodeId,
          {
            content: img.url,
            status: "success",
            // 含 imageTaskId（LOD3 工程透析的 job 指针）；legacy 无 job＝清掉旧指针。
            ...generatedImageMetadata(img),
          },
          { history: false },
        );
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        state.patchNodeMetadata(
          nodeId,
          { status: "error", errorDetails: aborted ? "已停止" : error instanceof Error ? error.message : "生成失败" },
          { history: false },
        );
        if (!aborted) showError(error instanceof Error ? error.message : "生成失败");
      } finally {
        setIsGenerating(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [callCanvasGenerate, showError, canvasStateRef],
  );

  /**
   * 面板生成：空图片节点 count=1 原地回填；其余批次子节点插回。
   * entityCardIds（可选）：本镜正文行内 @ 引用过的素材卡 id——非空时把本镜的卡注入
   * 收窄到这几张（referenceScope "referenced"）；缺省不传＝既有全量锁定行为逐位元不变。
   */
  const handleGenerateFromNode = useCallback(
    async (
      nodeId: string,
      prompt: string,
      options: { model?: string; size?: string; quality?: string; count?: number; entityCardIds?: string[] },
    ) => {
      const state = canvasStateRef.current;
      const node = state.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const cardsOverride = resolveEntityCardsOverride(state.activeCharacterCards, options.entityCardIds);
      // @引用（显式选取）+ 连入 reference 节点（自动带入）→ 带角色的参考图清单。
      const panelRefs: CanvasGenerationReference[] = panelRefIds
        .map((id) => state.nodes.find((n) => n.id === id))
        .filter((n): n is CanvasNode => !!n && !!imageUrlOf(n))
        .map((n) => ({
          nodeId: n.id,
          url: imageUrlOf(n)!,
          role: n.type === CanvasNodeType.Reference ? toReferenceImageRole(n.metadata?.referenceRole) : "general",
          name: n.title || "参考图",
        }));
      const semantic = resolveGenerationInputs(state.nodes, state.connections, nodeId);
      const references = mergeGenerationReferences(panelRefs, semantic.references);
      const finalPrompt = composeGenerationPrompt(semantic.promptParts, prompt);
      const refNodeIds = references.map((r) => r.nodeId).filter((id): id is string => !!id);
      const count = Math.min(Math.max(1, options.count ?? 1), 4);
      const sourceUrl = imageUrlOf(node);

      // A4：空图片节点 + 单张 → 原地变身，不另建节点。
      if (node.type === CanvasNodeType.Image && !sourceUrl && count === 1) {
        setPromptPanelNodeId(null);
        await generateIntoNode(nodeId, { prompt, model: options.model, size: options.size, references, entityCardIds: options.entityCardIds });
        setPanelRefIds([]);
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setIsGenerating(true);
      try {
        const images = await callCanvasGenerate(
          {
            prompt: finalPrompt,
            model: options.model,
            size: options.size,
            quality: options.quality,
            count,
            source_image: sourceUrl,
            reference_images: references.map(({ url, role, name }) => ({ url, role, name })),
          },
          controller.signal,
          cardsOverride,
        );
        const existing = node.batchChildren?.length ?? 0;
        const ts = Date.now().toString(36);
        images.forEach((img, i) => {
          const child = createBatchChildNode(node, img.url, existing + i, existing + images.length, {
            id: `${nodeId}-b-${ts}-${i}`,
            metadata: {
              prompt: finalPrompt,
              model: options.model,
              size: options.size,
              ...generatedImageMetadata(img),
              ...(refNodeIds.length > 0 ? { referenceNodeIds: [...refNodeIds] } : {}),
            },
          });
          state.addBatchChild(nodeId, child);
          state.addConnection(nodeId, child.id);
        });
        setPromptPanelNodeId(null);
        setPanelRefIds([]);
        setPanelEntityIds?.([]);
        const size = viewportSizeRef.current;
        if (size.width > 0) state.fitView(size.width, size.height);
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        if (!aborted) showError(error instanceof Error ? error.message : "生成失败，请稍后再试");
      } finally {
        setIsGenerating(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [panelRefIds, generateIntoNode, callCanvasGenerate, showError, canvasStateRef, setPromptPanelNodeId, setPanelRefIds, setPanelEntityIds, viewportSizeRef],
  );

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** A12：失败重试——沿用节点 metadata 保存的参数，结果回填原节点。 */
  const retryNode = useCallback(
    (nodeId: string) => {
      const node = canvasStateRef.current.nodes.find((n) => n.id === nodeId);
      const prompt = node?.metadata?.prompt;
      if (!node || !prompt) {
        showError("该节点没有保存生成参数，无法重试");
        return;
      }
      const references: CanvasGenerationReference[] = (node.metadata?.referenceNodeIds ?? [])
        .map((id): CanvasGenerationReference | null => {
          const refNode = canvasStateRef.current.nodes.find((n) => n.id === id);
          const url = imageUrlOf(refNode);
          if (!refNode || !url) return null;
          const role: ReferenceImageRole =
            refNode.type === CanvasNodeType.Reference ? toReferenceImageRole(refNode.metadata?.referenceRole) : "general";
          return { nodeId: refNode.id, url, role, name: refNode.title || "参考图" };
        })
        .filter((r): r is CanvasGenerationReference => r !== null);
      void generateIntoNode(nodeId, {
        prompt,
        model: node.metadata?.model,
        size: node.metadata?.size,
        sourceImage: node.metadata?.source_image ?? null,
        references,
      });
    },
    [generateIntoNode, showError, canvasStateRef],
  );

  // ── 高清放大
  const upscaleNode = useCallback(
    async (nodeId: string) => {
      const state = canvasStateRef.current;
      const node = state.nodes.find((n) => n.id === nodeId);
      const url = imageUrlOf(node);
      if (!node || !url) return;
      if (!url.startsWith("http")) {
        showError("本地编辑结果暂不支持高清放大（需要先生成为在线图片）");
        return;
      }
      const headers = buildAuthHeaders(true);
      if (!headers) {
        showError("请先登录再使用高清放大");
        return;
      }
      setUpscalingIds((prev) => new Set(prev).add(nodeId));
      try {
        const size =
          node.metadata?.naturalWidth && node.metadata?.naturalHeight
            ? `${node.metadata.naturalWidth}x${node.metadata.naturalHeight}`
            : undefined;
        const res = await fetch("/api/pixai/upscale", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ image: url, factor: 2, ...(size ? { size } : {}) }),
        });
        const body = (await res.json().catch(() => null)) as
          | { data?: Array<{ url?: string }>; url?: string; images?: Array<{ url?: string }>; message?: string }
          | null;
        if (!res.ok) throw new Error(body?.message || `放大失败（${res.status}）`);
        const resultUrl =
          (Array.isArray(body?.data) ? body.data[0]?.url : undefined) ||
          body?.url ||
          (Array.isArray(body?.images) ? body.images[0]?.url : undefined);
        if (!resultUrl) throw new Error("放大失败：未返回图片");
        const child: CanvasNode = {
          id: `${nodeId}-up-${Date.now().toString(36)}`,
          type: CanvasNodeType.Image,
          title: `${node.title} · 高清`,
          position: { x: node.position.x + node.width + 60, y: node.position.y },
          width: node.width,
          height: node.height,
          moved: true,
          metadata: { content: resultUrl, status: "success", source_image: url, prompt: node.metadata?.prompt },
        };
        state.addNodes([child], [{ id: `conn-${nodeId}-${child.id}`, fromNodeId: nodeId, toNodeId: child.id }]);
        setSelectedIds(new Set([child.id]));
        state.selectNode(child.id);
      } catch (error) {
        showError(error instanceof Error ? error.message : "放大失败");
      } finally {
        setUpscalingIds((prev) => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
      }
    },
    [showError, canvasStateRef, setSelectedIds],
  );

  // ── 影片取帧（2026-09-28）：画布视频节点动作「截帧／序列帧」
  //
  // 为什么在这里而不是新开一套：这条路与 upscaleNode 同款（节点动作 → 拿结果 → 建图片节点 → 连线），
  // 复用的既有轮子有两条：
  //   ① 计划层 `POST /api/canvas/video-frames`（纯函数 planFrameExtraction，与客户端同一份语义）；
  //   ② 像素层 `extractFramesAtTimes`（video-frames.ts 既有 seek/drawImage/toBlob 管线，不重写）。
  // 视频元素在这里自建（与 extractFramesFromFile 建离屏 <video> 同法）：不动用户正在播放的节点元素，
  // 序列帧连抽多次也不会有可见抖动。
  const [extractingFramesIds, setExtractingFramesIds] = useState<Set<string>>(new Set());

  const extractFramesFromNode = useCallback(
    async (nodeId: string, action: "current" | "sequence", atSec?: number) => {
      const state = canvasStateRef.current;
      const node = state.nodes.find((n) => n.id === nodeId);
      const content = node?.metadata?.content;
      if (!node || !content || !content.startsWith("https://")) {
        showError("该视频没有可用的在线地址，无法取帧（仅支持 https 视频）");
        return;
      }
      const headers = buildAuthHeaders(true);
      if (!headers) {
        showError("请先登录再取帧");
        return;
      }
      if (extractingFramesIds.has(nodeId)) return;
      setExtractingFramesIds((prev) => new Set(prev).add(nodeId));
      try {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.muted = true;
        (video as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
        // canvas 导出必须拿到未污染像素：跨域视频要显式请求 CORS，否则 toBlob 会抛 SecurityError。
        // 上游 CDN 不放 CORS 头时读取会直接失败——那时如实报错，不假装成功。
        video.crossOrigin = "anonymous";
        video.src = content;
        await waitForMetadata(video);
        const durationSec = video.duration;
        if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("读不到视频时长");

        const payload =
          action === "current"
            ? { videoUrl: content, durationSec, mode: "current", atSec: typeof atSec === "number" ? atSec : 0 }
            : // 序列帧默认格数照竞品 tileFrameCount：clamp(round(秒数*1.5), 4, 9)（长片 9 格封顶，不默认抽数百帧）
              { videoUrl: content, durationSec, mode: "sequence", count: tileFrameCount(durationSec) };
        const res = await fetch("/api/canvas/video-frames", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = (await res.json().catch(() => null)) as
          | { success?: boolean; error?: string; timesSec?: number[]; frames?: { fileName?: string }[] }
          | null;
        // 超上限 / 超时长 / 参数非法都在这里被服务端明确拒绝（提示原样透出，绝不静默截断）。
        if (!res.ok || !body?.success || !body.timesSec?.length) {
          throw new Error(body?.error || `取帧计划失败（${res.status}）`);
        }

        const sample: VideoElementSample = {
          video,
          sample: { kind: "video", url: content, name: node.title, mime: "video/mp4", size: 0 },
        };
        const frames = await extractFramesAtTimes(sample, body.timesSec);
        // 落节点用 data URL：与画布图片编辑器「本地像素结果」同款（Object URL 刷新即失效，
        // data URL 才能随画布持久化、下载与再次作为参考图）。
        const dataUrls = await Promise.all(frames.map((frame) => blobToDataUrl(frame.blob)));
        const newNodes: CanvasNode[] = frames.map((frame, i) => ({
          id: `${nodeId}-vf-${Date.now().toString(36)}-${i}`,
          type: CanvasNodeType.Image,
          // 档名照竞品：frame-2_500s.jpg（档名用请求时间；下载与 alt 都吃这个标题）
          title: body.frames?.[i]?.fileName || frameFileName(frame.timeSec),
          position: {
            x: node.position.x + node.width + 60 + (i % 3) * (node.width + 24),
            y: node.position.y + Math.floor(i / 3) * (node.height + 24),
          },
          width: node.width,
          height: node.height,
          moved: true,
          metadata: {
            content: dataUrls[i],
            status: "success",
            source_image: content,
          },
        }));
        const newConns = newNodes.map((created) => ({
          id: `conn-${nodeId}-${created.id}`,
          fromNodeId: nodeId,
          toNodeId: created.id,
        }));
        state.addNodes(newNodes, newConns);
        setSelectedIds(new Set(newNodes.map((created) => created.id)));
        if (newNodes[0]) state.selectNode(newNodes[0].id);
        const size = viewportSizeRef.current;
        if (size.width > 0) state.fitView(size.width, size.height);
      } catch (error) {
        showError(error instanceof Error ? `取帧失败：${error.message}` : "取帧失败");
      } finally {
        setExtractingFramesIds((prev) => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
      }
    },
    [canvasStateRef, extractingFramesIds, showError, setSelectedIds, viewportSizeRef],
  );

  // ── Wave C：agent run_generation 代跑（确认闸允许后执行）
  const runAgentGeneration = useCallback(
    (items: { nodeId: string; prompt?: string; model?: string; size?: string; count?: number }[]) => {
      for (const item of items) {
        const node = canvasStateRef.current.nodes.find((n) => n.id === item.nodeId);
        if (!node) continue;
        const prompt = item.prompt ?? node.metadata?.prompt;
        if (!prompt) continue;
        if ((item.count ?? 1) <= 1) {
          void generateIntoNode(item.nodeId, { prompt, model: item.model ?? node.metadata?.model, size: item.size ?? node.metadata?.size });
        } else {
          void handleGenerateFromNode(item.nodeId, prompt, { model: item.model, size: item.size, count: item.count });
        }
      }
    },
    [generateIntoNode, handleGenerateFromNode, canvasStateRef],
  );

  return {
    isGenerating,
    upscalingIds,
    extractingFramesIds,
    callCanvasGenerate,
    generateIntoNode,
    handleGenerateFromNode,
    stopGeneration,
    retryNode,
    upscaleNode,
    extractFramesFromNode,
    runAgentGeneration,
  };
}
