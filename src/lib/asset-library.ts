// REQ-B2 团队资产空间：伺服器端组装层（读存取 → 可见性 → 挂用标记）。
//
// 只做三件事：把既有两套资产表示（资产包 / 资产卡）映射成作用域层的候选项、
// 过一次可见性、带上当前项目的挂用标记。资产本体与其清洗收口**不动**
//（asset-pack-store.normalizeAssetPack / character-cards.normalizeCharacterCard 仍是唯一真源）。
import { deleteAssetPacks, listAssetPacks, MAX_PACKS_PER_USER, normalizeAssetPack, saveAssetPack } from "./asset-pack-store";
import type { AssetPack } from "./asset-pack-store";
import { deleteCharacterCards, listCharacterCards, MAX_CARDS_PER_USER, saveCharacterCard } from "./character-card-store";
import { normalizeCharacterCard } from "./character-cards";
import type { CharacterCard } from "./character-cards";
import { mergeLineageIntoHost } from "./lineage";
import type { LineageLink } from "./lineage";
import { listAssetMounts, listAssetShares, mountAsset, unmountAsset } from "./asset-scope-store";
import {
  assetLocalCopyId,
  assetMountId,
  assetPackItemCopyId,
  assetPackLocalCopyId,
  buildProjectAssetLibrary,
  candidatesFromCards,
  candidatesFromPacks,
  canUseAsset,
  normalizeAssetMount,
  planAssetMountCopy,
  resolveAssetVisibility,
  resolveMountableAsset,
} from "./asset-scope";
import type {
  AssetLibraryCandidate,
  AssetLibraryItem,
  AssetLibraryQuery,
  AssetMountCopyMode,
  AssetMountCopyRejectReason,
  AssetMountRecord,
  AssetScope,
  AssetShareRecord,
  AssetUseContext,
  AssetVisibility,
  AssetKind,
} from "./asset-scope";

export interface ScopedLibrarySnapshot {
  candidates: AssetLibraryCandidate[];
  ctx: AssetUseContext;
  mounts: AssetMountRecord[];
  shares: AssetShareRecord[];
}

/**
 * 读当前用户的资产面 → 候选项 + 使用上下文（单次读，呼叫端共用同一份快照，
 * 避免「列表用旧快照、挂用用新快照」造成的判定漂移）。
 * projectId 为 null → 无项目上下文，只有个人资产可见（禁默认全网可见）。
 */
export async function loadScopedLibrary(input: {
  userId: number;
  projectId: string | null;
}): Promise<ScopedLibrarySnapshot> {
  const [packs, cards, shares, mounts] = await Promise.all([
    listAssetPacks(input.userId),
    listCharacterCards(input.userId),
    listAssetShares(input.userId),
    listAssetMounts(input.userId),
  ]);
  const candidates = [
    ...candidatesFromPacks(packs, input.userId),
    ...candidatesFromCards(cards, input.userId),
  ];
  return {
    candidates,
    ctx: { viewerUserId: input.userId, projectId: input.projectId, shares },
    mounts,
    shares,
  };
}

/** 项目资产库列表（可见性过滤 + 检索 + 筛选）。 */
export async function listProjectAssetLibrary(input: {
  userId: number;
  projectId: string | null;
  query?: AssetLibraryQuery;
}): Promise<{
  items: AssetLibraryItem[];
  shares: AssetShareRecord[];
  /** 授权**进来**本项目的有效分享（前端读取闸判 shared-in 用；copy-on-use 下正常流程不依赖它）。 */
  sharesIn: AssetShareRecord[];
  mounts: AssetMountRecord[];
}> {
  const snapshot = await loadScopedLibrary({ userId: input.userId, projectId: input.projectId });
  const items = buildProjectAssetLibrary({
    candidates: snapshot.candidates,
    ctx: snapshot.ctx,
    mounts: snapshot.mounts,
    query: input.query,
  });
  const sharesIn = snapshot.shares.filter((s) => s.toProjectId === input.projectId && !s.revokedAt);
  return { items, shares: snapshot.shares, sharesIn, mounts: snapshot.mounts };
}

/** 挂用前置检查：不可见即不可用（回 null → API 层必须 403，不得静默成功）。 */
export async function resolveMountable(input: {
  userId: number;
  projectId: string;
  assetKind: AssetKind;
  assetId: string;
}): Promise<{ visibility: AssetVisibility; candidate: AssetLibraryCandidate } | null> {
  const snapshot = await loadScopedLibrary({ userId: input.userId, projectId: input.projectId });
  return resolveMountableAsset(
    snapshot.candidates,
    snapshot.ctx,
    { assetKind: input.assetKind, assetId: input.assetId },
  );
}

export interface OwnedAssetRef {
  id: string;
  kind: AssetKind;
  scope?: AssetScope;
  /** P1-A 项目标签（多归属）：喂给作用域裁决的新允许路径（缺省＝没有标签）。 */
  projectIds?: string[];
  ownerUserId: number;
}

/**
 * 找当前用户名下的某个资产（分享授权裁决要用它的 scope）。
 * 找不到回 null（API 层 404）。
 */
export async function findOwnedAsset(input: {
  userId: number;
  assetKind: AssetKind;
  assetId: string;
}): Promise<OwnedAssetRef | null> {
  if (input.assetKind === "pack") {
    const pack = (await listAssetPacks(input.userId)).find((p) => p.id === input.assetId);
    return pack
      ? {
          id: pack.id,
          kind: "pack",
          ...(pack.scope ? { scope: pack.scope } : {}),
          ...(pack.projectIds?.length ? { projectIds: pack.projectIds } : {}),
          ownerUserId: input.userId,
        }
      : null;
  }
  const card = (await listCharacterCards(input.userId)).find((c) => c.id === input.assetId);
  return card
    ? {
        id: card.id,
        kind: "card",
        ...(card.scope ? { scope: card.scope } : {}),
        ...(card.projectIds?.length ? { projectIds: card.projectIds } : {}),
        ownerUserId: input.userId,
      }
    : null;
}

/** 当前项目已挂用的资产键（UI badge 用）。 */
export function mountedCountFor(mounts: readonly AssetMountRecord[], projectId: string | null): number {
  if (!projectId) return 0;
  return mounts.filter((m) => m.projectId === projectId).length;
}

/** 单一资产在当前上下文的可见性（测试与除错入口）。 */
export function visibilityOf(
  asset: OwnedAssetRef,
  ctx: AssetUseContext,
): AssetVisibility | null {
  return resolveAssetVisibility(
    { id: asset.id, kind: asset.kind, scope: asset.scope, projectIds: asset.projectIds, ownerUserId: asset.ownerUserId },
    ctx,
  );
}

// ─────────────────────────────────────────── 使用/注入路径的裁决（REQ-B2）

/**
 * **使用/注入路径的唯一裁决入口**（内部仍只呼叫 resolveAssetVisibility，
 * 不在呼叫端另立规则）：某资产在此（可选项目）上下文是否可用。不可见即不可用。
 * - agent 主动包注入（/api/agent/sessions、/api/agent/sessions/[id]/memory）
 * - 锁定卡注入（/api/canvas/projects 的 cardIds 闸）
 * 都必须走本函式或其等价包装；未来切换跨项目语义（copy-on-use ↔ 引用＋解链闸）
 * 只需改 resolveAssetVisibility，不必动各使用路径。
 */
export async function isAssetUsable(input: {
  userId: number;
  /** 当前项目 id；null＝无项目上下文（项目资产一律不可用，个人资产照用）。 */
  projectId: string | null;
  assetKind: AssetKind;
  assetId: string;
}): Promise<boolean> {
  const owned = await findOwnedAsset({ userId: input.userId, assetKind: input.assetKind, assetId: input.assetId });
  if (!owned) return false;
  const shares = await listAssetShares(input.userId);
  return canUseAsset(
    { id: owned.id, kind: owned.kind, scope: owned.scope, projectIds: owned.projectIds, ownerUserId: owned.ownerUserId },
    { viewerUserId: input.userId, projectId: input.projectId, shares },
  );
}

/**
 * 从（不可信）请求体取项目上下文：非字串/空 → null。
 * null 的语义是「无项目上下文」＝项目归属的资产一律不可用（个人资产照用），fail-closed。
 */
export function projectIdFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { projectId?: unknown; project_id?: unknown }).projectId
    ?? (body as { projectId?: unknown; project_id?: unknown }).project_id;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * 项目保存闸：cardIds 逐个过作用域裁决（生成注入读的就是这份 cardIds，
 * 故跨项目、未显式分享的卡不得锁进本项目）。
 * - 查不到的 id（卡未载入/已删）**原样保留**——不猜，维持既有「未解析」语义。
 * - 个人卡（scope 缺省）逐位不变（零回归：既有单用户个人资产流程不变）。
 */
export async function filterCardIdsForProject(input: {
  userId: number;
  projectId: string;
  cardIds: readonly string[];
}): Promise<string[]> {
  if (input.cardIds.length === 0) return [];
  const [cards, shares] = await Promise.all([
    listCharacterCards(input.userId),
    listAssetShares(input.userId),
  ]);
  const byId = new Map(cards.map((card) => [card.id, card] as const));
  const ctx: AssetUseContext = { viewerUserId: input.userId, projectId: input.projectId, shares };
  return input.cardIds.filter((id) => {
    const card = byId.get(id);
    if (!card) return true; // 查不到＝无法判定，不猜（不因此静默丢卡）
    return canUseAsset(
      { id: card.id, kind: "card", scope: card.scope, projectIds: card.projectIds, ownerUserId: input.userId },
      ctx,
    );
  });
}

// ─────────────────────────────────────────── REQ-B2b 挂用＝copy-on-use

/** 来源资产不存在（API 层 404：宣告了来源却找不到，不得静默成功）。 */
export class AssetSourceMissingError extends Error {
  constructor(assetKind: AssetKind, assetId: string) {
    super(`资产不存在：${assetKind}:${assetId}`);
    this.name = "AssetSourceMissingError";
  }
}

/**
 * 副本键已被「不是这条来源的副本」的资产占用（API 层 409）。
 * 确定性副本 id 是杂凑值：正常呼叫不可能撞；一旦撞上而占用者不是这条来源的副本，
 * **绝不冒充幂等重放**（否则就是拿别人的资产当你的副本＝静默别名）。
 */
export class AssetMountCopyConflictError extends Error {
  constructor(localCopyId: string) {
    super(`副本键冲突：${localCopyId} 已被另一份资产占用，请勿复用同一资产 id`);
    this.name = "AssetMountCopyConflictError";
  }
}

/** 建副本会超出资产上限（API 层 400）：诚实拒绝，不静默截断（截断＝使用者以为挂满了）。 */
export class AssetCopyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetCopyLimitError";
  }
}

/** 环路/自引用/血统不可判定（API 层 400）：见 asset-scope.planAssetMountCopy 的三条守卫。 */
const MOUNT_COPY_REJECT_MESSAGE: Record<AssetMountCopyRejectReason, string> = {
  self_reference: "挂用被拒绝：副本键与来源相同（会写出自引用血统）",
  cyclic_lineage: "挂用被拒绝：该来源的血统链已成环，不得再延伸",
  unbounded_lineage: "挂用被拒绝：来源的血统图超出可完整遍历的界限，无法确认无环（拒绝而非默认无环）",
};

export class AssetMountCopyRejectedError extends Error {
  constructor(readonly reason: AssetMountCopyRejectReason) {
    super(MOUNT_COPY_REJECT_MESSAGE[reason]);
    this.name = "AssetMountCopyRejectedError";
  }
}

/** 挂用（copy-on-use）结果：副本 id 是重点——前端必须把它锁进 cardIds，否则等于没挂用。 */
export interface MountAssetWithCopyResult {
  mount: AssetMountRecord;
  /** 挂用记录是否新建（false＝同键重放；副本不重写，内容冻结在首次挂用那一刻）。 */
  created: boolean;
  /** 本次是否真的新建了副本（false＝幂等重放，零副作用）。 */
  copied: boolean;
  /** 本地副本主体：卡＝该卡 id；包＝本地包副本 id。 */
  localCopyId: string;
  /** **可锁进 cardIds 的卡副本 id**（卡＝[localCopyId]；包＝逐 item 副本）。 */
  localCopyIds: string[];
  /** 包内「无卡投影」的条目数（如 lora / 3D 产物）：诚实回报，不假装全搬成卡。 */
  skippedItems: number;
}

/** 卡的复制：内容逐栏照抄 + scope 指向目标项目 + lineage 一条 derivation 指回来源。 */
function buildCardCopy(source: CharacterCard, input: { projectId: string; localCopyId: string; now: string }): CharacterCard | null {
  // 血统只登记**直接来源**一条（D1 栏位语义＝「直接来源链」，parents 上限 5）：
  // 更上游由读取端沿 lineage 逐级解析（递归挂用＝一串可回溯的副本节点），
  // 不把祖先摊平成同一层的兄弟——摊平会让「溯源抽屉」把两级画成同级。
  const lineage = mergeLineageIntoHost(null, [{ kind: "derivation", assetId: source.id, at: input.now }]);
  return normalizeCharacterCard({
    ...source,
    id: input.localCopyId,
    scope: { owner: "project", projectId: input.projectId },
    ...(lineage ?? {}),
    // 副本自己的生卒时间（时间点冻结的可审计痕迹：来源日后更新不进这里）。
    createdAt: input.now,
    updatedAt: input.now,
  });
}

/** 包内条目 → 卡副本的投影规则（条目种类 → 卡型/内容）；回 null＝该条目没有卡投影。 */
function buildPackItemCard(
  source: AssetPack,
  itemIndex: number,
  input: { projectId: string; now: string },
): { card: CharacterCard | null; copyId: string } {
  const item = source.items[itemIndex];
  const copyId = assetPackItemCopyId(input.projectId, source.id, itemIndex);
  const name = item.title.slice(0, 100); // 卡名上限 100（超长＝normalizeCharacterCard 直接丢卡）
  // 血统：条目卡指向**来源包**（包本身的血统栏再指回更上游，见 mountAssetWithCopy 的包副本）。
  const lineage = mergeLineageIntoHost(null, [{ kind: "derivation", assetId: source.id, at: input.now }]);
  const shared = {
    id: copyId,
    name,
    scope: { owner: "project" as const, projectId: input.projectId },
    ...(lineage ?? {}),
    createdAt: input.now,
    updatedAt: input.now,
  };
  if (item.kind === "prompt" || item.kind === "recipe") {
    return { copyId, card: normalizeCharacterCard({ ...shared, kind: "style", prompt: item.content ?? "" }) };
  }
  if (item.kind === "image" || item.kind === "reference") {
    if (!item.imageUrl) return { copyId, card: null };
    return {
      copyId,
      card: normalizeCharacterCard({
        ...shared,
        kind: "scene",
        prompt: "",
        references: [{ url: item.imageUrl, role: "general", name }],
      }),
    };
  }
  // lora / scene_3d / bpy_script：没有卡投影（不臆造卡型），由呼叫端计入 skippedItems 诚实回报。
  return { copyId, card: null };
}

/** 候选副本 id 是否**真是**这条来源的副本（撞键辨伪的唯一判据，见 AssetMountCopyConflictError）。 */
function isGenuineCardCopy(card: CharacterCard, projectId: string, sourceAssetId: string): boolean {
  if (card.scope?.owner !== "project" || card.scope.projectId !== projectId) return false;
  return (card.lineage ?? []).some((link) => link.kind === "derivation" && link.assetId === sourceAssetId);
}

/** 包副本的辨伪：scope 指向目标项目 + lineage 的 derivation 指向来源包。 */
function isGenuinePackCopy(pack: AssetPack, projectId: string, sourcePackId: string): boolean {
  if (pack.scope?.owner !== "project" || pack.scope.projectId !== projectId) return false;
  return (pack.lineage ?? []).some((link) => link.kind === "derivation" && link.assetId === sourcePackId);
}

/** 血统图遍历的节点预算（**防御性**上限：正常帐号的资产总数远低于此，见下）。 */
export const MAX_ANCESTOR_NODES = 2000;

/**
 * 来源的血统祖先把手（**完整** BFS：走访到穷尽为止）。
 *
 * 为何不再是「有界 BFS」：旧版 maxDepth=5 / maxNodes=50 会把 6 跳的真环当成「查不到就算没环」
 * → 环路守卫被绕过（D2 实测）。图的节点就是**本呼叫已经读进来的那份快照**（cards + packs，
 * 上界＝MAX_CARDS_PER_USER + MAX_PACKS_PER_USER ＝ 200），未知 id 没有出边 ⇒ 遍历必然终止，
 * 故完整遍历的成本是有界的。`maxNodes` 只是防御性闸：真撞到就回 `truncated:true`，
 * 由呼叫端 **fail-closed**（拒绝并回可辨识原因），绝不「查不完就当没环」。
 *
 * 只认 assetId 把手（jobId/nodeId 不是资产，无法在资产库里展开）。
 */
export function collectAncestorAssetIds(
  seed: readonly LineageLink[] | undefined,
  lookup: (assetId: string) => readonly LineageLink[] | undefined,
  limits: { maxNodes: number } = { maxNodes: MAX_ANCESTOR_NODES },
): { ids: string[]; truncated: boolean } {
  const seen = new Set<string>();
  const queue = (seed ?? []).flatMap((link) => (link.assetId ? [link.assetId] : []));
  let truncated = false;
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    if (seen.size >= limits.maxNodes) {
      truncated = true;
      break;
    }
    seen.add(id);
    for (const link of lookup(id) ?? []) {
      if (link.assetId && !seen.has(link.assetId)) queue.push(link.assetId);
    }
  }
  return { ids: [...seen], truncated };
}

/**
 * **挂用＝copy-on-use**（REQ-B2b，暴君 09-23 裁定）：在目标项目建本地副本（内容本体），
 * lineage 记一条指向来源的 `derivation` 边，再落幂等挂用记录。
 *
 * 不变量：
 *   - **运行时自足**：副本是独立资产实体，生成注入只读副本自己的内容；来源资产
 *     （卡/包）与来源**项目**日后删除、改名、改内容都不影响它（口径修正 09-23：
 *     副本的 derivation 边**可以**指向别的 project 的来源实体——那是审计痕迹，
 *     不是运行依赖，故「删来源不影响副本」「副本不被外部 project 状态决定」才是要守的东西）；
 *   - **时间点冻结**：来源日后更新**不**回写副本（同键重挂也不重写副本）；
 *   - **幂等一份**：同 `(projectId, sourceAssetId)` 只建一份副本（副本 id 确定性推导 +
 *     建前辨伪）；重放零副作用（连 store 都不写）；
 *   - **幂等不因事后编辑而失效**（D4）：同键挂用记录已存在且该次副本已落地 = 已成立的事实，
 *     重挂直接回既有结果，**不得**因为来源血统事后被编辑成含副本 id 而 400；
 *   - **诚实拒绝**：来源查无 → AssetSourceMissingError(404)；副本键被非副本占用 →
 *     AssetMountCopyConflictError(409)；环路 → AssetMountCopyRejectedError(400)；
 *     血统图超界无法证明无环 → AssetMountCopyRejectedError("unbounded_lineage")；
 *     超上限 → AssetCopyLimitError(400)。
 *
 * 呼叫端（API 层）必须先过可见性裁决（resolveMountable），本函式只负责搬内容与落库。
 */
export async function mountAssetWithCopy(input: {
  userId: number;
  projectId: string;
  assetKind: AssetKind;
  assetId: string;
  /** 时间源（测试注入；缺省＝现在）。 */
  now?: string;
  /** 跨项目语义（缺省 copy-on-use；"reference" 只落记录不建副本，供方向切换演练/测试）。 */
  mode?: AssetMountCopyMode;
  /**
   * 血统遍历节点预算（**测试注入**；缺省＝MAX_ANCESTOR_NODES）。
   * 存在的唯一目的：让「超界 → fail-closed 拒绝（unbounded_lineage）」这条路径成为
   * 可断言的真实行为，而不是只写在注解里的宣称（正常帐号的资产上界 200 远低于预设预算）。
   */
  ancestorNodeBudget?: number;
}): Promise<MountAssetWithCopyResult> {
  const now = input.now ?? new Date().toISOString();
  const [cards, packs, mounts] = await Promise.all([
    listCharacterCards(input.userId),
    listAssetPacks(input.userId),
    listAssetMounts(input.userId),
  ]);
  const sourceCard = input.assetKind === "card" ? cards.find((c) => c.id === input.assetId) : undefined;
  const sourcePack = input.assetKind === "pack" ? packs.find((p) => p.id === input.assetId) : undefined;
  if (input.assetKind === "card" && !sourceCard) throw new AssetSourceMissingError("card", input.assetId);
  if (input.assetKind === "pack" && !sourcePack) throw new AssetSourceMissingError("pack", input.assetId);

  const packCopyId = sourcePack ? assetPackLocalCopyId(input.projectId, sourcePack.id) : null;
  const cardCopyId = sourceCard ? assetLocalCopyId(input.projectId, "card", sourceCard.id) : null;

  // ── D4 裁定：**既有挂用记录的查询排在环路守卫之前**。
  // 已成立的事实（记录存在 + 该次副本真的在库）＝幂等重放，直接收敛；来源血统之后被编辑
  // （例如把副本 id 写进来源自己的 lineage）不得把既成事实打成 400。
  // 只认「记录存在**且**副本在库且是这条来源的真副本」——否则就是「画面说已挂用、生成没东西注入」。
  const existingMount = mounts.find(
    (m) => m.id === assetMountId(input.projectId, input.assetKind, input.assetId),
  );
  const established =
    Boolean(existingMount) &&
    (sourceCard && cardCopyId
      ? cards.some((c) => c.id === cardCopyId && isGenuineCardCopy(c, input.projectId, sourceCard.id))
      : sourcePack && packCopyId
        ? packs.some((p) => p.id === packCopyId && isGenuinePackCopy(p, input.projectId, sourcePack.id))
        : false);

  // 祖先链：卡与包都在同一份快照里展开（血统只在资产本体上，不再多读一次 store）。
  const lineageOf = (assetId: string): readonly LineageLink[] | undefined =>
    cards.find((c) => c.id === assetId)?.lineage ?? packs.find((p) => p.id === assetId)?.lineage;
  const seedLineage = sourceCard?.lineage ?? sourcePack?.lineage ?? [];
  const ancestors = collectAncestorAssetIds(
    seedLineage,
    lineageOf,
    input.ancestorNodeBudget === undefined ? undefined : { maxNodes: input.ancestorNodeBudget },
  );
  // 超界＝无法证明无环 → fail-closed（唯一例外：已成立的幂等重放本来就不需要再问血统）。
  if (ancestors.truncated && !established) throw new AssetMountCopyRejectedError("unbounded_lineage");

  // 「已存在」必须**由 store 实测**得出，不能想当然地把推导值当既有（否则首次挂用会被当成重放，
  // 副本永远不落地＝画面说挂用、生成却没东西可注入）。
  const existingCopyIds = [
    ...(cardCopyId && cards.some((c) => c.id === cardCopyId) ? [cardCopyId] : []),
    ...(packCopyId && packs.some((p) => p.id === packCopyId) ? [packCopyId] : []),
  ];
  const planResult = planAssetMountCopy({
    projectId: input.projectId,
    assetKind: input.assetKind,
    sourceAssetId: input.assetId,
    ...(input.mode ? { mode: input.mode } : {}),
    ancestorAssetIds: ancestors.ids,
    existingCopyIds,
    established,
  });
  if (!planResult.ok) throw new AssetMountCopyRejectedError(planResult.reason);
  const plan = planResult.plan;
  /** 本次是真要 copy-on-use（引用制下不落地任何副本）。 */
  const wantsCopy = plan.localCopyId !== null;

  let localCopyId = plan.localCopyId ?? assetLocalCopyId(input.projectId, input.assetKind, input.assetId);
  const localCopyIds: string[] = [];
  let skippedItems = 0;
  let copied = false;

  if (input.assetKind === "card" && sourceCard && cardCopyId) {
    const occupant = cards.find((c) => c.id === cardCopyId);
    if (occupant && !isGenuineCardCopy(occupant, input.projectId, sourceCard.id)) {
      throw new AssetMountCopyConflictError(cardCopyId);
    }
    if (wantsCopy && !occupant) {
      if (cards.length + 1 > MAX_CARDS_PER_USER) {
        throw new AssetCopyLimitError(`资产卡数量已达上限 ${MAX_CARDS_PER_USER} 张，无法再建副本`);
      }
      const copy = buildCardCopy(sourceCard, { projectId: input.projectId, localCopyId: cardCopyId, now });
      if (!copy) throw new AssetMountCopyConflictError(cardCopyId);
      await saveCharacterCard(input.userId, copy);
      copied = true;
    }
    localCopyIds.push(cardCopyId);
  }

  if (input.assetKind === "pack" && sourcePack && packCopyId) {
    localCopyId = packCopyId;
    const projected = sourcePack.items.map((_, index) => buildPackItemCard(sourcePack, index, { projectId: input.projectId, now }));
    skippedItems = projected.filter((p) => !p.card).length;
    const newCards = projected.flatMap((p) => (p.card ? [p.card] : []));
    // 辨伪：占用同 id 的卡必须真是这条来源的条目副本（否则 409，不做别名）。
    for (const candidate of newCards) {
      const occupant = cards.find((c) => c.id === candidate.id);
      if (occupant && !isGenuineCardCopy(occupant, input.projectId, sourcePack.id)) {
        throw new AssetMountCopyConflictError(candidate.id);
      }
    }
    const packOccupant = packs.find((p) => p.id === packCopyId);
    if (packOccupant && !isGenuinePackCopy(packOccupant, input.projectId, sourcePack.id)) {
      throw new AssetMountCopyConflictError(packCopyId);
    }
    // 逐项收敛：缺哪张补哪张（全都在＝零写入，幂等重放不重写＝内容冻结）。
    const missing = newCards.filter((c) => !cards.some((existing) => existing.id === c.id));
    if (wantsCopy && (missing.length || !packOccupant)) {
      if (cards.length + missing.length > MAX_CARDS_PER_USER) {
        throw new AssetCopyLimitError(
          `资产卡数量已达上限 ${MAX_CARDS_PER_USER} 张：本包需再建 ${missing.length} 张副本卡`,
        );
      }
      if (!packOccupant && packs.length + 1 > MAX_PACKS_PER_USER) {
        throw new AssetCopyLimitError(`资产包数量已达上限 ${MAX_PACKS_PER_USER} 个，无法再建包副本`);
      }
      for (const card of missing) {
        await saveCharacterCard(input.userId, card);
      }
      if (!packOccupant) {
        const packCopy = normalizeAssetPack({
          ...sourcePack,
          id: packCopyId,
          scope: { owner: "project", projectId: input.projectId },
          ...(mergeLineageIntoHost(sourcePack, [{ kind: "derivation", assetId: sourcePack.id, at: now }]) ?? {}),
          createdAt: now,
          updatedAt: now,
        });
        if (!packCopy) throw new AssetMountCopyConflictError(packCopyId);
        await saveAssetPack(input.userId, packCopy);
      }
      copied = true;
    }
    localCopyIds.push(...newCards.map((c) => c.id));
  }

  const { mount, created } = await mountAsset(input.userId, {
    projectId: input.projectId,
    assetKind: input.assetKind,
    assetId: input.assetId,
    now,
    // D1：把「这次实际锁上的卡副本清单」落进挂用记录（前端照这份锁 cardIds，
    // 解除时也必须照同一份解锁——事后再从来源/本地包副本推导会漏解）。
    cardCopyIds: localCopyIds,
  });
  return { mount, created, copied, localCopyId, localCopyIds, skippedItems };
}

/**
 * 挂用记录对应的副本 id（解除挂用时前端据它解锁；记录不存在回空）。
 *
 * **记录优先**（D1）：记录里落了「挂用当时实际锁过的卡副本清单」，直接用它；
 * 只有 legacy 记录（没有 cardCopyIds）才回退**按本地包副本当下条目推导**——
 * 推导的输入会事后改变（来源包追加条目 / 本地包副本被删），与实际锁过的清单不同源时
 * 就会出现「已解除却仍被注入」且永久无法自愈（三个 UI 可达触发路径见 D1）。
 */
export async function mountCopyIds(input: {
  userId: number;
  projectId: string;
  assetKind: AssetKind;
  assetId: string;
}): Promise<{ localCopyId: string | null; localCopyIds: string[] }> {
  const normalized = normalizeAssetMount({
    projectId: input.projectId,
    assetKind: input.assetKind,
    assetId: input.assetId,
  });
  if (!normalized) return { localCopyId: null, localCopyIds: [] };
  const [mounts, packs] = await Promise.all([listAssetMounts(input.userId), listAssetPacks(input.userId)]);
  const found = mounts.find((m) => m.id === normalized.id);
  if (!found) return { localCopyId: null, localCopyIds: [] };
  const recorded = found.cardCopyIds ?? [];
  if (found.assetKind === "card") {
    return { localCopyId: found.localCopyId, localCopyIds: recorded.length ? recorded : [found.localCopyId] };
  }
  const localPack = packs.find((p) => p.id === found.localCopyId);
  const legacyItemIds = localPack ? localPack.items.map((_, index) => assetPackItemCopyId(input.projectId, found.assetId, index)) : [];
  const itemIds = recorded.length ? recorded : legacyItemIds;
  // 包副本本身也要解锁（它不在 cardIds 里，解锁是无害的 no-op），逐 item 副本照样在后。
  return { localCopyId: found.localCopyId, localCopyIds: [found.localCopyId, ...itemIds.filter((id) => id !== found.localCopyId)] };
}

/**
 * **解除挂用（含副本回收）**：先取「该笔挂用实际锁过的副本」，再解挂记录，最后把这些副本
 * 从资产库删掉。
 *
 * 为什么要一起回收（D5 额度/僵尸诚实）：
 *   - 副本的唯一用途就是「本项目生成时注入」；解除＝不再注入，留著只会占满
 *     MAX_CARDS_PER_USER（100 张）而使用者看不到它们（内部副本不列进资产库）；
 *   - 来源项目/来源资产日后删除，这些副本就成永久僵尸（既不可解释也不可用）。
 *   故解除＝连副本一起清掉，额度即刻释放，不留「静默占额度」的状态。
 *
 * 安全边界：只删**逐笔验证为这条来源的真副本**（scope 指向本项目 + derivation 边指向来源）
 * 的资产，绝不动使用者的自有资产。
 */
export async function unmountAssetAndCopies(input: {
  userId: number;
  projectId: string;
  assetKind: AssetKind;
  assetId: string;
}): Promise<{
  removed: boolean;
  localCopyId: string | null;
  localCopyIds: string[];
  /** 实际删掉的卡副本数 / 包副本数（诚实回报；非副本占用一律不动）。 */
  deletedCards: number;
  deletedPacks: number;
}> {
  const copies = await mountCopyIds(input);
  if (!copies.localCopyId) {
    // 没有挂用记录＝没有「这次挂用锁过的副本」可回收（不凭推导值乱删）。
    return { removed: false, localCopyId: null, localCopyIds: [], deletedCards: 0, deletedPacks: 0 };
  }
  const [cards, packs] = await Promise.all([listCharacterCards(input.userId), listAssetPacks(input.userId)]);
  // 卡副本：逐笔验证是这条来源的真副本才删（卡的挂用下 localCopyId 本身就是那张卡副本；
  // 包的挂用下 localCopyId 是包副本、不在卡库里，故不必也不能用 id 相等去排除）。
  const cardCopyIds = copies.localCopyIds.filter((id) =>
    cards.some((c) => c.id === id && isGenuineCardCopy(c, input.projectId, input.assetId)),
  );
  const packCopy = packs.find((p) => p.id === copies.localCopyId);
  const dropPack = packCopy ? isGenuinePackCopy(packCopy, input.projectId, input.assetId) : false;
  // 顺序契约：**先删副本、记录最后删**。倒置（先解锁再删）时删副本若半途而废，
  // 记录已消失→重试在 mountCopyIds 直接空转（见上方 !localCopyId 早退）→
  // 副本成永久僵尸且无自助恢复路径。现顺序下任何一步失败都可重试收敛：
  // 副本已删记录还在＝重试推导为空、删变 no-op、再落记录删除。
  const deletedCards = cardCopyIds.length ? await deleteCharacterCards(input.userId, cardCopyIds) : 0;
  if (dropPack) await deleteAssetPacks(input.userId, [copies.localCopyId]);
  const removed = await unmountAsset(input.userId, input);
  return {
    removed,
    localCopyId: copies.localCopyId,
    localCopyIds: copies.localCopyIds,
    deletedCards,
    deletedPacks: dropPack ? 1 : 0,
  };
}
