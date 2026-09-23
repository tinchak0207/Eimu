// REQ-B2 團隊資產空間：作用域層（純邏輯，無 IO）。
//
// 定位：把**現成**資產包（asset-pack-store）＋資產卡（character-cards）掛到
// project-scoped library —— 本檔只加「歸屬 / 可見性 / 復用」三件事，
// **不另造資產格式**：scope 只是既有記錄上的一個可選欄位（見 asset-pack-store
// 與 character-cards 的清洗收口），資產實體仍是原本那兩套表示。
//
// 三鐵律：
//   1. **不可見即不可用**：任何跨項目使用都先過 resolveAssetVisibility，
//      回 null = 不列進列表、掛用直接拒絕（禁默認全網可見）。
//   2. **跨項目復用需顯式分享**：唯一入口是 AssetShareRecord（grant / revoke 顯式動作），
//      沒有「同帳號自動可見」「同組織自動可見」這類隱含規則。
//   3. **冪等鏈復用既有件**：mount / share 的 id 與 idempotencyRef 都是**確定性鍵**
//      （`{action}:{scope}:{target}` 同形，對齊 generation-core 既有 key 慣例，
//      例：master-ingest `film_export:{sessionId}:{fingerprint}`）——
//      重複掛用 / 重複分享只命中同一件，不產生第二筆（計費冪等不雙扣的地基）。
//      **鍵段一律長度前綴單射化**（`{len}:{value}`）：裸 `:` 拼接會讓
//      `pack:"x:card:y"` 與 `projectId:"x", card:"y"` 產出同一個鍵（實測撞鍵），
//      撞鍵 = 授權跨資產別名 + 靜默成功謊言，故鍵段必須單射；同時在資產 id 的
//      驗證邊界（isUsableAssetId）拒絕含保留分隔符的 id。
//   4. **碰撞不得靜默成功**：同鍵但三元組不同 = 真碰撞（別名），一律回
//      conflict（API 層 409），不得當成冪等重放回 `success:true`。
//
// metadata 紀律（裁決，同 D1 lineage 先例）：scope 只給人看（項目資產庫面板），
// **不進 canvas 節點 metadata、不進 toNodeMetadata、不進 compactMetadataForAgent**；
// 反之，資產庫列表本身也不經雙白名單（它不落地成 canvas 節點）。
//
// 已知邊界（本刀刻意不吞，寫明不裝懂）：
//   1. 掛用（AssetMountRecord）＝「收入項目資產庫」的成員關係；生成時的卡片注入走
//      既有 `CanvasProject.cardIds` 鎖定機制。**兩條都查作用域**：注入端走
//      `resolveAssetVisibility`（storyboard-contract 的 scope 選項），鎖定端走
//      `/api/canvas/projects` 的 cardIds 閘（都是同一裁決函式的包裝）。
//   2. 跨項目掛用語義＝**copy-on-use**（暴君 2026-09-23 裁定）：掛用＝在目標項目建
//      本地副本 + lineage 指向來源（副本**運行時自足**：來源/來源項目日後刪除不影響副本；
//      lineage 邊**可以**指向別的 project 的來源實體——它只是審計痕跡，不是運行依賴）。
//      本檔的 mount 記錄仍是「來源→目標」的連接記錄，副本身份＝ `localCopyId`
//      （確定性推導），副本本體由 asset-library.mountAssetWithCopy 落地。
//   3. 內部副本（copy-on-use 落地的本地副本）**不是可掛用條目**：不列進資產庫候選、
//      掛用閘直接拒（見 isAssetLocalCopyId）——否則「副本的副本」會讓卡片無限膨脹（D5）。
//
// **方向可切換**：作用域裁決走單一入口 `resolveAssetVisibility`（包裝＝
// `filterUsableAssets` / asset-library 的 `isAssetUsable` / `resolveMountableAsset`）；
// copy-on-use ↔ 引用制的唯一分歧點是 `planAssetMountCopy`。若日後改回「引用＋解鏈閘」，
// 只需改這兩個函式（＋門禁呼叫端），不必動各使用路徑。

// ─────────────────────────────────────────── 資產種類（既有兩套表示的鍵）

/** 資產種類＝既有兩種表示：pack（資產包）/ card（角色·場景·風格卡）。 */
export type AssetKind = "pack" | "card";

/** 運行期判據：不可信 payload 的值域收斂（非 pack/card 一律 null）。 */
export function toAssetKind(value: unknown): AssetKind | null {
  return value === "pack" || value === "card" ? value : null;
}

// ─────────────────────────────────────────── 歸屬（個人 / 項目）

export type AssetOwnership = "personal" | "project";

/** 資產歸屬：personal＝個人資產（本帳號所有項目可用）；project＝屬於某個項目。 */
export interface AssetScope {
  owner: AssetOwnership;
  /** 僅 owner==="project" 有意義（personal 恆省略，不寫 `projectId: ""` 冒充）。 */
  projectId?: string;
}

/** 缺省＝personal，向後相容既有資產（本刀之前存的包/卡都沒有 scope 欄）。 */
export const DEFAULT_ASSET_SCOPE: AssetScope = { owner: "personal" };

/**
 * **鬼狀態**的持久化形狀：`owner:"project"` 而**無** projectId。
 *
 * 語義（與 resolveAssetScopeVisibility 的「鬼狀態 → null」宣稱對齊，見 D3）：
 * 宣稱屬於某個項目卻說不出是哪個項目 → **任何**上下文都不可見/不可用（fail-closed），
 * 既不降格成人人可用的 personal，也不猜是哪個項目。
 * 代理人（character-cards / asset-pack-store）收到 normalizeAssetScope 回 null 時寫回此形狀，
 * 使「存檔 → 讀檔」兩端都不會漂移成 personal。
 */
export const GHOST_ASSET_SCOPE: AssetScope = { owner: "project" };

const MAX_PROJECT_ID_LENGTH = 120;

/**
 * 收斂作用域欄位（存檔與讀檔共用同一收口）：
 * - 非物件 / 非 "project" → personal（含舊資料）
 * - owner==="project" 但 projectId 空 → **null**（鬼狀態；呼叫端寫回 GHOST_ASSET_SCOPE，
 *   不得降格成 personal —— 降格＝把「歸屬不明的項目資產」變成所有人都能用的個人資產，
 *   正是 D3 的 fail-open 病灶）
 */
export function normalizeAssetScope(raw: unknown): AssetScope | null {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_ASSET_SCOPE };
  const r = raw as { owner?: unknown; projectId?: unknown };
  if (r.owner !== "project") return { ...DEFAULT_ASSET_SCOPE };
  const projectId = typeof r.projectId === "string" ? r.projectId.trim().slice(0, MAX_PROJECT_ID_LENGTH) : "";
  return projectId ? { owner: "project", projectId } : null;
}

/** 兩份作用域是否等值（掛用/分享去重與測試斷言用）。 */
export function sameAssetScope(a: AssetScope, b: AssetScope): boolean {
  return a.owner === b.owner && (a.projectId ?? "") === (b.projectId ?? "");
}

// ─────────────────────────────────────────── 顯式分享（跨項目授權）

/** 顯式分享授權：把 fromProjectId 名下的一個資產授權給 toProjectId 可見可用。 */
export interface AssetShareRecord {
  /**
   * 確定性 id（不隨機）：`share:{kind}:{len(assetId)}:{assetId}:{len(from)}:{from}:{len(to)}:{to}`。
   * 段長度前綴＝單射（含分隔符的 id 已由 isUsableAssetId 在邊界拒絕）。
   * 同一次分享重放 = 同一個 id → 幂等，不產生第二筆授權。
   */
  id: string;
  assetKind: AssetKind;
  assetId: string;
  /** 資產所屬項目（分享的來源）。 */
  fromProjectId: string;
  /** 被顯式授權的目標項目。 */
  toProjectId: string;
  createdAt: string;
  /** 撤銷時間；有值＝已撤銷（撤銷後不再可見，但記錄留痕）。 */
  revokedAt?: string;
}

/** 資產 id 長度上限（share / mount / pack 三處同一個界，避免「可建不可分享」）。 */
export const MAX_ASSET_ID_LENGTH = 200;

/**
 * 確定性鍵的保留段分隔符。資產 id 含它 = 舊版裸拼接鍵會與別的 (kind, id) 組合撞鍵，
 * 故在資產 id 的驗證邊界（isUsableAssetId）直接拒絕，不只靠鍵端單射化兜底。
 */
export const ASSET_KEY_DELIMITER = ":";

/**
 * 資產 id 的字元/長度邊界（**存檔收口與確定性鍵共用**）：
 * 非字串 / 空 / 超長 / 含保留分隔符 `:` / 含控制字元 → false。
 * 呼叫端不得自行 trim 後放行（否則「長度前綴」就不是唯一真源）。
 */
export function isUsableAssetId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const clean = value.trim();
  if (!clean || clean.length > MAX_ASSET_ID_LENGTH) return false;
  if (clean.includes(ASSET_KEY_DELIMITER)) return false;
  // 控制字元（含 \n \t \0）在日誌/鍵裡都可被用來偽造段邊界。
  for (const ch of clean) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** 鍵段單射化：長度前綴 `{len}:{value}`——(`"x:card:y"`, `""`) 與 (`"x"`, `"y"`) 不再撞鍵。 */
function keySegment(value: string): string {
  return `${value.length}:${value}`;
}

/** 分享記錄的確定性 id（分享冪等的唯一鍵）。 */
export function assetShareId(
  assetKind: AssetKind,
  assetId: string,
  fromProjectId: string,
  toProjectId: string,
): string {
  return `share:${assetKind}:${keySegment(assetId)}:${keySegment(fromProjectId)}:${keySegment(toProjectId)}`;
}

/**
 * 段值清洗（id 以外的段）：
 * 非字串 / 空 → ""；**超長一律拒絕（回 ""）而非截斷**——截斷會讓兩個不同值落成同一段
 * （＝另一種撞鍵），fail-closed。
 */
function boundedSegment(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const clean = value.trim();
  return clean && clean.length <= max ? clean : "";
}


/**
 * 清洗分享記錄（存檔/讀檔唯一收口）。
 * id 由三元組**重新推導**（不接受外部傳入的 id：確定性鍵不許被呼叫端改寫）。
 * 三元組任一缺損 → null（呼叫端丟棄）。
 */
export function normalizeAssetShare(raw: unknown): AssetShareRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<AssetShareRecord>;
  const assetKind = toAssetKind(r.assetKind);
  const assetId = isUsableAssetId(r.assetId) ? r.assetId.trim() : "";
  const fromProjectId = boundedSegment(r.fromProjectId, MAX_PROJECT_ID_LENGTH);
  const toProjectId = boundedSegment(r.toProjectId, MAX_PROJECT_ID_LENGTH);
  if (!assetKind || !assetId || !fromProjectId || !toProjectId) return null;
  const now = new Date().toISOString();
  return {
    id: assetShareId(assetKind, assetId, fromProjectId, toProjectId),
    assetKind,
    assetId,
    fromProjectId,
    toProjectId,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : now,
    ...(typeof r.revokedAt === "string" ? { revokedAt: r.revokedAt } : {}),
  };
}

/** 撤銷後不再可見（記錄留痕，不刪）。 */
export function isAssetShareActive(share: AssetShareRecord): boolean {
  return !share.revokedAt;
}

/** 命中「把 fromProjectId 的某資產顯式分享給 toProjectId」的有效授權。 */
export function findActiveAssetShare(
  shares: readonly AssetShareRecord[],
  assetKind: AssetKind,
  assetId: string,
  fromProjectId: string,
  toProjectId: string | null,
): AssetShareRecord | null {
  if (!toProjectId) return null;
  const wanted = assetShareId(assetKind, assetId, fromProjectId, toProjectId);
  return shares.find((s) => s.id === wanted && isAssetShareActive(s)) ?? null;
}

/** 分享動作的裁決結果（拒絕理由要能直說，不吞）。 */
export type ShareGrantRejectReason =
  | "cross_user"
  | "not_a_project_asset"
  | "project_mismatch"
  | "missing_target_project"
  | "same_project";

/** 只有「資產擁有者」能把「屬於 fromProjectId 的項目資產」顯式分享給另一個項目。 */
export function decideAssetShareGrant(input: {
  viewerUserId: number;
  asset: ScopedAssetLike;
  fromProjectId: string;
  toProjectId: string;
}): { ok: true } | { ok: false; reason: ShareGrantRejectReason } {
  const { asset } = input;
  if (asset.ownerUserId !== input.viewerUserId) return { ok: false, reason: "cross_user" };
  const scope = asset.scope ?? DEFAULT_ASSET_SCOPE;
  if (scope.owner !== "project") return { ok: false, reason: "not_a_project_asset" };
  if ((scope.projectId ?? "") !== input.fromProjectId) return { ok: false, reason: "project_mismatch" };
  const to = boundedSegment(input.toProjectId, MAX_PROJECT_ID_LENGTH);
  if (!to) return { ok: false, reason: "missing_target_project" };
  if (to === input.fromProjectId) return { ok: false, reason: "same_project" };
  return { ok: true };
}

/**
 * 冪等授權（純函式）：
 * - 同鍵已生效 → 原樣返回 created:false（**不新增第二筆**，計費/額度鏈不雙扣）
 * - 同鍵存在但已撤銷 → 復活（移除 revokedAt），created:false（仍是同一件）
 * - 同鍵但三元組不同 → **conflict:true**（真碰撞/別名，呼叫端必須回衝突，禁靜默成功）
 * - 不存在 → 新增，created:true
 */
export function applyAssetShareGrant(
  shares: readonly AssetShareRecord[],
  input: { assetKind: AssetKind; assetId: string; fromProjectId: string; toProjectId: string; now?: string },
): { shares: AssetShareRecord[]; share: AssetShareRecord; created: boolean; conflict: boolean } {
  const normalized = normalizeAssetShare({
    assetKind: input.assetKind,
    assetId: input.assetId,
    fromProjectId: input.fromProjectId,
    toProjectId: input.toProjectId,
    createdAt: input.now ?? new Date().toISOString(),
  });
  if (!normalized) throw new Error("invalid asset share");
  const existing = shares.find((s) => s.id === normalized.id);
  if (!existing) return { shares: [...shares, normalized], share: normalized, created: true, conflict: false };
  // 同鍵不同三元組 = 鍵碰撞（不可能來自正常呼叫；來自舊鍵/外部偽造時不許冒充冪等重放）。
  if (!sameShareTriple(existing, normalized)) {
    return { shares: [...shares], share: existing, created: false, conflict: true };
  }
  if (isAssetShareActive(existing)) return { shares: [...shares], share: existing, created: false, conflict: false };
  // 復活：逐欄重建（不用展開運算子，否則 revokedAt 會被一起帶回來＝撤銷失效）。
  const revived: AssetShareRecord = {
    id: existing.id,
    assetKind: existing.assetKind,
    assetId: existing.assetId,
    fromProjectId: existing.fromProjectId,
    toProjectId: existing.toProjectId,
    createdAt: normalized.createdAt,
  };
  return { shares: shares.map((s) => (s.id === revived.id ? revived : s)), share: revived, created: false, conflict: false };
}

/** 分享三元組逐欄等值（不用 JSON.stringify：欄位序不是契約）。 */
function sameShareTriple(a: AssetShareRecord, b: AssetShareRecord): boolean {
  return (
    a.assetKind === b.assetKind &&
    a.assetId === b.assetId &&
    a.fromProjectId === b.fromProjectId &&
    a.toProjectId === b.toProjectId
  );
}

/** 撤銷授權（按確定性 id）。回是否真的撤銷了（已撤銷/不存在回 false）。 */
export function applyAssetShareRevoke(
  shares: readonly AssetShareRecord[],
  shareId: string,
  now?: string,
): { shares: AssetShareRecord[]; revoked: boolean } {
  const target = shares.find((s) => s.id === shareId);
  if (!target || !isAssetShareActive(target)) return { shares: [...shares], revoked: false };
  const revokedAt = now ?? new Date().toISOString();
  return {
    shares: shares.map((s) => (s.id === shareId ? { ...s, revokedAt } : s)),
    revoked: true,
  };
}

// ─────────────────────────────────────────── 可見性（不可見即不可用）

/** 資產記錄的最小白名單視圖（pack / card 兩套表示都映射到這裡）。 */
export interface ScopedAssetLike {
  id: string;
  kind: AssetKind;
  /** 資產記錄上的作用域；缺省＝personal（舊資產零改動）。 */
  scope?: AssetScope;
  /** 資產擁有者（= 存儲桶 userId）。 */
  ownerUserId: number;
}

/** 可見性判定結果：owner＝個人資產；in-project＝本項目資產；shared-in＝顯式分享進來。 */
export type AssetVisibility = "owner" | "in-project" | "shared-in";

export interface AssetUseContext {
  viewerUserId: number;
  /** 當前項目 id；無項目上下文（如全域資產頁）為 null —— 此時只有 personal 資產可見。 */
  projectId: string | null;
  shares: readonly AssetShareRecord[];
}

/**
 * **作用域段的唯一裁決**（不含 owner 驗證）：
 * - personal（缺省）→ owner（跨項目恆可用）
 * - project-scoped 且屬於當前項目 → in-project
 * - project-scoped 但有 from→to 有效分享 → shared-in
 * - 其餘（含「owner=project 但 projectId 空」的鬼狀態）→ null（不可見即不可用）
 *
 * 為何抽出這一層：伺服器端（resolveAssetVisibility）與**客戶端讀取閘**
 * （use-canvas-cards 的鎖定卡清單；客戶端的卡已由按登入用戶隔離的
 * `/api/character-cards` 取得，故無 owner 可比）必須是同一把尺——
 * 兩處各寫一份 scope 分支＝寫入端放行、讀取端丟卡的「畫面說掛用、生成不注入」病灶。
 */
export function resolveAssetScopeVisibility(
  asset: { id: string; kind: AssetKind; scope?: AssetScope },
  ctx: AssetUseContext,
): AssetVisibility | null {
  const scope = asset.scope ?? DEFAULT_ASSET_SCOPE;
  if (scope.owner !== "project") return "owner";
  const ownedBy = scope.projectId ?? "";
  if (!ownedBy) return null;
  if (ctx.projectId && ownedBy === ctx.projectId) return "in-project";
  return findActiveAssetShare(ctx.shares, asset.kind, asset.id, ownedBy, ctx.projectId) ? "shared-in" : null;
}

/**
 * 可見性判定（唯一入口）。
 * 回 null 的每一條都是**硬邊界**，呼叫端不得再放行：
 * - 跨帳號：一律不可見（跨帳號是 RBAC 那一刀，不在本作用域層內）
 * - project-scoped 且非本項目、且沒有 from→to 的有效分享 → 不可見
 */
export function resolveAssetVisibility(asset: ScopedAssetLike, ctx: AssetUseContext): AssetVisibility | null {
  if (asset.ownerUserId !== ctx.viewerUserId) return null;
  return resolveAssetScopeVisibility(asset, ctx);
}

/** 可否在當前項目使用該資產（掛用前置檢查；不可見 = 不可用）。 */
export function canUseAsset(asset: ScopedAssetLike, ctx: AssetUseContext): boolean {
  return resolveAssetVisibility(asset, ctx) !== null;
}

/**
 * **讀取端作用域閘（客戶端）**：鎖定卡清單裡不可見的卡一律剔除（fail-closed）。
 *
 * 為何要這一層：`CanvasProject.cardIds` 是持久化欄位，寫入端閘（
 * `/api/canvas/projects` 的 filterCardIdsForProject）管不住**舊資料**與
 * **客戶端新增的鎖定**（角色卡面板可鎖任何一張自己名下的卡）；生成注入讀的
 * `activeCharacterCards` 若不過閘，就會出現「卡不屬於本項目卻被注入」的真泄漏。
 *
 * 客戶端沒有 owner 可比（卡清單已由按登入用戶隔離的 `/api/character-cards` 取得），
 * 故只過 scope 段——**與伺服器端同一把尺**（resolveAssetScopeVisibility），
 * 兩端不可能漂移。個人卡（含全部 legacy 卡）缺 scope → 恆可見＝零回歸（b 類）。
 */
export function filterLockedCardsForProjectUse<T extends { id: string; scope?: AssetScope }>(
  cards: readonly T[],
  ctx: { projectId: string | null; shares: readonly AssetShareRecord[] },
): T[] {
  if (!cards.length) return [];
  const useCtx: AssetUseContext = { viewerUserId: 0, projectId: ctx.projectId, shares: ctx.shares };
  return cards.filter(
    (card) => resolveAssetScopeVisibility({ id: card.id, kind: "card", scope: card.scope }, useCtx) !== null,
  );
}

/**
 * 把一次「副本變更」（掛用＝鎖定副本 / 解除＝解鎖副本）套進項目鎖定集（純函式）。
 * 這是 copy-on-use 生效的最後一哩：`localCopyId` 不進這個集合＝畫面標「已掛用」而生成不注入。
 * 規則：先移除 unlocked，再依序補進 locked（去重、保序：既有在前、新鎖定在後）。
 */
export function applyCopyLockChange(
  prev: readonly string[],
  change: { locked: readonly string[]; unlocked: readonly string[] },
): string[] {
  const drop = new Set(change.unlocked.map((id) => id.trim()).filter(Boolean));
  const next = prev.filter((id) => !drop.has(id));
  for (const raw of change.locked) {
    const id = raw.trim();
    if (id && !next.includes(id)) next.push(id);
  }
  return next;
}

/**
 * **使用/注入路徑的唯一包裝**：把一批資產按作用域裁決過一遍，回可用子集。
 * 不可見即不可用——生成注入 / agent 注入 / 鎖定卡注入都必須經過這裡（或等價的
 * asset-library.isAssetUsable），禁在呼叫端另立規則。
 * 方向可切換：跨項目語義（copy-on-use ↔ 引用＋解鏈閘）只改 resolveAssetVisibility。
 */
export function filterUsableAssets<T extends ScopedAssetLike>(assets: readonly T[], ctx: AssetUseContext): T[] {
  return assets.filter((asset) => resolveAssetVisibility(asset, ctx) !== null);
}

// ─────────────────────────────────────────── 掛用（項目資產庫成員）

/**
 * REQ-B2b：掛用＝**copy-on-use**（暴君 09-23 裁定）——掛用記錄是「來源 → 目標」的連接記錄，
 * 目標項目裡的**本地副本**由 `localCopyId` 指名（副本自足：來源刪除不影響副本）。
 * 本檔只做純推導；副本本體的落地在 asset-library.mountAssetWithCopy。
 */

// ── 副本鍵（確定性、無分隔符、段內單射語義）

/**
 * 副本鍵雜湊：4 條 32 位元 FNV-1a 車道（不同播種）拼成 32 位十六進位。
 * 為何不用 node:crypto：本檔前端也會載入（character-cards → 角色卡面板 → 畫布），
 * 且 tsconfig target=ES2017（BigInt 字面量不可用）；Math.imul 版可前後端同碼。
 * 128 位元在同帳號資產量級（≤數百）下碰撞機率可忽略，且**碰撞不得靜默**：
 * 建副本前會驗證同 id 卡是否真是這條來源的副本（asset-library 的
 * AssetMountCopyConflictError），不是就 409，不當成冪等重放。
 */
function fnv1aLane(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function copyKeyHash(input: string, namespace: string): string {
  const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  let out = "";
  for (const seed of seeds) {
    const lane = fnv1aLane(`${namespace}\u0000${input}`, seed);
    out += lane.toString(16).padStart(8, "0");
  }
  return out;
}

/**
 * 副本鍵的規範編碼：`{namespace}:{len}:{projectId}:{kind}:{len}:{sourceKey}`。
 * 段長度前綴＝單射（`("x:card:y")` 與 `("x","y")` 不撞），namespace 再切開
 * 「資產卡副本」與「包內條目副本」兩族——裸 `:` 拼接正是舊版撞鍵源。
 * **此字串只作雜湊輸入，永不落成資產 id**（落地的 id 是十六進位，不含分隔符）。
 */
function canonicalCopyKey(namespace: string, projectId: string, assetKind: AssetKind, sourceKey: string): string {
  return `${namespace}:${keySegment(projectId)}:${assetKind}:${keySegment(sourceKey)}`;
}

/** 副本 id 前綴（`copy-` 家族；`cp-` 短前綴給包內條目以免與卡 id 混形）。 */
const COPY_ID_PREFIX = "copy-";

/**
 * 資產副本的確定性 id（同 `(projectId, assetKind, sourceAssetId)` → 恆同一個 id）。
 * 性質：**不含分隔符**（純 `[a-z0-9-]`，可直接當資產卡 id）、長度固定 42 字元（卡 id 上限 100 內）、
 * 與 mount/share 鍵**不同形**（後兩者以 `share:` / `mount:` 開頭且含分隔符）。
 */
export function assetLocalCopyId(projectId: string, assetKind: AssetKind, sourceAssetId: string): string {
  const hash = copyKeyHash(canonicalCopyKey("copy", projectId, assetKind, sourceAssetId), "asset-copy");
  return `${COPY_ID_PREFIX}${assetKind}-${hash}`;
}

/** 包內條目的來源把手（只在雜湊輸入內用：`{len}:{packId}#{index}`——包 id 與序號共同定位條目）。 */
export function assetPackItemSourceKey(packId: string, itemIndex: number): string {
  return `${keySegment(packId)}#${itemIndex}`;
}

/**
 * 包內條目複製成卡時的確定性 id（同 `(projectId, packId, itemIndex)` → 恆同一張卡）。
 * 與 `assetLocalCopyId` 用**不同 namespace**，故「卡的副本」與「包條目的副本」不可能撞鍵。
 */
export function assetPackItemCopyId(projectId: string, packId: string, itemIndex: number): string {
  const hash = copyKeyHash(
    canonicalCopyKey("pack-item", projectId, "card", assetPackItemSourceKey(packId, itemIndex)),
    "asset-copy",
  );
  return `${COPY_ID_PREFIX}card-${hash}`;
}

/** 資產包本身的本地副本 id（副本單位＝卡，包副本只是讓目標項目有本地包記錄）。 */
export function assetPackLocalCopyId(projectId: string, packId: string): string {
  return assetLocalCopyId(projectId, "pack", packId);
}

/**
 * 這個 id 是不是 copy-on-use 落地的**內部副本**（`copy-card-<32hex>` / `copy-pack-<32hex>`）。
 *
 * 為什麼需要這個判據：副本與使用者資產同住一套 store，若不區分就會被當成可掛用條目列出，
 * 使用者（或 UI）再掛用一次＝在**同一個項目**裡生出「副本的副本」→ 卡片額度無限膨脹（D5）。
 * 判據用**家族前綴 + 固定長度十六進位**（不是「有 lineage 就算是副本」：使用者資產也可能有血統）。
 */
export function isAssetLocalCopyId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^copy-(card|pack)-[0-9a-f]{32}$/.test(value.trim());
}

/** 掛用記錄：資產收入某項目的資產庫（copy-on-use 下＝來源→目標副本的連接記錄）。 */
export interface AssetMountRecord {
  /** 確定性 id：`mount:{len(projectId)}:{projectId}:{kind}:{len(assetId)}:{assetId}`（同鍵重掛 = 同一件）。 */
  id: string;
  projectId: string;
  assetKind: AssetKind;
  assetId: string;
  /**
   * copy-on-use：本筆掛用在目標項目裡的**本地副本** id（由 `(projectId, kind, assetId)`
   * 確定性推導，純 `[a-z0-9-]`，不含分隔符）。同鍵重掛 → 同一個副本 id（冪等一份）。
   * 引用制（reference）下不落地副本，但此欄仍是同一推導值（切換方向不必改資料形狀）。
   */
  localCopyId: string;
  /**
   * 卡＝[localCopyId]；包＝逐 item 卡副本 id（D1：**掛用當下實際鎖過的卡副本清單**）。
   *
   * 為什麼要落盤而不是解除時再推導：推導的輸入（來源包當下條目 / 本地包副本當下存在）
   * 會事後改變，兩者不同源就會出現「解除了記錄裡的 id，實際鎖著的副本沒解到」——
   * 掛用→來源追加條目→掛用→解除、或掛用→刪掉本地包副本→解除，都會漏解（實測 D1）。
   * legacy 記錄（本欄之前落的）沒有這張清單 → 呼叫端回退既有推導（向後相容）。
   */
  cardCopyIds?: string[];
  /**
   * 冪等鏈鍵（確定性）：`asset-mount:{len(projectId)}:{projectId}:{kind}:{len(assetId)}:{assetId}`。
   * 形狀對齊既有 `{action}:{scope}:{target}` 慣例（master-ingest / billing projection），
   * 任何以它為鍵的計費或冪等記錄，重掛只會命中同一筆 → 不雙扣。
   */
  idempotencyRef: string;
  mountedAt: string;
}

/** 掛用記錄的確定性 id（段長度前綴 = 單射，禁裸 `:` 拼接）。 */
export function assetMountId(projectId: string, assetKind: AssetKind, assetId: string): string {
  return `mount:${keySegment(projectId)}:${assetKind}:${keySegment(assetId)}`;
}

/** 掛用的冪等鍵（與 id 分開命名：一個是記錄主鍵，一個是計費/冪等鏈的鍵）。 */
export function assetMountIdempotencyRef(projectId: string, assetKind: AssetKind, assetId: string): string {
  return `asset-mount:${keySegment(projectId)}:${assetKind}:${keySegment(assetId)}`;
}

/** 項目資產庫列表的「已掛用」鍵（kind + id 同一種編碼，禁與 id 拼接混用）。 */
export function mountedAssetKey(assetKind: AssetKind, assetId: string): string {
  return `${assetKind}:${keySegment(assetId)}`;
}

/** 卡副本清單的清洗收口（去重、保序、逐筆過 id 邊界；非法值丟棄而非截斷）。 */
function normalizeCopyIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (!isUsableAssetId(value)) continue;
    const id = value.trim();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** 清洗掛用記錄（存檔/讀檔唯一收口；id、idempotencyRef、localCopyId 一律重新推導）。 */
export function normalizeAssetMount(raw: unknown): AssetMountRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<AssetMountRecord>;
  const assetKind = toAssetKind(r.assetKind);
  const assetId = isUsableAssetId(r.assetId) ? r.assetId.trim() : "";
  const projectId = boundedSegment(r.projectId, MAX_PROJECT_ID_LENGTH);
  if (!assetKind || !assetId || !projectId) return null;
  const cardCopyIds = normalizeCopyIdList(r.cardCopyIds);
  return {
    id: assetMountId(projectId, assetKind, assetId),
    projectId,
    assetKind,
    assetId,
    localCopyId: assetLocalCopyId(projectId, assetKind, assetId),
    ...(cardCopyIds.length ? { cardCopyIds } : {}),
    idempotencyRef: assetMountIdempotencyRef(projectId, assetKind, assetId),
    mountedAt: typeof r.mountedAt === "string" ? r.mountedAt : new Date().toISOString(),
  };
}

/**
 * 冪等掛用（純函式）：
 * - 同 `(projectId, assetKind, assetId)` 已存在 → 原樣返回 created:false，**不新增第二筆**，
 *   且 `localCopyId` 逐位相同（同一個來源在同一個項目裡只有一份副本 = 冪等一份）。
 *   `cardCopyIds` 取**聯集**（掛用期間來源追加條目、重放補建了新副本 → 清單必須跟上，
 *   否則解除時解鎖不全 = D1「已解除但仍被注入」）；清單沒變 → `updated:false`（零副作用）。
 * - 同鍵但三元組不同 → **conflict:true**（真碰撞/別名，呼叫端必須回 409，禁靜默成功）。
 * 這是「跨項目復用不雙扣 / 不建第二份副本」在作用域層的落點。
 */
export function applyAssetMount(
  mounts: readonly AssetMountRecord[],
  input: { projectId: string; assetKind: AssetKind; assetId: string; now?: string; cardCopyIds?: readonly string[] },
): {
  mounts: AssetMountRecord[];
  mount: AssetMountRecord;
  created: boolean;
  conflict: boolean;
  /** 既有記錄的卡副本清單被這次呼叫擴充了（呼叫端據此決定要不要落盤）。 */
  updated: boolean;
} {
  const normalized = normalizeAssetMount({
    projectId: input.projectId,
    assetKind: input.assetKind,
    assetId: input.assetId,
    mountedAt: input.now ?? new Date().toISOString(),
    ...(input.cardCopyIds ? { cardCopyIds: [...input.cardCopyIds] } : {}),
  });
  if (!normalized) throw new Error("invalid asset mount");
  const existing = mounts.find((m) => m.id === normalized.id);
  if (!existing) {
    return { mounts: [...mounts, normalized], mount: normalized, created: true, conflict: false, updated: false };
  }
  if (!sameMountTriple(existing, normalized)) {
    return { mounts: [...mounts], mount: existing, created: false, conflict: true, updated: false };
  }
  const merged = normalizeCopyIdList([...(existing.cardCopyIds ?? []), ...(normalized.cardCopyIds ?? [])]);
  const updated = merged.length !== (existing.cardCopyIds?.length ?? 0);
  if (!updated) {
    // 同鍵重放：回**既有**那一筆（其 localCopyId 與推導值逐位相同 → 指向同一份副本）。
    return { mounts: [...mounts], mount: existing, created: false, conflict: false, updated: false };
  }
  const next: AssetMountRecord = { ...existing, cardCopyIds: merged };
  return {
    mounts: mounts.map((m) => (m.id === next.id ? next : m)),
    mount: next,
    created: false,
    conflict: false,
    updated: true,
  };
}

/** 掛用三元組逐欄等值。 */
function sameMountTriple(a: AssetMountRecord, b: AssetMountRecord): boolean {
  return a.projectId === b.projectId && a.assetKind === b.assetKind && a.assetId === b.assetId;
}

// ─────────────────────────────────────────── copy-on-use 的單一分歧點

/** 跨項目語義：copy-on-use（掛用即建本地副本）｜reference（引用制，不建副本）。 */
export type AssetMountCopyMode = "copy-on-use" | "reference";

/** 拒絕理由（呼叫端必須直說，不得靜默降級成「已掛用」）。 */
export type AssetMountCopyRejectReason =
  /** 推導出的副本 id 等於來源 id（會產生自引用邊）。 */
  | "self_reference"
  /** 來源的血統鏈成環（已含自己），或計畫建的副本已在來源的祖先鏈裡（副本會成為自己的祖先）。 */
  | "cyclic_lineage"
  /** 血統圖超出可完整遍歷的節點預算 → 無法證明無環（**超界 fail-closed**，不當成沒環）。 */
  | "unbounded_lineage";

/** 掛用計畫（copy-on-use 與引用制共用同一筆掛用記錄鍵；差別只在要不要落地副本）。 */
export interface AssetMountCopyPlan {
  mode: AssetMountCopyMode;
  /** copy-on-use＝要落地的卡/包副本 id；reference＝null（**唯一分歧點**在 planAssetMountCopy）。 */
  localCopyId: string | null;
  /** 目標項目已存在同一來源的副本 → 它的 id（冪等重放不建第二份）。 */
  existingCopyId: string | null;
  /** 需不需要真的建副本（引用制、或冪等重放且副本已在 → false）。 */
  shouldCreateCopy: boolean;
  mountId: string;
  idempotencyRef: string;
  projectId: string;
  assetKind: AssetKind;
  sourceAssetId: string;
}

/**
 * **掛用 copy-on-use 與引用制的唯一分歧點**（純函式、零 IO）：
 * 決定「這次掛用要不要建副本、副本 id 是什麼、是不是冪等重放、是不是環」。
 * 呼叫端（asset-library.mountAssetWithCopy）只照計畫執行，不另立規則。
 *
 * 環路守衛（遞歸掛用可回溯、環路必拒）：
 * 1. 副本 id === 來源 id → self_reference（會寫出自引用血統邊）；
 * 2. 來源的祖先鏈已含來源自己 → cyclic_lineage（既有資料成環，拒絕延伸）；
 * 3. 計畫建的副本已在來源的祖先鏈裡 → cyclic_lineage（副本會成為自己的祖先）。
 * 注意：**「把副本再掛回它來源所屬的項目」不是環**（每次掛用產生的是新節點，
 * 其血統邊指向來源鏈），故不在此拒絕——遞歸掛用是被允許且可回溯的。
 *
 * `established`（D4 裁定）：呼叫端**已**由 store 實測出「同鍵掛用記錄存在 + 該次副本已落地」
 * 時設 true → 跳過 2/3 兩條環路守衛。理由：既成事實不得被**事後**的血統編輯（例如把副本 id
 * 寫進來源自己的 lineage）打成 400；這條路徑是冪等重放，不是新的延伸。
 * 首次掛用一律 established=false，守衛一條不少。
 */
export function planAssetMountCopy(input: {
  projectId: string;
  assetKind: AssetKind;
  sourceAssetId: string;
  mode?: AssetMountCopyMode;
  /** 目標項目既有的副本 id 集（呼叫端由 store 讀；缺省＝空）。 */
  existingCopyIds?: readonly string[];
  /** 來源的血統祖先把手（呼叫端完整解析後填入；缺省＝無祖先）。 */
  ancestorAssetIds?: readonly string[];
  /** 已成立的冪等重放（見上）：跳過環路守衛，其餘語義不變。 */
  established?: boolean;
}): { ok: true; plan: AssetMountCopyPlan } | { ok: false; reason: AssetMountCopyRejectReason } {
  const mode = input.mode ?? "copy-on-use";
  const normalized = normalizeAssetMount({
    projectId: input.projectId,
    assetKind: input.assetKind,
    assetId: input.sourceAssetId,
  });
  if (!normalized) throw new Error("invalid asset mount");
  const localCopyId = normalized.localCopyId;
  if (localCopyId === normalized.assetId) return { ok: false, reason: "self_reference" };
  const ancestors = new Set<string>();
  for (const id of input.ancestorAssetIds ?? []) {
    if (typeof id === "string" && id) ancestors.add(id);
  }
  if (!input.established) {
    if (ancestors.has(normalized.assetId)) return { ok: false, reason: "cyclic_lineage" };
    if (ancestors.has(localCopyId)) return { ok: false, reason: "cyclic_lineage" };
  }
  const existingCopyId = input.existingCopyIds?.includes(localCopyId) ? localCopyId : null;
  const wantsCopy = mode === "copy-on-use";
  return {
    ok: true,
    plan: {
      mode,
      localCopyId: wantsCopy ? localCopyId : null,
      existingCopyId,
      shouldCreateCopy: wantsCopy && !existingCopyId,
      mountId: normalized.id,
      idempotencyRef: normalized.idempotencyRef,
      projectId: normalized.projectId,
      assetKind: normalized.assetKind,
      sourceAssetId: normalized.assetId,
    },
  };
}

/** 解除掛用（按確定性 id）。回是否真的移除了。 */
export function applyAssetUnmount(
  mounts: readonly AssetMountRecord[],
  mountId: string,
): { mounts: AssetMountRecord[]; removed: boolean } {
  const next = mounts.filter((m) => m.id !== mountId);
  return { mounts: next, removed: next.length !== mounts.length };
}

/** 某項目當前掛用的資產鍵集合（列表標記 mounted 用；鍵段與 id 同一種單射編碼）。 */
export function mountedAssetKeys(mounts: readonly AssetMountRecord[], projectId: string): Set<string> {
  const keys = new Set<string>();
  for (const m of mounts) {
    if (m.projectId !== projectId) continue;
    keys.add(mountedAssetKey(m.assetKind, m.assetId));
  }
  return keys;
}

// ─────────────────────────────────────────── 項目資產庫（列表 + 檢索 + 掛用入口）

export interface AssetLibraryCandidate {
  assetKind: AssetKind;
  assetId: string;
  title: string;
  tags: string[];
  /** 人看的種類標籤（資產包 / 角色 / 場景 / 風格）。 */
  kindLabel: string;
  scope?: AssetScope;
  ownerUserId: number;
  updatedAt: string;
}

export interface AssetLibraryItem extends AssetLibraryCandidate {
  visibility: AssetVisibility;
  /** 已在當前項目資產庫中掛用。 */
  mounted: boolean;
}

/** 資產包 → 候選項（結構型別，不 import 存儲層，避免循環）。 */
export function candidatesFromPacks(
  packs: readonly { id: string; title: string; digest?: string; tags?: string[]; scope?: AssetScope; updatedAt: string }[],
  ownerUserId: number,
): AssetLibraryCandidate[] {
  return packs.map((p) => ({
    assetKind: "pack" as const,
    assetId: p.id,
    title: p.title,
    tags: Array.isArray(p.tags) ? [...p.tags] : [],
    kindLabel: "资产包",
    ...(p.scope ? { scope: p.scope } : {}),
    ownerUserId,
    updatedAt: p.updatedAt,
  }));
}

const CARD_KIND_LABELS: Record<string, string> = { character: "角色", scene: "场景", style: "风格" };

/** 資產卡 → 候選項（標籤＝卡名稱 + 種類，卡的檢索面與包同構）。 */
export function candidatesFromCards(
  cards: readonly { id: string; name: string; kind: string; prompt?: string; scope?: AssetScope; updatedAt: string }[],
  ownerUserId: number,
): AssetLibraryCandidate[] {
  return cards.map((c) => ({
    assetKind: "card" as const,
    assetId: c.id,
    title: c.name,
    tags: [CARD_KIND_LABELS[c.kind] ?? c.kind],
    kindLabel: CARD_KIND_LABELS[c.kind] ?? "卡",
    ...(c.scope ? { scope: c.scope } : {}),
    ownerUserId,
    updatedAt: c.updatedAt,
  }));
}

/** 檢索：標題/標籤模糊命中（大小寫不敏感；空 query 全收）。 */
export function matchesAssetQuery(item: AssetLibraryCandidate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (item.title.toLowerCase().includes(q)) return true;
  if (item.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
  return false;
}

export interface AssetLibraryQuery {
  q?: string;
  /** 種類篩選：all（缺省）| pack | card。 */
  kind?: AssetKind | "all";
  /** 只看已掛用。 */
  mountedOnly?: boolean;
}

/**
 * 項目資產庫列表（唯一組裝口）：
 * 先過可見性（不可見即不列）→ 再過檢索/篩選 → updatedAt 由新到舊。
 * mounted 標記只看當前項目（別的項目的掛用不算）。
 *
 * **內部副本不列**（D5）：copy-on-use 落地的副本是掛用機制的一部分，不是使用者資產；
 * 列出來只會被再掛用一次，在**同一個項目**裡生出「副本的副本」→ 卡片額度無限膨脹。
 * 掛用關係的真相在掛用記錄（來源鍵），來源那筆照樣標「已掛用」，使用者不會因此看不到狀態。
 */
export function buildProjectAssetLibrary(input: {
  candidates: readonly AssetLibraryCandidate[];
  ctx: AssetUseContext;
  mounts: readonly AssetMountRecord[];
  query?: AssetLibraryQuery;
}): AssetLibraryItem[] {
  const { candidates, ctx, mounts } = input;
  const kind = input.query?.kind ?? "all";
  const q = input.query?.q ?? "";
  const mountedOnly = input.query?.mountedOnly === true;
  const keys = mountedAssetKeys(mounts, ctx.projectId ?? "");
  const items: AssetLibraryItem[] = [];
  for (const candidate of candidates) {
    if (isAssetLocalCopyId(candidate.assetId)) continue; // 內部副本不是可掛用條目
    const visibility = resolveAssetVisibility(
      { id: candidate.assetId, kind: candidate.assetKind, scope: candidate.scope, ownerUserId: candidate.ownerUserId },
      ctx,
    );
    if (!visibility) continue; // 不可見即不可用：不列進列表
    if (kind !== "all" && candidate.assetKind !== kind) continue;
    if (!matchesAssetQuery(candidate, q)) continue;
    const mounted = keys.has(mountedAssetKey(candidate.assetKind, candidate.assetId));
    if (mountedOnly && !mounted) continue;
    items.push({ ...candidate, visibility, mounted });
  }
  return items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/**
 * 掛用前置裁決：把候選項按可見性過一遍再決定能不能掛。
 * 回 null = 不可見/不可用（API 層必須回 403，不得靜默成功）；
 * **內部副本（copy-…）一律回 null**（D5：副本不可再掛用，見 buildProjectAssetLibrary 的說明）。
 */
export function resolveMountableAsset(
  candidates: readonly AssetLibraryCandidate[],
  ctx: AssetUseContext,
  target: { assetKind: AssetKind; assetId: string },
): { candidate: AssetLibraryCandidate; visibility: AssetVisibility } | null {
  if (isAssetLocalCopyId(target.assetId)) return null;
  const candidate = candidates.find((c) => c.assetKind === target.assetKind && c.assetId === target.assetId);
  if (!candidate) return null;
  const visibility = resolveAssetVisibility(
    { id: candidate.assetId, kind: candidate.assetKind, scope: candidate.scope, ownerUserId: candidate.ownerUserId },
    ctx,
  );
  return visibility ? { candidate, visibility } : null;
}
