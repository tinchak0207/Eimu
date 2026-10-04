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
import { CARD_NAME_KEYS, toCardMetadataName } from "@/lib/canvas/layout";
import { emittedCardsForNodes, emittedEntityOf, entityCardIdForNode } from "@/lib/agent-output-cards";
import type { AgentOutputNodeRef, EmittedCardsResult, ShotEntityBackfill } from "@/lib/agent-output-cards";
import { invalidateEntityCardIndex } from "@/components/entities/entity-chip";

export interface UseCanvasCardsInput {
  /**
   * 當前項目 id 讀取器（＝ canvas 的 getProjectId）。缺省＝無項目上下文
   * （項目歸屬的卡一律不可用，個人卡照用——fail-closed 不猜）。
   */
  getProjectId?: () => string | null;
}

/** 自動落卡的可選出口（回填分鏡引用／寫落卡標記要 patchNodeMetadata，由 use-canvas-chat 注入）。 */
export interface AutoAnchorEmittedCardsOptions {
  /**
   * 回填套用出口。缺省＝**只回報不寫**——回傳的 `backfilled` 也會是 0
   * （沒人寫就不算回填過，不謊報成功）。
   */
  onShotBackfill?: (items: readonly ShotEntityBackfill[]) => void;
  /**
   * 每張**新建成功**的卡 → （節點 id, 卡 id）標記出口（呼叫端負責 patchNodeMetadata
   * 寫 `metadata.entityCardId`）。缺省＝不寫：標記是冪等的加速器（真正的冪等靠
   * 決定性卡 id ＋ existing 比對），但**不寫＝重載後「這顆節點建過卡」這件事沒有痕跡**，
   * 只能靠卡實體反推（見 agent-output-cards 的耐久回填）。
   */
  onEntityCardId?: (nodeId: string, cardId: string) => void;
  /**
   * 卡名**第二來源**（C：卡名軟耦合硬化）。`emitsEntity.nameFrom:"input"` 靠 agent 把
   * 名字寫進 metadata 的三個候選鍵；agent 不照做時卡名只能退回節點標題（「正面」）。
   * 呼叫端在此回**上游文本節點的第一行非空文字**（配方＝`upstreamTextNameFor`）。
   * 缺省＝沒有第二來源（既有行為逐位元不變）。
   */
  resolveName?: (ref: AgentOutputNodeRef) => string | undefined;
  /**
   * 卡名**真的**退回了節點標題的節點（＝落卡模組的 `nameFallbacks`：`nameFrom:"input"` ∧
   * 三鍵全空 ∧ **第二來源也取不到**）。呼叫端負責讓它可見（toast/console）。
   * 缺省＝只回報不顯示。真源在落卡模組（它才知道卡最後叫什麼），本檔不重算一遍。
   */
  onNameFallback?: (fallbacks: EmittedCardsResult["nameFallbacks"]) => void;
}

/** 鎖定併入：保留既有鎖定集與其順序，只補沒有的 id（不覆蓋用戶/agent 的選擇）。 */
function mergeAnchoredIds(prev: readonly string[], added: readonly string[]): string[] {
  const missing = added.filter((id) => !prev.includes(id));
  return missing.length ? [...prev, ...missing] : [...prev];
}

// ─────────────────────────────────── 卡名第二來源（C，2026-09-24）

/** metadata 袋子讀取（`CanvasNodeMetadata` 是 interface，無 index signature）。 */
function asBag(metadata: unknown): Record<string, unknown> | undefined {
  return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : undefined;
}

/** URL 形態的交付物（圖/媒體）不是文本——它的 content 不當卡名來源。 */
const DELIVERABLE_URL_PATTERN = /^(https?:|data:)/i;

/**
 * 上游**文本**節點的名字候選：`metadata.content` 的第一行非空文字（trim、卡名同尺上限
 * 100）。content 本身是交付物 URL（http(s)/data:）＝該節點不是文本節點 → `undefined`
 *（不拿圖 URL 當卡名）。
 */
function firstTextLineOf(metadata: unknown): string | undefined {
  const content = asBag(metadata)?.content;
  if (typeof content !== "string") return undefined;
  for (const line of content.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    if (DELIVERABLE_URL_PATTERN.test(text)) return undefined;
    return toCardMetadataName(text);
  }
  return undefined;
}

/**
 * 由上游文本節點內容取卡名候選（C 第二來源的純函式）：**只向上走**——
 * 連線語義 `fromNodeId → toNodeId`，故「祖先」＝`toNodeId === 當前節點` 的 `fromNodeId`
 *（現場欄位真名＝`CanvasConnection.fromNodeId/toNodeId`）。逐層**廣度優先**（最近的上游
 * 先看，同層按連線出現序），回傳第一個有非空文本 content 的祖先的第一行文字；
 * 自己永不被選；已訪問集合防環（環上不無限迴圈）。找不到
 *（沒上游／上游全是圖、媒體或空文本）→ `undefined`（呼叫端據此退回節點標題）。
 */
export function upstreamTextNameFor(
  nodeId: string,
  nodes: readonly { id: string; metadata?: object | null }[],
  connections: readonly { fromNodeId: string; toNodeId: string }[],
): string | undefined {
  if (!nodeId) return undefined;
  const metadataById = new Map<string, object | null | undefined>();
  for (const node of nodes ?? []) {
    if (node && typeof node.id === "string") metadataById.set(node.id, node.metadata);
  }
  // 反向鄰接：child → 直接上游（去重、保留連線出現序）
  const parentsByChild = new Map<string, string[]>();
  for (const conn of connections ?? []) {
    if (!conn || typeof conn.fromNodeId !== "string" || typeof conn.toNodeId !== "string") continue;
    const parents = parentsByChild.get(conn.toNodeId);
    if (!parents) parentsByChild.set(conn.toNodeId, [conn.fromNodeId]);
    else if (!parents.includes(conn.fromNodeId)) parents.push(conn.fromNodeId);
  }
  const visited = new Set<string>([nodeId]); // 跳過自己 ＋ 防環
  let frontier = parentsByChild.get(nodeId) ?? [];
  while (frontier.length) {
    const next: string[] = [];
    for (const parentId of frontier) {
      if (visited.has(parentId)) continue;
      visited.add(parentId);
      const text = firstTextLineOf(metadataById.get(parentId));
      if (text) return text;
      next.push(...(parentsByChild.get(parentId) ?? []));
    }
    frontier = next;
  }
  return undefined;
}

/** 卡名三鍵的第一個非空值（讀卡名真源的同一把尺）＝名字真的在 metadata 裡。 */
function declaredCardNameKey(ref: AgentOutputNodeRef): string | undefined {
  const bag = asBag(ref.metadata);
  for (const key of CARD_NAME_KEYS) {
    const name = toCardMetadataName(bag?.[key]);
    if (name) return name;
  }
  return undefined;
}

/**
 * 把第二來源的名字注入 **metadata 副本**的 `input`（`nameFrom:"input"` 的第一個候選鍵；
 * 配方真源＝`layout.CARD_NAME_KEYS`／消費端＝`agent-output-cards.NAME_FROM_INPUT_KEYS`）。
 * 落卡模組是純函式、只認節點投影 → 第二來源只能從這個入口進去。
 *
 * 回傳**原參考、零改動**當：沒有出口／沒宣告 emitsEntity／`nameFrom !== "input"`／
 * agent 已寫了名字／上游也取不到名字。**不改動原節點 metadata**（只淺拷貝袋子）。
 */
export function withSecondSourceName(
  ref: AgentOutputNodeRef,
  resolveName?: (ref: AgentOutputNodeRef) => string | undefined,
): AgentOutputNodeRef {
  if (!resolveName || !ref || typeof ref.id !== "string" || !ref.id) return ref;
  const spec = emittedEntityOf(ref);
  if (!spec || spec.nameFrom !== "input") return ref;
  if (declaredCardNameKey(ref)) return ref; // agent 照做了，第二來源不介入
  let resolved: string | undefined;
  try {
    resolved = resolveName(ref);
  } catch {
    resolved = undefined; // 第二來源是自己的事，壞掉不影響落卡主線
  }
  const name = toCardMetadataName(resolved);
  if (!name) return ref;
  return { ...ref, metadata: { ...(asBag(ref.metadata) ?? {}), input: name } };
}

// ─────────────────────────────────── 落卡計畫的寫入（B 漸進聚合，2026-09-24）

/**
 * 計畫的「就地更新」桶（聚合是漸進的：sibling 的圖晚到 → 同一張卡要多一張參考圖）。
 * 取 `plan.updatedCards`（真源＝`agent-output-cards.ts` 的計劃；由該檔比對參考圖 url 集合
 * 後給出——名稱/prompt/批准狀態不在它的判準裡，故本檔只負責**落盤**，不重算）。
 * `Array.isArray` 守衛：缺席／髒形＝空 ⇒ 不無中生有寫盤（舊版計畫零行為漂移）。
 */
export function emittedUpdateCards(plan: EmittedCardsResult): CharacterCard[] {
  const raw = plan?.updatedCards;
  if (!Array.isArray(raw)) return [];
  return raw.filter((card): card is CharacterCard => !!card && typeof (card as CharacterCard).id === "string");
}

/** 既存卡的補名候選：把節點標題佔位名換成真名（三鍵晚到或第二來源）。 */
interface CardRenameCandidate {
  cardId: string;
  name: string;
}

/**
 * 補名候選的判準刻意保守：
 *   - 卡名**逐字等於節點標題**（機器佔位，如「正面」）→ 人手改過的名字（≠ 標題）一個都不動
 *   - 目標名與現名相同 → 不產生（冪等：連續兩輪不再有寫入）
 */
function planCardRenameCandidates(
  refs: readonly AgentOutputNodeRef[],
  existing: readonly CharacterCard[],
): CardRenameCandidate[] {
  const byId = new Map(existing.map((card) => [card.id, card]));
  const out: CardRenameCandidate[] = [];
  for (const ref of refs) {
    if (!ref || typeof ref.id !== "string" || !ref.id) continue;
    if (!emittedEntityOf(ref)) continue;
    const placeholder = toCardMetadataName(ref.title);
    if (!placeholder) continue;
    const card = byId.get(entityCardIdForNode(ref.id));
    if (!card || card.name !== placeholder) continue;
    const target = declaredCardNameKey(ref);
    if (!target || target === card.name) continue;
    out.push({ cardId: card.id, name: target });
  }
  return out;
}

/** 卡名改寫：參考圖名一起改（它是建卡時從卡名截出來的標籤，不改＝卡名與標籤打臉）。 */
function renameCard(card: CharacterCard, name: string, now: string): CharacterCard {
  return {
    ...card,
    name,
    references: card.references.map((ref) => (ref.name === card.name ? { ...ref, name: name.slice(0, 60) } : ref)),
    updatedAt: now,
  };
}

/**
 * 一輪要寫盤的**就地更新**清單 ＝ 聚合更新（`plan.updatedCards`）∪ 補名
 *（`planCardRenameCandidates`）。兩者命中同一張卡時**合併成同一筆**（否則同輪兩次寫盤
 * 互相覆蓋：聚合那筆帶舊名、補名那筆帶舊參考圖 → 後寫者贏＝丟掉前者的更新）。
 * 順序：聚合桶原序在前、補名新增在後。id 不變＝就地更新（不新建卡、不動鎖定集）。
 */
export function planEmittedUpdateWrites(
  plan: EmittedCardsResult,
  refs: readonly AgentOutputNodeRef[],
  existing: readonly CharacterCard[],
  now: string,
): CharacterCard[] {
  const updates = emittedUpdateCards(plan);
  const renames = planCardRenameCandidates(refs, existing);
  const existingById = new Map(existing.map((card) => [card.id, card]));
  const writes: CharacterCard[] = [...updates];
  for (const { cardId, name } of renames) {
    const base = writes.find((card) => card.id === cardId) ?? existingById.get(cardId);
    if (!base) continue;
    const renamed = renameCard(base, name, now);
    const at = writes.findIndex((card) => card.id === cardId);
    if (at >= 0) writes[at] = renamed;
    else writes.push(renamed);
  }
  return writes;
}

/** 就地更新的落盤出口（I/O 由呼叫端注入 ⇒ 可行為單測：呼叫次數/順序/失敗路徑）。 */
export interface EmittedCardUpdateDeps {
  saveCard: (card: CharacterCard) => Promise<boolean>;
  /** 落盤成功後同步本地卡清單（就地替換，不重排——就地更新不是新建）。 */
  onSaved: (card: CharacterCard) => void;
}

/**
 * 逐張落盤（**成功才回報**）。收斂/冪等的兩道閘：
 *   - `cards` 為空 → **一次 I/O 都不發**（聚合已完成的那一輪零寫入、零狀態變更）
 *   - 失敗 → 不進回報、不碰本地狀態，只留一行 warn（僅卡 id）
 * 回傳成功落盤的卡 id（呼叫端據此決定要不要再觸發一輪：有寫入＝外界的圖可能還沒到齊）。
 */
export async function applyEmittedCardUpdates(
  cards: readonly CharacterCard[],
  deps: EmittedCardUpdateDeps,
): Promise<string[]> {
  const savedIds: string[] = [];
  for (const card of cards ?? []) {
    let saved = false;
    try {
      saved = await deps.saveCard(card);
    } catch {
      saved = false;
    }
    if (!saved) {
      console.warn("[canvas] 实体卡就地更新失败，略过该卡", card.id);
      continue;
    }
    deps.onSaved(card);
    savedIds.push(card.id);
  }
  return savedIds;
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
      // 掛用與解除掛用共用這條出口，兩者都在伺服器端動了卡庫：
      // `mountProjectAsset` 以伺服器端 saveCharacterCard 建出副本卡、`unmountProjectAsset` 刪掉它。
      // 這個出口是面板在伺服器回應成功後才呼叫的（失敗分支不會走到這裡），故在此發號；
      // 否則剛掛用的副本卡名以 `@[角色:名]` 引用時膠囊會顯示紅虛線「未找到」，
      // 而解除掛用後已刪的副本卡膠囊會停在「已解析」（該紅卻不紅）。
      invalidateEntityCardIndex();
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

  /**
   * 依節點交付自動落卡（冪等；由 use-canvas-chat 在節點變更後呼叫）。
   *
   * 這條接線補的是斷點：模板節點（`defaults.emitsEntity`）產出角色四視圖/場景圖後
   * 素材沒有卡實體 → 不會自動出現在素材池等人 `@` 引用。
   *
   * 語義：
   *   - 判準/建卡/回填計畫全在純函式 `emittedCardsForNodes`（可單測，零副作用）
   *   - 逐張 upsert，**成功才計數**；失敗靜默（卡是順手鎖定的配置，不打擾創作，
   *     與 `fetchCharacterCardsRemote` 的失敗策略一致），只留一行 warn 供排障
   *     （僅卡 id，不含任何回應內容/憑證）
   *   - 成功的 id 併入鎖定集（不覆蓋既有鎖定集）
   *   - 回填只帶「真的存在的卡 id」＝本輪落盤成功者 ∪ 手上已有的卡
   *     （本輪新建且落盤失敗者被濾掉——卡沒落成還回填＝製造鬼引用）
   *   - 回填出口缺省不存在時不寫、也不計數（不謊報）
   *   - 卡名**第二來源**（C）：`resolveName` 出口在此注入（只認 `nameFrom:"input"` 且三鍵
   *     全空者），落成/改名的名字就來自它；真的連第二來源都取不到 → `onNameFallback` 回報
   *   - **就地更新**（B）：聚合是漸進的（sibling 的圖晚到）→ 同一張卡的多圖更新與既存卡
   *     補名一起進 `planEmittedUpdateWrites`，逐張落盤（`updated` 計成功數）；空＝零 I/O
   */
  const autoAnchorEmittedCards = useCallback(
    async (
      nodes: readonly AgentOutputNodeRef[],
      anchorOptions: AutoAnchorEmittedCardsOptions = {},
    ): Promise<{ created: number; updated: number; locked: number; backfilled: number }> => {
      // 第二來源注入：只認 emitsEntity.nameFrom==="input" 且三鍵全空者（其餘原參考不動）。
      const refs: AgentOutputNodeRef[] = (nodes ?? []).map((ref) =>
        withSecondSourceName(ref, anchorOptions.resolveName),
      );
      const plan = emittedCardsForNodes(refs, characterCardsRef.current);
      // 卡 id → 來源節點 id（本輪新建卡的標記要回寫到**擁有它的那顆節點**）。
      // 卡 id 走 `entityCardIdForNode` 的決定性推導，這裡用同一函式反查（同一把尺）。
      // 撞名（僅 `:` 換 `-` 造成的碰撞）時**首次出現者勝**——與下面建卡迴圈的順序一致。
      const nodeIdByCardId = new Map<string, string>();
      for (const ref of refs) {
        if (!ref || typeof ref.id !== "string" || !ref.id) continue;
        const cardId = entityCardIdForNode(ref.id);
        if (!nodeIdByCardId.has(cardId)) nodeIdByCardId.set(cardId, ref.id);
      }
      const anchoredIds: string[] = [];
      for (const card of plan.cards) {
        let saved = false;
        try {
          const res = await saveCharacterCardRemote(card);
          saved = res.ok;
        } catch {
          saved = false;
        }
        if (!saved) {
          console.warn("[canvas] 模板節點自動落卡失敗，略過該卡", card.id);
          continue;
        }
        setCharacterCards((prev) => [card, ...prev.filter((c) => c.id !== card.id)]);
        anchoredIds.push(card.id);
        const ownerNodeId = nodeIdByCardId.get(card.id);
        if (ownerNodeId && anchorOptions.onEntityCardId) {
          try {
            anchorOptions.onEntityCardId(ownerNodeId, card.id);
          } catch {
            console.warn("[canvas] 自動落卡標記寫入失敗", card.id);
          }
        }
      }
      if (anchoredIds.length) setActiveCardIds((prev) => mergeAnchoredIds(prev, anchoredIds));

      const anchored = new Set(anchoredIds);
      // 「卡真的存在」= 本輪落盤成功者 ∪ 手上已有的卡（清單來自伺服器）。
      // 後者是耐久回填的通道：卡上次已落（本輪沒新建）但分鏡引用還沒寫 → 仍可回填；
      // 本輪新建但落盤失敗者不在任何一邊 → 被濾掉（卡沒落成還回填＝製造鬼引用）。
      const existing = characterCardsRef.current ?? [];
      const existingIds = new Set(existing.map((card) => card?.id).filter(Boolean));

      // 卡名真的退回節點標題（真源＝落卡模組的 `nameFallbacks`：判準在它手上，
      // 本檔不重算一份避免第二個漂移點；第二來源有值時它就不會進這張表）。
      const nameFallbacks = Array.isArray(plan.nameFallbacks) ? plan.nameFallbacks : [];
      if (nameFallbacks.length && anchorOptions.onNameFallback) {
        try {
          anchorOptions.onNameFallback(nameFallbacks);
        } catch {
          console.warn("[canvas] 卡名退回提示失败", nameFallbacks.length);
        }
      }

      // 就地更新（聚合新圖 ＋ 既存卡補名）：卡 id 不變，故不進 lockedIds（已鎖者保持鎖定）。
      const updatedIds = await applyEmittedCardUpdates(
        planEmittedUpdateWrites(plan, refs, existing, new Date().toISOString()),
        {
          saveCard: async (card) => {
            try {
              return (await saveCharacterCardRemote(card)).ok;
            } catch {
              return false;
            }
          },
          onSaved: (card) =>
            setCharacterCards((prev) =>
              prev.some((c) => c.id === card.id) ? prev.map((c) => (c.id === card.id ? card : c)) : [...prev, card],
            ),
        },
      );

      const backfill: ShotEntityBackfill[] = [];
      for (const item of plan.shotBackfill) {
        const keep = (ids?: readonly string[]) => (ids ?? []).filter((id) => anchored.has(id) || existingIds.has(id));
        const characterCardIds = keep(item.characterCardIds);
        const sceneCardIds = keep(item.sceneCardIds);
        const propCardIds = keep(item.propCardIds);
        if (!characterCardIds.length && !sceneCardIds.length && !propCardIds.length) continue;
        backfill.push({
          nodeId: item.nodeId,
          ...(characterCardIds.length ? { characterCardIds } : {}),
          ...(sceneCardIds.length ? { sceneCardIds } : {}),
          ...(propCardIds.length ? { propCardIds } : {}),
        });
      }
      const created = anchoredIds.length;
      const updated = updatedIds.length;
      if (!backfill.length || !anchorOptions.onShotBackfill) {
        return { created, updated, locked: created, backfilled: 0 };
      }
      try {
        anchorOptions.onShotBackfill(backfill);
      } catch {
        console.warn("[canvas] 分鏡實體引用回填失敗", backfill.length);
        return { created, updated, locked: created, backfilled: 0 };
      }
      return { created, updated, locked: created, backfilled: backfill.length };
    },
    [],
  );

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
    /** WS4：依節點交付自動落卡（冪等；use-canvas-chat 在節點變更後呼叫）。 */
    autoAnchorEmittedCards,
  };
}
