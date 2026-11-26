import { ASSET_KEY_DELIMITER, DEFAULT_ASSET_SCOPE, MAX_ASSET_ID_LENGTH, MAX_ASSET_PROJECT_TAG_LENGTH, MAX_ASSET_PROJECT_TAGS, MAX_PROJECT_ID_LENGTH, MAX_TEAM_ID_LENGTH } from "./types";
import type { AssetKind, AssetScope, AssetShareRecord, ScopedAssetLike, ShareGrantRejectReason } from "./types";

/** 运行期判据：不可信 payload 的值域收敛（非 pack/card 一律 null）。 */
export function toAssetKind(value: unknown): AssetKind | null {
  return value === "pack" || value === "card" ? value : null;
}

/**
 * 收敛作用域栏位（存档与读档共用同一收口）：
 * - 非物件 / 非 "project" / 非 "team" → personal（含旧资料）
 * - owner==="project" 但 projectId 空 → **null**（鬼状态；呼叫端写回 GHOST_ASSET_SCOPE，
 *   不得降格成 personal —— 降格＝把「归属不明的项目资产」变成所有人都能用的个人资产，
 *   正是 D3 的 fail-open 病灶）
 * - owner==="team" 但 teamId 空 → **null**（同款鬼状态，fail-closed；**不**降格 personal）
 * - 每种 owner **只保留自己那一个 id 栏**：`{owner:"project", teamId}` / `{owner:"team", projectId}`
 *   的跨栏残留一律剥除（否则 scope 内两个座标并存，读取端就得多一层「听谁的」）。
 */
export function normalizeAssetScope(raw: unknown): AssetScope | null {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_ASSET_SCOPE };
  const r = raw as { owner?: unknown; projectId?: unknown; teamId?: unknown };
  if (r.owner === "team") {
    const teamId = typeof r.teamId === "string" ? r.teamId.trim().slice(0, MAX_TEAM_ID_LENGTH) : "";
    return teamId ? { owner: "team", teamId } : null;
  }
  if (r.owner !== "project") return { ...DEFAULT_ASSET_SCOPE };
  const projectId = typeof r.projectId === "string" ? r.projectId.trim().slice(0, MAX_PROJECT_ID_LENGTH) : "";
  return projectId ? { owner: "project", projectId } : null;
}

/** 两份作用域是否等值（挂用/分享去重与测试断言用）；owner 不同即不等值。 */
export function sameAssetScope(a: AssetScope, b: AssetScope): boolean {
  return (
    a.owner === b.owner &&
    (a.projectId ?? "") === (b.projectId ?? "") &&
    (a.teamId ?? "") === (b.teamId ?? "")
  );
}

/** 取作用域上的团队座标（只认 owner==="team"；其余回 ""，与「缺省＝personal」同精神）。 */
export function teamIdOfScope(scope: AssetScope | undefined): string {
  return scope && scope.owner === "team" ? (scope.teamId ?? "") : "";
}

/**
 * 收敛项目标签（`projectIds`）：去重、只留非空 string、逐项 `trim()` 后 `slice(0,120)`、
 * 最多 `MAX_ASSET_PROJECT_TAGS` 个；非阵列 / 非法输入 → **[]**（不抛、不猜；
 * 与 normalizeAssetScope 同精神：读不懂就是不设标签）。
 *
 * 与旧 `scope.projectId` **并存但语义不同**（P1-A 纯加法）：`scope` 是**单一**归属（legacy），
 * `projectIds` 是**多归属标签**（新）。本函式只清洗标签，一行不碰 scope。
 */
export function normalizeProjectIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const tag = value.trim().slice(0, MAX_ASSET_PROJECT_TAG_LENGTH);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_ASSET_PROJECT_TAGS) break;
  }
  return out;
}

/**
 * **写入路由入口的 fail-loud 闸**（修复 3，2026-10-09）：当本次请求**显式送来**的
 * `projectIds` 在清洗去重后仍超过 {@link MAX_ASSET_PROJECT_TAGS} 时**必须拒收**
 * （400 `too_many_project_tags`），不得像 {@link normalizeProjectIds} 那样静默 `slice` 截断
 * ——截断会让排在末位的真实项目静默失去归属（静默丢数据：Hacker 实证 21 个互异标签时
 * 第 21 个被丢）。
 *
 * **判据＝「落盘会被裁掉才拒」**（2026-10-09 收窄，原按去重前原始长度判过严）：
 * 逐项照 {@link normalizeProjectIds} 的清洗规则（只认非空 string、`trim()` 后
 * `slice(0,120)`、以清洗结果为键去重）累计**有效标签数**，去重后 > 上限才拒。
 * 因此 `["a","a",…×21]`（去重后仅 1 个）放行——落盘不会被裁，拒绝它属于误判；
 * 21 个互异（或清洗后仍互异）才拒。
 *
 * 非数组（含未给该栏位）→ false：未给＝不动，交给既有「缺键不动」语义，不在此拒；
 * 非字符串项被忽略（`normalizeProjectIds` 同样丢弃它们，不影响落盘结果）。
 */
export function projectTagIdsOverLimit(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const tag = value.trim().slice(0, MAX_ASSET_PROJECT_TAG_LENGTH);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    if (seen.size > MAX_ASSET_PROJECT_TAGS) return true;
  }
  return false;
}

/**
 * 只看「打了某个项目标签」的资产（**与可见性无关，纯标签筛选**）：
 * 供前端在资产总览按创作项目筛选（`projectIds.includes(projectId)`）。
 * - `projectId` 为空 / 空白 → **原样回传**（同一阵列参考；不加筛选＝零行为漂移）。
 * - 标签是弱约束：没有 `projectIds` 的资产一律不命中（不猜归属）。
 */
export function filterByProjectTag<T extends { projectIds?: string[] }>(
  items: T[],
  projectId: string | null | undefined,
): T[] {
  const target = typeof projectId === "string" ? projectId.trim() : "";
  if (!target) return items;
  return items.filter((item) => item.projectIds?.includes(target));
}

/**
 * 资产 id 的字元/长度边界（**存档收口与确定性键共用**）：
 * 非字串 / 空 / 超长 / 含保留分隔符 `:` / 含控制字元 → false。
 * 呼叫端不得自行 trim 后放行（否则「长度前缀」就不是唯一真源）。
 */
export function isUsableAssetId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const clean = value.trim();
  if (!clean || clean.length > MAX_ASSET_ID_LENGTH) return false;
  if (clean.includes(ASSET_KEY_DELIMITER)) return false;
  // 控制字元（含 \n \t \0）在日志/键里都可被用来伪造段边界。
  for (const ch of clean) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** 键段单射化：长度前缀 `{len}:{value}`——(`"x:card:y"`, `""`) 与 (`"x"`, `"y"`) 不再撞键。 */
export function keySegment(value: string): string {
  return `${value.length}:${value}`;
}

/** 分享记录的确定性 id（分享幂等的唯一键）。 */
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
 * 非字串 / 空 → ""；**超长一律拒绝（回 ""）而非截断**——截断会让两个不同值落成同一段
 * （＝另一种撞键），fail-closed。
 */
export function boundedSegment(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const clean = value.trim();
  return clean && clean.length <= max ? clean : "";
}

/**
 * 清洗分享记录（存档/读档唯一收口）。
 * id 由三元组**重新推导**（不接受外部传入的 id：确定性键不许被呼叫端改写）。
 * 三元组任一缺损 → null（呼叫端丢弃）。
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

/** 撤销后不再可见（记录留痕，不删）。 */
export function isAssetShareActive(share: AssetShareRecord): boolean {
  return !share.revokedAt;
}

/** 命中「把 fromProjectId 的某资产显式分享给 toProjectId」的有效授权。 */
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

/** 只有「资产拥有者」能把「属于 fromProjectId 的项目资产」显式分享给另一个项目。 */
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
 * 幂等授权（纯函式）：
 * - 同键已生效 → 原样返回 created:false（**不新增第二笔**，计费/额度链不双扣）
 * - 同键存在但已撤销 → 复活（移除 revokedAt），created:false（仍是同一件）
 * - 同键但三元组不同 → **conflict:true**（真碰撞/别名，呼叫端必须回冲突，禁静默成功）
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
  // 同键不同三元组 = 键碰撞（不可能来自正常呼叫；来自旧键/外部伪造时不许冒充幂等重放）。
  if (!sameShareTriple(existing, normalized)) {
    return { shares: [...shares], share: existing, created: false, conflict: true };
  }
  if (isAssetShareActive(existing)) return { shares: [...shares], share: existing, created: false, conflict: false };
  // 复活：逐栏重建（不用展开运算子，否则 revokedAt 会被一起带回来＝撤销失效）。
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

/** 分享三元组逐栏等值（不用 JSON.stringify：栏位序不是契约）。 */
function sameShareTriple(a: AssetShareRecord, b: AssetShareRecord): boolean {
  return (
    a.assetKind === b.assetKind &&
    a.assetId === b.assetId &&
    a.fromProjectId === b.fromProjectId &&
    a.toProjectId === b.toProjectId
  );
}

/** 撤销授权（按确定性 id）。回是否真的撤销了（已撤销/不存在回 false）。 */
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
