// 角色/場景卡域（P2 跨鏡頭一致性）—— 自 use-canvas-chat.ts 外圍搬遷。
// characterCards = 用戶全部卡；activeCardIds = 鎖定到本畫布項目的卡。
// 主 hook 經回傳值組裝 UseCanvasChatReturn（37 成員隱含合約的一部分）。
//
// REQ-B2b：本域是**讀取端作用域閘**的落點——
//   1. `activeCharacterCards`（生成注入與 agent 快照的唯一來源）先過作用域裁決：
//      跨項目、未顯式分享的卡一律剔除（fail-closed）；個人卡（含所有 legacy 卡）逐位不變。
//      與寫入端 `/api/canvas/projects` 的 filterCardIdsForProject 共用同一把尺
//      （asset-scope.resolveAssetScopeVisibility），兩端不可能漂移。
//   2. `applyMountCopyChange` 把掛用產生的**本地副本**鎖進 cardIds（copy-on-use 生效的硬接線）。
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteCharacterCards as deleteCharacterCardsRemote,
  listCharacterCards as fetchCharacterCardsRemote,
  saveCharacterCard as saveCharacterCardRemote,
} from "@/lib/character-card-client";
import { listProjectSharesIn } from "@/lib/project-assets-client";
import { applyCopyLockChange, filterLockedCardsForProjectUse } from "@/lib/asset-scope";
import type { AssetShareRecord } from "@/lib/asset-scope";
import type { CharacterCard } from "@/lib/character-cards";

export interface UseCanvasCardsInput {
  /**
   * 當前項目 id 讀取器（＝ canvas 的 getProjectId）。缺省＝無項目上下文
   * （項目歸屬的卡一律不可用，個人卡照用——fail-closed 不猜）。
   */
  getProjectId?: () => string | null;
}

/** 角色/場景卡域：卡列表、項目級鎖定、upsert/remove/toggle 與進頁載入。 */
export function useCanvasCards(options: UseCanvasCardsInput = {}) {
  const [characterCards, setCharacterCards] = useState<CharacterCard[]>([]);
  const [activeCardIds, setActiveCardIds] = useState<string[]>([]);
  /**
   * 授權**進來**某項目的分享表（讀取閘判「分享進來」用）。
   * 帶 projectId 一起存：專案切換後舊表**當場失效**（寧可少放行一張分享進來的卡，
   * 也不拿別人的授權放行本項目——fail-closed）。
   */
  const [shareTable, setShareTable] = useState<{ projectId: string; shares: AssetShareRecord[] } | null>(null);
  // 讀取器一律從 ref 讀**最新**值，且用穩定的包裝函式當依賴：
  // 父層傳進來的 inline 箭頭每次 render 都是新函式，直接進 effect 依賴＝每次 render 都發請求。
  const getProjectIdRef = useRef(options.getProjectId);
  getProjectIdRef.current = options.getProjectId;
  const readProjectId = useCallback((): string | null => getProjectIdRef.current?.() ?? null, []);

  // ── refs：給不參與 render 的路徑讀最新值
  const characterCardsRef = useRef(characterCards);
  characterCardsRef.current = characterCards;
  const activeCardIdsRef = useRef(activeCardIds);
  activeCardIdsRef.current = activeCardIds;

  /** 進頁載入用戶全部卡。失敗靜默：卡是順手鎖定的配置，不打擾創作。 */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetchCharacterCardsRemote();
      if (!cancelled && res.ok && res.data) setCharacterCards(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 分享表的取用簽章（穩定字串＝不會每次 render 都變，故不會造成請求風暴）：
   * 只有「手上真的有別的項目歸屬的卡」時才非空——純個人的畫布（現存所有資料）
   * 零額外請求＝零行為漂移；一旦出現跨項目卡，切項目／換鎖定集就重讀一次。
   */
  const shareTableSignature = useMemo(() => {
    const projectId = readProjectId();
    if (!projectId) return "";
    const hasForeign = characterCards.some(
      (c) => c.scope?.owner === "project" && (c.scope.projectId ?? "") !== projectId,
    );
    return hasForeign ? `${projectId}|${activeCardIds.join(",")}` : "";
  }, [characterCards, activeCardIds, readProjectId]);

  useEffect(() => {
    if (!shareTableSignature) {
      setShareTable(null);
      return;
    }
    const projectId = shareTableSignature.split("|")[0];
    let cancelled = false;
    void (async () => {
      const res = await listProjectSharesIn(projectId);
      if (cancelled) return;
      setShareTable({ projectId, shares: res.ok && res.data ? res.data : [] });
    })();
    return () => {
      cancelled = true;
    };
  }, [shareTableSignature]);

  /**
   * 鎖定中的卡實體：生成時注入的就是這份（applyCharacterCards 按 id 序冪等注入）。
   * REQ-B2b 讀取端作用域閘：不可見（跨項目、未分享）的卡不進這份集合——fail-closed。
   * 閘函式（filterLockedCardsForProjectUse）與伺服器端寫入閘共用同一裁決尺。
   */
  const activeCharacterCards = useMemo(() => {
    const projectId = readProjectId();
    const shares = shareTable && shareTable.projectId === projectId ? shareTable.shares : [];
    const locked = characterCards.filter((c) => activeCardIds.includes(c.id));
    return filterLockedCardsForProjectUse(locked, { projectId, shares });
  }, [characterCards, activeCardIds, shareTable, readProjectId]);

  /**
   * REQ-B2b：掛用副本的鎖定/解鎖（面板掛用/解除後呼叫）。
   * 先重讀卡清單（讓新副本實體可解析），再改項目鎖定集——順序不可顛倒，
   * 否則 setActiveCardIds 之後的那一幀仍查不到卡實體＝生成漏注入。
   */
  const applyMountCopyChange = useCallback(
    async (change: { locked: string[]; unlocked: string[] }) => {
      const locked = change.locked.filter(Boolean);
      const unlocked = change.unlocked.filter(Boolean);
      if (!locked.length && !unlocked.length) return;
      if (locked.length) {
        const res = await fetchCharacterCardsRemote();
        if (res.ok && res.data) setCharacterCards(res.data);
      }
      setActiveCardIds((prev) => applyCopyLockChange(prev, { locked, unlocked }));
    },
    [],
  );

  const upsertCharacterCard = useCallback(async (card: CharacterCard): Promise<boolean> => {
    const res = await saveCharacterCardRemote(card);
    if (!res.ok) return false;
    setCharacterCards((prev) => [card, ...prev.filter((c) => c.id !== card.id)]);
    return true;
  }, []);

  const removeCharacterCard = useCallback(async (id: string): Promise<boolean> => {
    const res = await deleteCharacterCardsRemote([id]);
    if (!res.ok) return false;
    setCharacterCards((prev) => prev.filter((c) => c.id !== id));
    // 刪卡同時解除鎖定（該 id 不再出現在項目 cardIds）。
    setActiveCardIds((prev) => prev.filter((x) => x !== id));
    return true;
  }, []);

  const toggleCharacterCard = useCallback((id: string) => {
    setActiveCardIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  return {
    characterCards,
    activeCardIds,
    activeCharacterCards,
    setActiveCardIds,
    /** REQ-B2b：掛用副本的鎖定/解鎖（面板 onCopyChange 的唯一入口）。 */
    applyMountCopyChange,
    characterCardsRef,
    activeCardIdsRef,
    upsertCharacterCard,
    removeCharacterCard,
    toggleCharacterCard,
  };
}
