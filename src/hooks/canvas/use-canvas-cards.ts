// 角色/场景卡域（P2 跨镜头一致性）—— 自 use-canvas-chat.ts 外围搬迁。
// characterCards = 用户全部卡；activeCardIds = 锁定到本画布项目的卡。
// 主 hook 经回传值组装 UseCanvasChatReturn（37 成员隐含合约的一部分）。
//
// REQ-B2b：本域是**读取端作用域闸**的落点——
//   1. `activeCharacterCards`（生成注入与 agent 快照的唯一来源）先过作用域裁决：
//      跨项目、未显式分享的卡一律剔除（fail-closed）；个人卡（含所有 legacy 卡）逐位不变。
//      与写入端 `/api/canvas/projects` 的 filterCardIdsForProject 共用同一把尺
//      （asset-scope.resolveAssetScopeVisibility），两端不可能漂移。
//   2. `applyMountCopyChange` 把挂用产生的**本地副本**锁进 cardIds（copy-on-use 生效的硬接线）。
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
   * 当前项目 id 读取器（＝ canvas 的 getProjectId）。缺省＝无项目上下文
   * （项目归属的卡一律不可用，个人卡照用——fail-closed 不猜）。
   */
  getProjectId?: () => string | null;
  /**
   * 当前画布所属的**创作项目 id**（`prj_…`）。与 `getProjectId`（画布 id `canvas-…`）
   * 是两套命名空间，**各自独立传递、不得互相冒充**：由宿主经共享 store 的
   * `findProjectIdByCanvas` 反查得到。缺省/null＝无此上下文（标签驱动注入不生效）。
   * 用途：把「打了本项目标签」的卡并入生成注入集（见 activeCharacterCards）。
   */
  creativeProjectId?: string | null;
}

/** 自动落卡的可选出口（回填分镜引用／写落卡标记要 patchNodeMetadata，由 use-canvas-chat 注入）。 */
export interface AutoAnchorEmittedCardsOptions {
  /**
   * 回填套用出口。缺省＝**只回报不写**——回传的 `backfilled` 也会是 0
   * （没人写就不算回填过，不谎报成功）。
   */
  onShotBackfill?: (items: readonly ShotEntityBackfill[]) => void;
  /**
   * 每张**新建成功**的卡 → （节点 id, 卡 id）标记出口（呼叫端负责 patchNodeMetadata
   * 写 `metadata.entityCardId`）。缺省＝不写：标记是幂等的加速器（真正的幂等靠
   * 决定性卡 id ＋ existing 比对），但**不写＝重载后「这颗节点建过卡」这件事没有痕迹**，
   * 只能靠卡实体反推（见 agent-output-cards 的耐久回填）。
   */
  onEntityCardId?: (nodeId: string, cardId: string) => void;
  /**
   * 卡名**第二来源**（C：卡名软耦合硬化）。`emitsEntity.nameFrom:"input"` 靠 agent 把
   * 名字写进 metadata 的三个候选键；agent 不照做时卡名只能退回节点标题（「正面」）。
   * 呼叫端在此回**上游文本节点的第一行非空文字**（配方＝`upstreamTextNameFor`）。
   * 缺省＝没有第二来源（既有行为逐位元不变）。
   */
  resolveName?: (ref: AgentOutputNodeRef) => string | undefined;
  /**
   * 卡名**真的**退回了节点标题的节点（＝落卡模组的 `nameFallbacks`：`nameFrom:"input"` ∧
   * 三键全空 ∧ **第二来源也取不到**）。呼叫端负责让它可见（toast/console）。
   * 缺省＝只回报不显示。真源在落卡模组（它才知道卡最后叫什么），本档不重算一遍。
   */
  onNameFallback?: (fallbacks: EmittedCardsResult["nameFallbacks"]) => void;
}

/** 锁定并入：保留既有锁定集与其顺序，只补没有的 id（不覆盖用户/agent 的选择）。 */
function mergeAnchoredIds(prev: readonly string[], added: readonly string[]): string[] {
  const missing = added.filter((id) => !prev.includes(id));
  return missing.length ? [...prev, ...missing] : [...prev];
}

// ─────────────────────────────────── 卡名第二来源（C，2026-09-24）

/** metadata 袋子读取（`CanvasNodeMetadata` 是 interface，无 index signature）。 */
function asBag(metadata: unknown): Record<string, unknown> | undefined {
  return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : undefined;
}

/** URL 形态的交付物（图/媒体）不是文本——它的 content 不当卡名来源。 */
const DELIVERABLE_URL_PATTERN = /^(https?:|data:)/i;

/**
 * 上游**文本**节点的名字候选：`metadata.content` 的第一行非空文字（trim、卡名同尺上限
 * 100）。content 本身是交付物 URL（http(s)/data:）＝该节点不是文本节点 → `undefined`
 *（不拿图 URL 当卡名）。
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
 * 由上游文本节点内容取卡名候选（C 第二来源的纯函式）：**只向上走**——
 * 连线语义 `fromNodeId → toNodeId`，故「祖先」＝`toNodeId === 当前节点` 的 `fromNodeId`
 *（现场栏位真名＝`CanvasConnection.fromNodeId/toNodeId`）。逐层**广度优先**（最近的上游
 * 先看，同层按连线出现序），回传第一个有非空文本 content 的祖先的第一行文字；
 * 自己永不被选；已访问集合防环（环上不无限回圈）。找不到
 *（没上游／上游全是图、媒体或空文本）→ `undefined`（呼叫端据此退回节点标题）。
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
  // 反向邻接：child → 直接上游（去重、保留连线出现序）
  const parentsByChild = new Map<string, string[]>();
  for (const conn of connections ?? []) {
    if (!conn || typeof conn.fromNodeId !== "string" || typeof conn.toNodeId !== "string") continue;
    const parents = parentsByChild.get(conn.toNodeId);
    if (!parents) parentsByChild.set(conn.toNodeId, [conn.fromNodeId]);
    else if (!parents.includes(conn.fromNodeId)) parents.push(conn.fromNodeId);
  }
  const visited = new Set<string>([nodeId]); // 跳过自己 ＋ 防环
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

/** 卡名三键的第一个非空值（读卡名真源的同一把尺）＝名字真的在 metadata 里。 */
function declaredCardNameKey(ref: AgentOutputNodeRef): string | undefined {
  const bag = asBag(ref.metadata);
  for (const key of CARD_NAME_KEYS) {
    const name = toCardMetadataName(bag?.[key]);
    if (name) return name;
  }
  return undefined;
}

/**
 * 把第二来源的名字注入 **metadata 副本**的 `input`（`nameFrom:"input"` 的第一个候选键；
 * 配方真源＝`layout.CARD_NAME_KEYS`／消费端＝`agent-output-cards.NAME_FROM_INPUT_KEYS`）。
 * 落卡模组是纯函式、只认节点投影 → 第二来源只能从这个入口进去。
 *
 * 回传**原参考、零改动**当：没有出口／没宣告 emitsEntity／`nameFrom !== "input"`／
 * agent 已写了名字／上游也取不到名字。**不改动原节点 metadata**（只浅拷贝袋子）。
 */
export function withSecondSourceName(
  ref: AgentOutputNodeRef,
  resolveName?: (ref: AgentOutputNodeRef) => string | undefined,
): AgentOutputNodeRef {
  if (!resolveName || !ref || typeof ref.id !== "string" || !ref.id) return ref;
  const spec = emittedEntityOf(ref);
  if (!spec || spec.nameFrom !== "input") return ref;
  if (declaredCardNameKey(ref)) return ref; // agent 照做了，第二来源不介入
  let resolved: string | undefined;
  try {
    resolved = resolveName(ref);
  } catch {
    resolved = undefined; // 第二来源是自己的事，坏掉不影响落卡主线
  }
  const name = toCardMetadataName(resolved);
  if (!name) return ref;
  return { ...ref, metadata: { ...(asBag(ref.metadata) ?? {}), input: name } };
}

// ─────────────────────────────────── 落卡计画的写入（B 渐进聚合，2026-09-24）

/**
 * 计画的「就地更新」桶（聚合是渐进的：sibling 的图晚到 → 同一张卡要多一张参考图）。
 * 取 `plan.updatedCards`（真源＝`agent-output-cards.ts` 的计划；由该档比对参考图 url 集合
 * 后给出——名称/prompt/批准状态不在它的判准里，故本档只负责**落盘**，不重算）。
 * `Array.isArray` 守卫：缺席／脏形＝空 ⇒ 不无中生有写盘（旧版计画零行为漂移）。
 */
export function emittedUpdateCards(plan: EmittedCardsResult): CharacterCard[] {
  const raw = plan?.updatedCards;
  if (!Array.isArray(raw)) return [];
  return raw.filter((card): card is CharacterCard => !!card && typeof (card as CharacterCard).id === "string");
}

/** 既存卡的补名候选：把节点标题占位名换成真名（三键晚到或第二来源）。 */
interface CardRenameCandidate {
  cardId: string;
  name: string;
}

/**
 * 补名候选的判准刻意保守：
 *   - 卡名**逐字等于节点标题**（机器占位，如「正面」）→ 人手改过的名字（≠ 标题）一个都不动
 *   - 目标名与现名相同 → 不产生（幂等：连续两轮不再有写入）
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

/** 卡名改写：参考图名一起改（它是建卡时从卡名截出来的标签，不改＝卡名与标签打脸）。 */
function renameCard(card: CharacterCard, name: string, now: string): CharacterCard {
  return {
    ...card,
    name,
    references: card.references.map((ref) => (ref.name === card.name ? { ...ref, name: name.slice(0, 60) } : ref)),
    updatedAt: now,
  };
}

/**
 * 一轮要写盘的**就地更新**清单 ＝ 聚合更新（`plan.updatedCards`）∪ 补名
 *（`planCardRenameCandidates`）。两者命中同一张卡时**合并成同一笔**（否则同轮两次写盘
 * 互相覆盖：聚合那笔带旧名、补名那笔带旧参考图 → 后写者赢＝丢掉前者的更新）。
 * 顺序：聚合桶原序在前、补名新增在后。id 不变＝就地更新（不新建卡、不动锁定集）。
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

/** 就地更新的落盘出口（I/O 由呼叫端注入 ⇒ 可行为单测：呼叫次数/顺序/失败路径）。 */
export interface EmittedCardUpdateDeps {
  saveCard: (card: CharacterCard) => Promise<boolean>;
  /** 落盘成功后同步本地卡清单（就地替换，不重排——就地更新不是新建）。 */
  onSaved: (card: CharacterCard) => void;
}

/**
 * 逐张落盘（**成功才回报**）。收敛/幂等的两道闸：
 *   - `cards` 为空 → **一次 I/O 都不发**（聚合已完成的那一轮零写入、零状态变更）
 *   - 失败 → 不进回报、不碰本地状态，只留一行 warn（仅卡 id）
 * 回传成功落盘的卡 id（呼叫端据此决定要不要再触发一轮：有写入＝外界的图可能还没到齐）。
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

/** 角色/场景卡域：卡列表、项目级锁定、upsert/remove/toggle 与进页载入。 */
export function useCanvasCards(options: UseCanvasCardsInput = {}) {
  const [characterCards, setCharacterCards] = useState<CharacterCard[]>([]);
  const [activeCardIds, setActiveCardIds] = useState<string[]>([]);
  /**
   * 授权**进来**某项目的分享表（读取闸判「分享进来」用）。
   * 带 projectId 一起存：专案切换后旧表**当场失效**（宁可少放行一张分享进来的卡，
   * 也不拿别人的授权放行本项目——fail-closed）。
   */
  const [shareTable, setShareTable] = useState<{ projectId: string; shares: AssetShareRecord[] } | null>(null);
  // 读取器一律从 ref 读**最新**值，且用稳定的包装函式当依赖：
  // 父层传进来的 inline 箭头每次 render 都是新函式，直接进 effect 依赖＝每次 render 都发请求。
  const getProjectIdRef = useRef(options.getProjectId);
  getProjectIdRef.current = options.getProjectId;
  const readProjectId = useCallback((): string | null => getProjectIdRef.current?.() ?? null, []);

  // ── refs：给不参与 render 的路径读最新值
  const characterCardsRef = useRef(characterCards);
  characterCardsRef.current = characterCards;
  const activeCardIdsRef = useRef(activeCardIds);
  activeCardIdsRef.current = activeCardIds;

  /** 进页载入用户全部卡。失败静默：卡是顺手锁定的配置，不打扰创作。 */
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
   * 分享表的取用签章（稳定字串＝不会每次 render 都变，故不会造成请求风暴）：
   * 只有「手上真的有别的项目归属的卡」时才非空——纯个人的画布（现存所有资料）
   * 零额外请求＝零行为漂移；一旦出现跨项目卡，切项目／换锁定集就重读一次。
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
   * 锁定中的卡实体：生成时注入的就是这份（applyCharacterCards 按 id 序幂等注入）。
   * REQ-B2b 读取端作用域闸：不可见（跨项目、未分享）的卡不进这份集合——fail-closed。
   * 闸函式（filterLockedCardsForProjectUse）与伺服器端写入闸共用同一裁决尺。
   *
   * 2026-10-09 标签驱动注入：除「锁定集 ∩ 卡库」外，并入「`projectIds` 含当前
   * **创作项目 id**（`prj_…`）」的卡（取自同一份 `characterCards` 全量库），再过同一道作用域闸。
   * 语义边界：**标签＝该项目的常驻可用集**（自动进生成）；**锁定集＝本画布显式挑选**
   * （仍优先，不重排）。个人卡与跨项目未打标签的卡**不得**因这条路进注入——
   * 只有 `projectIds` 真的含 creativeProjectId 的卡才会被并入。
   */
  const creativeProjectId = options.creativeProjectId ?? null;
  const activeCharacterCards = useMemo(() => {
    const projectId = readProjectId();
    const shares = shareTable && shareTable.projectId === projectId ? shareTable.shares : [];
    const locked = characterCards.filter((c) => activeCardIds.includes(c.id));
    const tagged = creativeProjectId
      ? characterCards.filter((c) => (c.projectIds ?? []).includes(creativeProjectId))
      : [];
    let merged = locked;
    if (tagged.length) {
      const lockedIds = new Set(locked.map((c) => c.id));
      const extra = tagged.filter((c) => !lockedIds.has(c.id));
      if (extra.length) merged = [...locked, ...extra];
    }
    return filterLockedCardsForProjectUse(merged, { projectId, creativeProjectId, shares });
  }, [characterCards, activeCardIds, shareTable, readProjectId, creativeProjectId]);

  /**
   * REQ-B2b：挂用副本的锁定/解锁（面板挂用/解除后呼叫）。
   * 先重读卡清单（让新副本实体可解析），再改项目锁定集——顺序不可颠倒，
   * 否则 setActiveCardIds 之后的那一帧仍查不到卡实体＝生成漏注入。
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
      // 挂用与解除挂用共用这条出口，两者都在伺服器端动了卡库：
      // `mountProjectAsset` 以伺服器端 saveCharacterCard 建出副本卡、`unmountProjectAsset` 删掉它。
      // 这个出口是面板在伺服器回应成功后才呼叫的（失败分支不会走到这里），故在此发号；
      // 否则刚挂用的副本卡名以 `@[角色:名]` 引用时胶囊会显示红虚线「未找到」，
      // 而解除挂用后已删的副本卡胶囊会停在「已解析」（该红却不红）。
      invalidateEntityCardIndex();
      setActiveCardIds((prev) => applyCopyLockChange(prev, { locked, unlocked }));
    },
    [],
  );

  /**
   * 重读用户全部卡（2026-10-09 标签驱动注入）：资产面板改了某资产的 `projectIds`
   * 之后呼叫，让 `characterCards` 状态带上新标签 → `activeCharacterCards` 当场重组注入集。
   * 与 `applyMountCopyChange` 的取数同源（同一支 `fetchCharacterCardsRemote`），
   * 失败静默（卡是顺手锁定的配置，不打扰创作）。父层面板打标签后不再走挂用接线，
   * 这是「打标签立刻进生成」的唯一刷新出口。
   */
  const refreshCharacterCards = useCallback(async () => {
    const res = await fetchCharacterCardsRemote();
    if (res.ok && res.data) setCharacterCards(res.data);
  }, []);

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
    // 删卡同时解除锁定（该 id 不再出现在项目 cardIds）。
    setActiveCardIds((prev) => prev.filter((x) => x !== id));
    return true;
  }, []);

  const toggleCharacterCard = useCallback((id: string) => {
    setActiveCardIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  /**
   * 依节点交付自动落卡（幂等；由 use-canvas-chat 在节点变更后呼叫）。
   *
   * 这条接线补的是断点：模板节点（`defaults.emitsEntity`）产出角色四视图/场景图后
   * 素材没有卡实体 → 不会自动出现在素材池等人 `@` 引用。
   *
   * 语义：
   *   - 判准/建卡/回填计画全在纯函式 `emittedCardsForNodes`（可单测，零副作用）
   *   - 逐张 upsert，**成功才计数**；失败静默（卡是顺手锁定的配置，不打扰创作，
   *     与 `fetchCharacterCardsRemote` 的失败策略一致），只留一行 warn 供排障
   *     （仅卡 id，不含任何回应内容/凭证）
   *   - 成功的 id 并入锁定集（不覆盖既有锁定集）
   *   - 回填只带「真的存在的卡 id」＝本轮落盘成功者 ∪ 手上已有的卡
   *     （本轮新建且落盘失败者被滤掉——卡没落成还回填＝制造鬼引用）
   *   - 回填出口缺省不存在时不写、也不计数（不谎报）
   *   - 卡名**第二来源**（C）：`resolveName` 出口在此注入（只认 `nameFrom:"input"` 且三键
   *     全空者），落成/改名的名字就来自它；真的连第二来源都取不到 → `onNameFallback` 回报
   *   - **就地更新**（B）：聚合是渐进的（sibling 的图晚到）→ 同一张卡的多图更新与既存卡
   *     补名一起进 `planEmittedUpdateWrites`，逐张落盘（`updated` 计成功数）；空＝零 I/O
   */
  const autoAnchorEmittedCards = useCallback(
    async (
      nodes: readonly AgentOutputNodeRef[],
      anchorOptions: AutoAnchorEmittedCardsOptions = {},
    ): Promise<{ created: number; updated: number; locked: number; backfilled: number }> => {
      // 第二来源注入：只认 emitsEntity.nameFrom==="input" 且三键全空者（其余原参考不动）。
      const refs: AgentOutputNodeRef[] = (nodes ?? []).map((ref) =>
        withSecondSourceName(ref, anchorOptions.resolveName),
      );
      const plan = emittedCardsForNodes(refs, characterCardsRef.current);
      // 卡 id → 来源节点 id（本轮新建卡的标记要回写到**拥有它的那颗节点**）。
      // 卡 id 走 `entityCardIdForNode` 的决定性推导，这里用同一函式反查（同一把尺）。
      // 撞名（仅 `:` 换 `-` 造成的碰撞）时**首次出现者胜**——与下面建卡回圈的顺序一致。
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
          console.warn("[canvas] 模板节点自动落卡失败，略过该卡", card.id);
          continue;
        }
        setCharacterCards((prev) => [card, ...prev.filter((c) => c.id !== card.id)]);
        anchoredIds.push(card.id);
        const ownerNodeId = nodeIdByCardId.get(card.id);
        if (ownerNodeId && anchorOptions.onEntityCardId) {
          try {
            anchorOptions.onEntityCardId(ownerNodeId, card.id);
          } catch {
            console.warn("[canvas] 自动落卡标记写入失败", card.id);
          }
        }
      }
      if (anchoredIds.length) setActiveCardIds((prev) => mergeAnchoredIds(prev, anchoredIds));

      const anchored = new Set(anchoredIds);
      // 「卡真的存在」= 本轮落盘成功者 ∪ 手上已有的卡（清单来自伺服器）。
      // 后者是耐久回填的通道：卡上次已落（本轮没新建）但分镜引用还没写 → 仍可回填；
      // 本轮新建但落盘失败者不在任何一边 → 被滤掉（卡没落成还回填＝制造鬼引用）。
      const existing = characterCardsRef.current ?? [];
      const existingIds = new Set(existing.map((card) => card?.id).filter(Boolean));

      // 卡名真的退回节点标题（真源＝落卡模组的 `nameFallbacks`：判准在它手上，
      // 本档不重算一份避免第二个漂移点；第二来源有值时它就不会进这张表）。
      const nameFallbacks = Array.isArray(plan.nameFallbacks) ? plan.nameFallbacks : [];
      if (nameFallbacks.length && anchorOptions.onNameFallback) {
        try {
          anchorOptions.onNameFallback(nameFallbacks);
        } catch {
          console.warn("[canvas] 卡名退回提示失败", nameFallbacks.length);
        }
      }

      // 就地更新（聚合新图 ＋ 既存卡补名）：卡 id 不变，故不进 lockedIds（已锁者保持锁定）。
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
        console.warn("[canvas] 分镜实体引用回填失败", backfill.length);
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
    /** REQ-B2b：挂用副本的锁定/解锁（面板 onCopyChange 的唯一入口）。 */
    applyMountCopyChange,
    /** 标签变更后重读卡库（资产面板 onTagsChange 的唯一入口）。 */
    refreshCharacterCards,
    characterCardsRef,
    activeCardIdsRef,
    upsertCharacterCard,
    removeCharacterCard,
    toggleCharacterCard,
    /** WS4：依节点交付自动落卡（幂等；use-canvas-chat 在节点变更后呼叫）。 */
    autoAnchorEmittedCards,
  };
}
