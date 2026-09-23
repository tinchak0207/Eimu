// REQ-B2 團隊資產空間：伺服器端組裝層（讀存取 → 可見性 → 掛用標記）。
//
// 只做三件事：把既有兩套資產表示（資產包 / 資產卡）映射成作用域層的候選項、
// 過一次可見性、帶上當前項目的掛用標記。資產本體與其清洗收口**不動**
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
 * 讀當前用戶的資產面 → 候選項 + 使用上下文（單次讀，呼叫端共用同一份快照，
 * 避免「列表用舊快照、掛用用新快照」造成的判定漂移）。
 * projectId 為 null → 無項目上下文，只有個人資產可見（禁默認全網可見）。
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

/** 項目資產庫列表（可見性過濾 + 檢索 + 篩選）。 */
export async function listProjectAssetLibrary(input: {
  userId: number;
  projectId: string | null;
  query?: AssetLibraryQuery;
}): Promise<{
  items: AssetLibraryItem[];
  shares: AssetShareRecord[];
  /** 授權**進來**本項目的有效分享（前端讀取閘判 shared-in 用；copy-on-use 下正常流程不依賴它）。 */
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

/** 掛用前置檢查：不可見即不可用（回 null → API 層必須 403，不得靜默成功）。 */
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
  ownerUserId: number;
}

/**
 * 找當前用戶名下的某個資產（分享授權裁決要用它的 scope）。
 * 找不到回 null（API 層 404）。
 */
export async function findOwnedAsset(input: {
  userId: number;
  assetKind: AssetKind;
  assetId: string;
}): Promise<OwnedAssetRef | null> {
  if (input.assetKind === "pack") {
    const pack = (await listAssetPacks(input.userId)).find((p) => p.id === input.assetId);
    return pack ? { id: pack.id, kind: "pack", ...(pack.scope ? { scope: pack.scope } : {}), ownerUserId: input.userId } : null;
  }
  const card = (await listCharacterCards(input.userId)).find((c) => c.id === input.assetId);
  return card ? { id: card.id, kind: "card", ...(card.scope ? { scope: card.scope } : {}), ownerUserId: input.userId } : null;
}

/** 當前項目已掛用的資產鍵（UI badge 用）。 */
export function mountedCountFor(mounts: readonly AssetMountRecord[], projectId: string | null): number {
  if (!projectId) return 0;
  return mounts.filter((m) => m.projectId === projectId).length;
}

/** 單一資產在當前上下文的可見性（測試與除錯入口）。 */
export function visibilityOf(
  asset: OwnedAssetRef,
  ctx: AssetUseContext,
): AssetVisibility | null {
  return resolveAssetVisibility({ id: asset.id, kind: asset.kind, scope: asset.scope, ownerUserId: asset.ownerUserId }, ctx);
}

// ─────────────────────────────────────────── 使用/注入路徑的裁決（REQ-B2）

/**
 * **使用/注入路徑的唯一裁決入口**（內部仍只呼叫 resolveAssetVisibility，
 * 不在呼叫端另立規則）：某資產在此（可選項目）上下文是否可用。不可見即不可用。
 * - agent 主動包注入（/api/agent/sessions、/api/agent/sessions/[id]/memory）
 * - 鎖定卡注入（/api/canvas/projects 的 cardIds 閘）
 * 都必須走本函式或其等價包裝；未來切換跨項目語義（copy-on-use ↔ 引用＋解鏈閘）
 * 只需改 resolveAssetVisibility，不必動各使用路徑。
 */
export async function isAssetUsable(input: {
  userId: number;
  /** 當前項目 id；null＝無項目上下文（項目資產一律不可用，個人資產照用）。 */
  projectId: string | null;
  assetKind: AssetKind;
  assetId: string;
}): Promise<boolean> {
  const owned = await findOwnedAsset({ userId: input.userId, assetKind: input.assetKind, assetId: input.assetId });
  if (!owned) return false;
  const shares = await listAssetShares(input.userId);
  return canUseAsset(
    { id: owned.id, kind: owned.kind, scope: owned.scope, ownerUserId: owned.ownerUserId },
    { viewerUserId: input.userId, projectId: input.projectId, shares },
  );
}

/**
 * 從（不可信）請求體取項目上下文：非字串/空 → null。
 * null 的語義是「無項目上下文」＝項目歸屬的資產一律不可用（個人資產照用），fail-closed。
 */
export function projectIdFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { projectId?: unknown; project_id?: unknown }).projectId
    ?? (body as { projectId?: unknown; project_id?: unknown }).project_id;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * 項目保存閘：cardIds 逐個過作用域裁決（生成注入讀的就是這份 cardIds，
 * 故跨項目、未顯式分享的卡不得鎖進本項目）。
 * - 查不到的 id（卡未載入/已刪）**原樣保留**——不猜，維持既有「未解析」語義。
 * - 個人卡（scope 缺省）逐位不變（零回歸：既有單用戶個人資產流程不變）。
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
    if (!card) return true; // 查不到＝無法判定，不猜（不因此靜默丟卡）
    return canUseAsset({ id: card.id, kind: "card", scope: card.scope, ownerUserId: input.userId }, ctx);
  });
}

// ─────────────────────────────────────────── REQ-B2b 掛用＝copy-on-use

/** 來源資產不存在（API 層 404：宣告了來源卻找不到，不得靜默成功）。 */
export class AssetSourceMissingError extends Error {
  constructor(assetKind: AssetKind, assetId: string) {
    super(`资产不存在：${assetKind}:${assetId}`);
    this.name = "AssetSourceMissingError";
  }
}

/**
 * 副本鍵已被「不是這條來源的副本」的資產佔用（API 層 409）。
 * 確定性副本 id 是雜湊值：正常呼叫不可能撞；一旦撞上而佔用者不是這條來源的副本，
 * **絕不冒充冪等重放**（否則就是拿別人的資產當你的副本＝靜默別名）。
 */
export class AssetMountCopyConflictError extends Error {
  constructor(localCopyId: string) {
    super(`副本键冲突：${localCopyId} 已被另一份资产占用，请勿复用同一资产 id`);
    this.name = "AssetMountCopyConflictError";
  }
}

/** 建副本會超出資產上限（API 層 400）：誠實拒絕，不靜默截斷（截斷＝使用者以為掛滿了）。 */
export class AssetCopyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetCopyLimitError";
  }
}

/** 環路/自引用/血統不可判定（API 層 400）：見 asset-scope.planAssetMountCopy 的三條守衛。 */
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

/** 掛用（copy-on-use）結果：副本 id 是重點——前端必須把它鎖進 cardIds，否則等於沒掛用。 */
export interface MountAssetWithCopyResult {
  mount: AssetMountRecord;
  /** 掛用記錄是否新建（false＝同鍵重放；副本不重寫，內容凍結在首次掛用那一刻）。 */
  created: boolean;
  /** 本次是否真的新建了副本（false＝冪等重放，零副作用）。 */
  copied: boolean;
  /** 本地副本主體：卡＝該卡 id；包＝本地包副本 id。 */
  localCopyId: string;
  /** **可鎖進 cardIds 的卡副本 id**（卡＝[localCopyId]；包＝逐 item 副本）。 */
  localCopyIds: string[];
  /** 包內「無卡投影」的條目數（如 lora / 3D 產物）：誠實回報，不假裝全搬成卡。 */
  skippedItems: number;
}

/** 卡的複製：內容逐欄照抄 + scope 指向目標項目 + lineage 一條 derivation 指回來源。 */
function buildCardCopy(source: CharacterCard, input: { projectId: string; localCopyId: string; now: string }): CharacterCard | null {
  // 血統只登記**直接來源**一條（D1 欄位語義＝「直接來源鏈」，parents 上限 5）：
  // 更上游由讀取端沿 lineage 逐級解析（遞歸掛用＝一串可回溯的副本節點），
  // 不把祖先攤平成同一層的兄弟——攤平會讓「溯源抽屜」把兩級畫成同級。
  const lineage = mergeLineageIntoHost(null, [{ kind: "derivation", assetId: source.id, at: input.now }]);
  return normalizeCharacterCard({
    ...source,
    id: input.localCopyId,
    scope: { owner: "project", projectId: input.projectId },
    ...(lineage ?? {}),
    // 副本自己的生卒時間（時間點凍結的可審計痕跡：來源日後更新不進這裡）。
    createdAt: input.now,
    updatedAt: input.now,
  });
}

/** 包內條目 → 卡副本的投影規則（條目種類 → 卡型/內容）；回 null＝該條目沒有卡投影。 */
function buildPackItemCard(
  source: AssetPack,
  itemIndex: number,
  input: { projectId: string; now: string },
): { card: CharacterCard | null; copyId: string } {
  const item = source.items[itemIndex];
  const copyId = assetPackItemCopyId(input.projectId, source.id, itemIndex);
  const name = item.title.slice(0, 100); // 卡名上限 100（超長＝normalizeCharacterCard 直接丟卡）
  // 血統：條目卡指向**來源包**（包本身的血統欄再指回更上游，見 mountAssetWithCopy 的包副本）。
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
  // lora / scene_3d / bpy_script：沒有卡投影（不臆造卡型），由呼叫端計入 skippedItems 誠實回報。
  return { copyId, card: null };
}

/** 候選副本 id 是否**真是**這條來源的副本（撞鍵辨偽的唯一判據，見 AssetMountCopyConflictError）。 */
function isGenuineCardCopy(card: CharacterCard, projectId: string, sourceAssetId: string): boolean {
  if (card.scope?.owner !== "project" || card.scope.projectId !== projectId) return false;
  return (card.lineage ?? []).some((link) => link.kind === "derivation" && link.assetId === sourceAssetId);
}

/** 包副本的辨偽：scope 指向目標項目 + lineage 的 derivation 指向來源包。 */
function isGenuinePackCopy(pack: AssetPack, projectId: string, sourcePackId: string): boolean {
  if (pack.scope?.owner !== "project" || pack.scope.projectId !== projectId) return false;
  return (pack.lineage ?? []).some((link) => link.kind === "derivation" && link.assetId === sourcePackId);
}

/** 血統圖遍歷的節點預算（**防禦性**上限：正常帳號的資產總數遠低於此，見下）。 */
export const MAX_ANCESTOR_NODES = 2000;

/**
 * 來源的血統祖先把手（**完整** BFS：走訪到窮盡為止）。
 *
 * 為何不再是「有界 BFS」：舊版 maxDepth=5 / maxNodes=50 會把 6 跳的真環當成「查不到就算沒環」
 * → 環路守衛被繞過（D2 實測）。圖的節點就是**本呼叫已經讀進來的那份快照**（cards + packs，
 * 上界＝MAX_CARDS_PER_USER + MAX_PACKS_PER_USER ＝ 200），未知 id 沒有出邊 ⇒ 遍歷必然終止，
 * 故完整遍歷的成本是有界的。`maxNodes` 只是防禦性閘：真撞到就回 `truncated:true`，
 * 由呼叫端 **fail-closed**（拒絕並回可辨識原因），絕不「查不完就當沒環」。
 *
 * 只認 assetId 把手（jobId/nodeId 不是資產，無法在資產庫裡展開）。
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
 * **掛用＝copy-on-use**（REQ-B2b，暴君 09-23 裁定）：在目標項目建本地副本（內容本體），
 * lineage 記一條指向來源的 `derivation` 邊，再落冪等掛用記錄。
 *
 * 不變量：
 *   - **運行時自足**：副本是獨立資產實體，生成注入只讀副本自己的內容；來源資產
 *     （卡/包）與來源**項目**日後刪除、改名、改內容都不影響它（口徑修正 09-23：
 *     副本的 derivation 邊**可以**指向別的 project 的來源實體——那是審計痕跡，
 *     不是運行依賴，故「刪來源不影響副本」「副本不被外部 project 狀態決定」才是要守的東西）；
 *   - **時間點凍結**：來源日後更新**不**回寫副本（同鍵重掛也不重寫副本）；
 *   - **冪等一份**：同 `(projectId, sourceAssetId)` 只建一份副本（副本 id 確定性推導 +
 *     建前辨偽）；重放零副作用（連 store 都不寫）；
 *   - **冪等不因事後編輯而失效**（D4）：同鍵掛用記錄已存在且該次副本已落地 = 已成立的事實，
 *     重掛直接回既有結果，**不得**因為來源血統事後被編輯成含副本 id 而 400；
 *   - **誠實拒絕**：來源查無 → AssetSourceMissingError(404)；副本鍵被非副本佔用 →
 *     AssetMountCopyConflictError(409)；環路 → AssetMountCopyRejectedError(400)；
 *     血統圖超界無法證明無環 → AssetMountCopyRejectedError("unbounded_lineage")；
 *     超上限 → AssetCopyLimitError(400)。
 *
 * 呼叫端（API 層）必須先過可見性裁決（resolveMountable），本函式只負責搬內容與落庫。
 */
export async function mountAssetWithCopy(input: {
  userId: number;
  projectId: string;
  assetKind: AssetKind;
  assetId: string;
  /** 時間源（測試注入；缺省＝現在）。 */
  now?: string;
  /** 跨項目語義（缺省 copy-on-use；"reference" 只落記錄不建副本，供方向切換演練/測試）。 */
  mode?: AssetMountCopyMode;
  /**
   * 血統遍歷節點預算（**測試注入**；缺省＝MAX_ANCESTOR_NODES）。
   * 存在的唯一目的：讓「超界 → fail-closed 拒絕（unbounded_lineage）」這條路徑成為
   * 可斷言的真實行為，而不是只寫在註解裡的宣稱（正常帳號的資產上界 200 遠低於預設預算）。
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

  // ── D4 裁定：**既有掛用記錄的查詢排在環路守衛之前**。
  // 已成立的事實（記錄存在 + 該次副本真的在庫）＝冪等重放，直接收斂；來源血統之後被編輯
  // （例如把副本 id 寫進來源自己的 lineage）不得把既成事實打成 400。
  // 只認「記錄存在**且**副本在庫且是這條來源的真副本」——否則就是「畫面說已掛用、生成沒東西注入」。
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

  // 祖先鏈：卡與包都在同一份快照裡展開（血統只在資產本體上，不再多讀一次 store）。
  const lineageOf = (assetId: string): readonly LineageLink[] | undefined =>
    cards.find((c) => c.id === assetId)?.lineage ?? packs.find((p) => p.id === assetId)?.lineage;
  const seedLineage = sourceCard?.lineage ?? sourcePack?.lineage ?? [];
  const ancestors = collectAncestorAssetIds(
    seedLineage,
    lineageOf,
    input.ancestorNodeBudget === undefined ? undefined : { maxNodes: input.ancestorNodeBudget },
  );
  // 超界＝無法證明無環 → fail-closed（唯一例外：已成立的冪等重放本來就不需要再問血統）。
  if (ancestors.truncated && !established) throw new AssetMountCopyRejectedError("unbounded_lineage");

  // 「已存在」必須**由 store 實測**得出，不能想當然地把推導值當既有（否則首次掛用會被當成重放，
  // 副本永遠不落地＝畫面說掛用、生成卻沒東西可注入）。
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
    // 辨偽：佔用同 id 的卡必須真是這條來源的條目副本（否則 409，不做別名）。
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
    // 逐項收斂：缺哪張補哪張（全都在＝零寫入，冪等重放不重寫＝內容凍結）。
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
    // D1：把「這次實際鎖上的卡副本清單」落進掛用記錄（前端照這份鎖 cardIds，
    // 解除時也必須照同一份解鎖——事後再從來源/本地包副本推導會漏解）。
    cardCopyIds: localCopyIds,
  });
  return { mount, created, copied, localCopyId, localCopyIds, skippedItems };
}

/**
 * 掛用記錄對應的副本 id（解除掛用時前端據它解鎖；記錄不存在回空）。
 *
 * **記錄優先**（D1）：記錄裡落了「掛用當時實際鎖過的卡副本清單」，直接用它；
 * 只有 legacy 記錄（沒有 cardCopyIds）才回退**按本地包副本當下條目推導**——
 * 推導的輸入會事後改變（來源包追加條目 / 本地包副本被刪），與實際鎖過的清單不同源時
 * 就會出現「已解除卻仍被注入」且永久無法自愈（三個 UI 可達觸發路徑見 D1）。
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
  // 包副本本身也要解鎖（它不在 cardIds 裡，解鎖是無害的 no-op），逐 item 副本照樣在後。
  return { localCopyId: found.localCopyId, localCopyIds: [found.localCopyId, ...itemIds.filter((id) => id !== found.localCopyId)] };
}

/**
 * **解除掛用（含副本回收）**：先取「該筆掛用實際鎖過的副本」，再解掛記錄，最後把這些副本
 * 從資產庫刪掉。
 *
 * 為什麼要一起回收（D5 額度/殭屍誠實）：
 *   - 副本的唯一用途就是「本項目生成時注入」；解除＝不再注入，留著只會佔滿
 *     MAX_CARDS_PER_USER（100 張）而使用者看不到它們（內部副本不列進資產庫）；
 *   - 來源項目/來源資產日後刪除，這些副本就成永久殭屍（既不可解釋也不可用）。
 *   故解除＝連副本一起清掉，額度即刻釋放，不留「靜默佔額度」的狀態。
 *
 * 安全邊界：只刪**逐筆驗證為這條來源的真副本**（scope 指向本項目 + derivation 邊指向來源）
 * 的資產，絕不動使用者的自有資產。
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
  /** 實際刪掉的卡副本數 / 包副本數（誠實回報；非副本佔用一律不動）。 */
  deletedCards: number;
  deletedPacks: number;
}> {
  const copies = await mountCopyIds(input);
  if (!copies.localCopyId) {
    // 沒有掛用記錄＝沒有「這次掛用鎖過的副本」可回收（不憑推導值亂刪）。
    return { removed: false, localCopyId: null, localCopyIds: [], deletedCards: 0, deletedPacks: 0 };
  }
  const [cards, packs] = await Promise.all([listCharacterCards(input.userId), listAssetPacks(input.userId)]);
  // 卡副本：逐筆驗證是這條來源的真副本才刪（卡的掛用下 localCopyId 本身就是那張卡副本；
  // 包的掛用下 localCopyId 是包副本、不在卡庫裡，故不必也不能用 id 相等去排除）。
  const cardCopyIds = copies.localCopyIds.filter((id) =>
    cards.some((c) => c.id === id && isGenuineCardCopy(c, input.projectId, input.assetId)),
  );
  const packCopy = packs.find((p) => p.id === copies.localCopyId);
  const dropPack = packCopy ? isGenuinePackCopy(packCopy, input.projectId, input.assetId) : false;
  // 順序契約：**先刪副本、記錄最後刪**。倒置（先解鎖再刪）時刪副本若半途而廢，
  // 記錄已消失→重試在 mountCopyIds 直接空轉（見上方 !localCopyId 早退）→
  // 副本成永久殭屍且無自助恢復路徑。現順序下任何一步失敗都可重試收斂：
  // 副本已刪記錄還在＝重試推導為空、刪變 no-op、再落記錄刪除。
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
