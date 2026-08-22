// 角色/場景卡域（P2 跨鏡頭一致性）—— 自 use-canvas-chat.ts 外圍搬遷。
// characterCards = 用戶全部卡；activeCardIds = 鎖定到本畫布項目的卡。
// 主 hook 經回傳值組裝 UseCanvasChatReturn（37 成員隱式合約的一部分）。
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteCharacterCards as deleteCharacterCardsRemote,
  listCharacterCards as fetchCharacterCardsRemote,
  saveCharacterCard as saveCharacterCardRemote,
} from "@/lib/character-card-client";
import type { CharacterCard } from "@/lib/character-cards";

/** 角色/場景卡域：卡列表、項目級鎖定、upsert/remove/toggle 與進頁載入。 */
export function useCanvasCards() {
  const [characterCards, setCharacterCards] = useState<CharacterCard[]>([]);
  const [activeCardIds, setActiveCardIds] = useState<string[]>([]);

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

  /** 鎖定中的卡實體：生成時注入的就是這份（applyCharacterCards 按 id 序冪等注入）。 */
  const activeCharacterCards = useMemo(
    () => characterCards.filter((c) => activeCardIds.includes(c.id)),
    [characterCards, activeCardIds],
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
    characterCardsRef,
    activeCardIdsRef,
    upsertCharacterCard,
    removeCharacterCard,
    toggleCharacterCard,
  };
}
