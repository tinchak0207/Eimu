/**
 * use-canvas-generation —— CanvasEmbed 生成編排域（自 CanvasEmbed.tsx L621-1002 機械搬遷，符號/依賴陣列不變）：
 *   callCanvasGenerate → generateIntoNode → handleGenerateFromNode → stopGeneration/retryNode/upscaleNode → runAgentGeneration。
 * P2 掛接點：鎖定的角色/場景卡在 callCanvasGenerate 注入——手動面板、agent run_generation、
 * 編輯器派生全部經過這一條路，保證項目級鎖定對所有畫布生成生效。
 * 認證立場：生成/超分走 Bearer + x-user-id，未登入誠實報錯。
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
import { generationCapabilities } from "@/lib/generation-model-catalog";
import type { SelectedLora } from "@/components/canvas-workstation/panels/LoraLibraryPanel";
import { buildAuthHeaders, imageUrlOf } from "./embed-helpers";

/**
 * 行內 @ 引用 → 本鏡參考集收窄覆寫（純函數，唯一推導入口；面板批次與原地生成共用同一契約）。
 *   - entityCardIds 缺省/空 → undefined（不覆寫＝既有全量鎖定行為）
 *   - 有 id 但全對不到卡 → undefined（**刻意**：收窄到空集合會讓參考圖靜默全空，
 *     比不收窄更壞；退回既有全量行為）
 *   - 命中 → { cards, referenceScope: "referenced" }，卡順序沿用 cards 原序（不重排；
 *     注入端穩定序由 applyCharacterCards 負責）
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

export interface UseCanvasGenerationInput {
  /** canvas 最新值鏡像 ref（由組件殼持有並傳入）。 */
  canvasStateRef: RefObject<UseCanvasChatReturn>;
  /** 視口尺寸鏡像 ref（生成後 fitView 用）。 */
  viewportSizeRef: RefObject<{ width: number; height: number }>;
  /** 錯誤提示（交互域 hook 回傳）。 */
  showError: (message: string) => void;
  /** 生成面板選中的參考圖節點 id。 */
  panelRefIds: string[];
  setPromptPanelNodeId: Dispatch<SetStateAction<string | null>>;
  setPanelRefIds: Dispatch<SetStateAction<string[]>>;
  /** 生成面板行內 @ 引用的素材卡 id（生成落地後清空；與 setPanelRefIds 同款）。 */
  setPanelEntityIds?: Dispatch<SetStateAction<string[]>>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  /** 當前選中的 LoRA（2026-08-27 自專業工作站遷入；null = 不帶）。 */
  selectedLora?: SelectedLora | null;
}

/** 生成編排域回傳：狀態 + handlers（消費端：組件殼 / menuItems 工廠 / 節點掛載）。 */
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
  // 最新 LoRA 鏡像 ref：callCanvasGenerate 的 useCallback 不因 LoRA 選擇換身份。
  const selectedLoraRef = useRef(selectedLora);
  selectedLoraRef.current = selectedLora;

  /**
   * 生成唯一出口。第三參數（可選）＝本鏡參考集覆寫：
   *   - 不傳：逐位元既有行為（用 canvasStateRef 的 activeCharacterCards 全量注入）
   *   - 傳：用指定的卡子集注入，並把 referenceScope 交給 applyCharacterCardsToPayload
   *     （"referenced" = 本鏡只行內 @ 引用了這幾張卡，其餘鎖定卡不進本鏡）
   * 卡集最後再併入**本段 prompt token 引用到的卡**（mergeTokenReferencedCards：卡在庫即可
   * 被 @ 引用，不必先手動鎖定；零 token／全未命中＝同一陣列參考，逐位元等價）。
   */
  const callCanvasGenerate = useCallback(
    async (
      payload: Record<string, unknown>,
      signal: AbortSignal,
      cardsOverride?: { cards: CharacterCard[]; referenceScope: "all" | "referenced" },
    ) => {
      const headers = buildAuthHeaders();
      if (!headers) throw new Error("请先登录再生成图片");
      const baseCards = cardsOverride?.cards ?? canvasStateRef.current.activeCharacterCards ?? [];
      // 本段提示詞 token 就地解析（2026-09-25）：卡在庫即可被 @ 引用，不必先手動鎖定——
      // 把命中 token 的卡併入注入集（聯集，不自動鎖定、不改鎖定語義）。
      // 顯式關閉注入（cards: []，資產重生成那條路）＝不併入：該 payload 的參考圖已顯式給定，
      // 再注入一次會把「要被換掉的那張圖」同時當參考（把錯誤傳染給新圖）。
      const explicitOff = !!cardsOverride && cardsOverride.cards.length === 0;
      const promptText = typeof payload.prompt === "string" ? payload.prompt : "";
      const lockedCards = explicitOff
        ? baseCards
        : mergeTokenReferencedCards(baseCards, canvasStateRef.current.characterCards, promptText);
      let finalPayload: Record<string, unknown> = lockedCards.length
        ? applyCharacterCardsToPayload(payload as CardAwareGeneratePayload, lockedCards as CharacterCard[], cardsOverride ? { referenceScope: cardsOverride.referenceScope } : undefined)
        : payload;
      // 2026-08-27 LoRA 注入（自專業工作站等價接線）：模型支援才帶，單選鐵律一個 id。
      const lora = selectedLoraRef.current;
      if (lora) {
        const modelId = typeof finalPayload.model === "string" && finalPayload.model ? finalPayload.model : undefined;
        const supportsLora = modelId ? generationCapabilities(modelId)?.lora === true : true;
        if (supportsLora) {
          finalPayload = { ...finalPayload, loraModelVersionIds: [lora.versionId] };
        }
      }
      const res = await fetch(`/api/canvas/generate`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(finalPayload),
        signal,
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; images?: { url: string; cost_coins: number | null; natural_width: number | null; natural_height: number | null }[]; error?: string }
        | null;
      if (!res.ok || !data?.ok || !data.images?.length) {
        throw new Error(data?.error || `生成失败（${res.status}）`);
      }
      return data.images;
    },
    [canvasStateRef],
  );

  /**
   * 原地生成：結果回填該節點本體（A4 / A12 重試 / agent run_generation 共用）。
   * 語義接線（2026-08-22）：連入的 prompt 節點文本自動作為 prompt 前綴、
   * 連入的 reference 節點自動帶圖+角色進生成請求——手動 UI 與 agent 同一條路。
   * entityCardIds（可選，2026-09-24 WS6）：本鏡正文行內 @ 引用過的素材卡 id——非空且
   * 命中時把參考集收窄到這批（referenceScope "referenced"）；缺省/全 miss＝既有全量行為。
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
      const cardsOverride = resolveEntityCardsOverride(state.activeCharacterCards, params.entityCardIds);
      state.patchNodeMetadata(nodeId, {
        status: "loading",
        prompt: finalPrompt,
        ...(params.model ? { model: params.model } : {}),
        ...(params.size ? { size: params.size } : {}),
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
            ...(typeof img.cost_coins === "number" ? { cost_coins: img.cost_coins } : {}),
            ...(img.natural_width ? { naturalWidth: img.natural_width } : {}),
            ...(img.natural_height ? { naturalHeight: img.natural_height } : {}),
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
   * 面板生成：空圖片節點 count=1 原地回填；其餘批次子節點插回。
   * entityCardIds（可選）：本鏡正文行內 @ 引用過的素材卡 id——非空時把本鏡的卡注入
   * 收窄到這幾張（referenceScope "referenced"）；缺省不傳＝既有全量鎖定行為逐位元不變。
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
      // @引用（顯式選取）+ 連入 reference 節點（自動帶入）→ 帶角色的參考圖清單。
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

      // A4：空圖片節點 + 單張 → 原地變身，不另建節點。
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
              ...(typeof img.cost_coins === "number" ? { cost_coins: img.cost_coins } : {}),
              ...(img.natural_width ? { naturalWidth: img.natural_width } : {}),
              ...(img.natural_height ? { naturalHeight: img.natural_height } : {}),
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

  /** A12：失敗重試——沿用節點 metadata 保存的參數，結果回填原節點。 */
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
      const headers = buildAuthHeaders();
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

  // ── Wave C：agent run_generation 代跑（確認閘允許後執行）
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
    callCanvasGenerate,
    generateIntoNode,
    handleGenerateFromNode,
    stopGeneration,
    retryNode,
    upscaleNode,
    runAgentGeneration,
  };
}
