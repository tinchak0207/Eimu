// REQ-B2 团队资产空间：作用域层（纯逻辑，无 IO）。
//
// 定位：把**现成**资产包（asset-pack-store）＋资产卡（character-cards）挂到
// project-scoped library —— 本档只加「归属 / 可见性 / 复用」三件事，
// **不另造资产格式**：scope 只是既有记录上的一个可选栏位（见 asset-pack-store
// 与 character-cards 的清洗收口），资产实体仍是原本那两套表示。
//
// 三铁律：
//   1. **不可见即不可用**：任何跨项目使用都先过 resolveAssetVisibility，
//      回 null = 不列进列表、挂用直接拒绝（禁默认全网可见）。
//   2. **跨项目复用需显式分享**：唯一入口是 AssetShareRecord（grant / revoke 显式动作），
//      没有「同帐号自动可见」「同组织自动可见」这类隐含规则。
//   3. **幂等链复用既有件**：mount / share 的 id 与 idempotencyRef 都是**确定性键**
//      （`{action}:{scope}:{target}` 同形，对齐 generation-core 既有 key 惯例，
//      例：master-ingest `film_export:{sessionId}:{fingerprint}`）——
//      重复挂用 / 重复分享只命中同一件，不产生第二笔（计费幂等不双扣的地基）。
//      **键段一律长度前缀单射化**（`{len}:{value}`）：裸 `:` 拼接会让
//      `pack:"x:card:y"` 与 `projectId:"x", card:"y"` 产出同一个键（实测撞键），
//      撞键 = 授权跨资产别名 + 静默成功谎言，故键段必须单射；同时在资产 id 的
//      验证边界（isUsableAssetId）拒绝含保留分隔符的 id。
//   4. **碰撞不得静默成功**：同键但三元组不同 = 真碰撞（别名），一律回
//      conflict（API 层 409），不得当成幂等重放回 `success:true`。
//
// metadata 纪律（裁决，同 D1 lineage 先例）：scope 只给人看（项目资产库面板），
// **不进 canvas 节点 metadata、不进 toNodeMetadata、不进 compactMetadataForAgent**；
// 反之，资产库列表本身也不经双白名单（它不落地成 canvas 节点）。
//
// 已知边界（本刀刻意不吞，写明不装懂）：
//   1. 挂用（AssetMountRecord）＝「收入项目资产库」的成员关系；生成时的卡片注入走
//      既有 `CanvasProject.cardIds` 锁定机制。**两条都查作用域**：注入端走
//      `resolveAssetVisibility`（storyboard-contract 的 scope 选项），锁定端走
//      `/api/canvas/projects` 的 cardIds 闸（都是同一裁决函式的包装）。
//   2. 跨项目挂用语义＝**copy-on-use**（项目负责人 2026-09-23 裁定）：挂用＝在目标项目建
//      本地副本 + lineage 指向来源（副本**运行时自足**：来源/来源项目日后删除不影响副本；
//      lineage 边**可以**指向别的 project 的来源实体——它只是审计痕迹，不是运行依赖）。
//      本档的 mount 记录仍是「来源→目标」的连接记录，副本身份＝ `localCopyId`
//      （确定性推导），副本本体由 asset-library.mountAssetWithCopy 落地。
//   3. 内部副本（copy-on-use 落地的本地副本）**不是可挂用条目**：不列进资产库候选、
//      挂用闸直接拒（见 isAssetLocalCopyId）——否则「副本的副本」会让卡片无限膨胀（D5）。
//
// **方向可切换**：作用域裁决走单一入口 `resolveAssetVisibility`（包装＝
// `filterUsableAssets` / asset-library 的 `isAssetUsable` / `resolveMountableAsset`）；
// copy-on-use ↔ 引用制的唯一分歧点是 `planAssetMountCopy`。若日后改回「引用＋解链闸」，
// 只需改这两个函式（＋门禁呼叫端），不必动各使用路径。

// ─────────────────────────────────────────── 资产种类（既有两套表示的键）

/** 资产种类＝既有两种表示：pack（资产包）/ card（角色·场景·风格卡）。 */
export type AssetKind = "pack" | "card";

/** 运行期判据：不可信 payload 的值域收敛（非 pack/card 一律 null）。 */
export function toAssetKind(value: unknown): AssetKind | null {
  return value === "pack" || value === "card" ? value : null;
}

// ─────────────────────────────────────────── 归属（个人 / 项目 / 团队）

export type AssetOwnership = "personal" | "project" | "team";

/**
 * 资产归属：personal＝个人资产（本帐号所有项目可用）；
 * project＝属于某个项目；team＝属于某个团队（P0-2 资产团队维度：跟组织走，切队严格隔离）。
 *
 * **LEGACY 并存（P1-A，2026-10-09）**：单归属 scope 与挂用/分享机制**保留但不再扩张**——
 * 新归属能力走 `projectIds` 标签（多归属、纯加法）。本栏位语义一行不动，旧记录只读兼容。
 *
 * **维度只到此为止**：本刀只加归属维度与可见性，RBAC／配额／席位由后续刀接手
 *（见 asset-scope-store 的 MAX_*_PER_USER，仍是 per-user 而非 per-team）。
 */
export interface AssetScope {
  owner: AssetOwnership;
  /** 仅 owner==="project" 有意义（其余恒省略，不写 `projectId: ""` 冒充）。 */
  projectId?: string;
  /**
   * 仅 owner==="team" 有意义（其余恒省略，不写 `teamId: ""` 冒充）。
   * 写入端以 **relay 权威值**盖章（见 /api/assets 的 PUT），不采信客户端送来的值。
   */
  teamId?: string;
}

/** 缺省＝personal，向后相容既有资产（本刀之前存的包/卡都没有 scope 栏）。 */
export const DEFAULT_ASSET_SCOPE: AssetScope = { owner: "personal" };

/**
 * **鬼状态**的持久化形状：`owner:"project"` 而**无** projectId。
 *
 * 语义（与 resolveAssetScopeVisibility 的「鬼状态 → null」宣称对齐，见 D3）：
 * 宣称属于某个项目却说不出是哪个项目 → **任何**上下文都不可见/不可用（fail-closed），
 * 既不降格成人人可用的 personal，也不猜是哪个项目。
 * 代理人（character-cards / asset-pack-store）收到 normalizeAssetScope 回 null 时写回此形状，
 * 使「存档 → 读档」两端都不会漂移成 personal。
 *
 * **团队同理**（P0-2 对称）：`owner:"team"` 而无 teamId 也是鬼状态 → 回 null、写回本形状
 *（本常数是「project 无 projectId」的形状；team 鬼状态若也无 projectId，落盘形状与它逐字相同）。
 */
export const GHOST_ASSET_SCOPE: AssetScope = { owner: "project" };

/**
 * 团队鬼状态的持久化形状：`owner:"team"` 而**无** teamId（正常收口不会产生——
 * 写入端遇 relay 查不到成员身份时**降级 personal**，此形状只可能来自外部伪造或旧资料）。
 */
export const GHOST_TEAM_ASSET_SCOPE: AssetScope = { owner: "team" };

const MAX_PROJECT_ID_LENGTH = 120;
const MAX_TEAM_ID_LENGTH = 120;

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

// ─────────────────────────────────────────── 项目标签（P1-A：资产用标签不用分类）

/**
 * 单笔资产可挂的项目标签数上限（P1-A：`projectIds` 是用户自己的「多归属标签」）。
 * **写入路由入口已 fail-loud 拒收超限投入**（见 {@link projectTagIdsOverLimit}，400
 * `too_many_project_tags`）；此处 `normalizeProjectIds` 的截断保留为**纵深防御**
 * （读档收口 / 绕过路由的呼叫端仍不会写出超限记录）。
 */
export const MAX_ASSET_PROJECT_TAGS = 20;
const MAX_ASSET_PROJECT_TAG_LENGTH = 120;

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

// ─────────────────────────────────────────── 显式分享（跨项目授权）

/**
 * 显式分享授权：把 fromProjectId 名下的一个资产授权给 toProjectId 可见可用。
 *
 * **LEGACY 并存（P1-A）**：本机制保留、语义一行不动；P1-A 起不再新增分享记录，
 * 新归属走 `projectIds` 标签（多归属、天然免分享）。
 */
export interface AssetShareRecord {
  /**
   * 确定性 id（不随机）：`share:{kind}:{len(assetId)}:{assetId}:{len(from)}:{from}:{len(to)}:{to}`。
   * 段长度前缀＝单射（含分隔符的 id 已由 isUsableAssetId 在边界拒绝）。
   * 同一次分享重放 = 同一个 id → 幂等，不产生第二笔授权。
   */
  id: string;
  assetKind: AssetKind;
  assetId: string;
  /** 资产所属项目（分享的来源）。 */
  fromProjectId: string;
  /** 被显式授权的目标项目。 */
  toProjectId: string;
  createdAt: string;
  /** 撤销时间；有值＝已撤销（撤销后不再可见，但记录留痕）。 */
  revokedAt?: string;
}

/** 资产 id 长度上限（share / mount / pack 三处同一个界，避免「可建不可分享」）。 */
export const MAX_ASSET_ID_LENGTH = 200;

/**
 * 确定性键的保留段分隔符。资产 id 含它 = 旧版裸拼接键会与别的 (kind, id) 组合撞键，
 * 故在资产 id 的验证边界（isUsableAssetId）直接拒绝，不只靠键端单射化兜底。
 */
export const ASSET_KEY_DELIMITER = ":";

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
function keySegment(value: string): string {
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
function boundedSegment(value: unknown, max: number): string {
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

/** 分享动作的裁决结果（拒绝理由要能直说，不吞）。 */
export type ShareGrantRejectReason =
  | "cross_user"
  | "not_a_project_asset"
  | "project_mismatch"
  | "missing_target_project"
  | "same_project";

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

// ─────────────────────────────────────────── 可见性（不可见即不可用）

/** 资产记录的最小白名单视图（pack / card 两套表示都映射到这里）。 */
export interface ScopedAssetLike {
  id: string;
  kind: AssetKind;
  /** 资产记录上的作用域；缺省＝personal（旧资产零改动）。 */
  scope?: AssetScope;
  /**
   * P1-A 项目标签（多归属，纯加法）：与 `scope` 并存；空/缺省＝没有标签。
   * 命中当前项目时给 `in-project` 可见性（见 resolveAssetScopeVisibility 的新允许路径）。
   */
  projectIds?: string[];
  /** 资产拥有者（= 存储桶 userId）。 */
  ownerUserId: number;
}

/**
 * 可见性判定结果：owner＝个人资产；in-project＝本项目资产；
 * in-team＝本团队资产（P0-2：team-scoped 且属当前团队）；shared-in＝显式分享进来。
 */
export type AssetVisibility = "owner" | "in-project" | "in-team" | "shared-in";

export interface AssetUseContext {
  viewerUserId: number;
  /** 当前项目 id；无项目上下文（如全域资产页）为 null —— 此时只有 personal 资产可见。 */
  projectId: string | null;
  /**
   * 当前画布所属的**创作项目 id**（`prj_…`）。与 `projectId`（画布 id `canvas-…`）
   * 是两套命名空间，各自独立传入、**不得互相冒充**。缺省/null＝无此上下文（标签路径不生效）。
   * 用途：项目标签（`asset.projectIds`）按**创作项目 id** 命中——面板打的就是它。
   */
  creativeProjectId?: string | null;
  /**
   * 当前团队 id（P0-2 资产团队维度）。**必须由呼叫端以 relay 权威值注入**
   *（`lookupTeamMembershipViaRelay` 回传的 teamId），**不得采信客户端送来的值**；
   * 查不到成员身份／未配置 → 省略此栏（＝无团队上下文）→ team 资产一律不可见（fail-closed）。
   */
  teamId?: string | null;
  shares: readonly AssetShareRecord[];
}

/**
 * **作用域段的唯一裁决**（不含 owner 验证，裁决顺序与本档既有版逐条同序）：
 * - personal（缺省）→ owner（跨项目恒可用）
 * - project-scoped 且属于当前项目 → in-project
 * - team-scoped 且属于当前团队 → in-team（P0-2；ctx.teamId 由 relay 权威值注入）
 * - project-scoped 但有 from→to 有效分享 → shared-in
 * - 其余（含「owner=project 但 projectId 空」与「owner=team 但 teamId 空」两种鬼状态）→ null
 *
 * 为何抽出这一层：伺服器端（resolveAssetVisibility）与**客户端读取闸**
 * （use-canvas-cards 的锁定卡清单；客户端的卡已由按登入用户隔离的
 * `/api/character-cards` 取得，故无 owner 可比）必须是同一把尺——
 * 两处各写一份 scope 分支＝写入端放行、读取端丢卡的「画面说挂用、生成不注入」病灶。
 *
 * **team 段为什么 fail-closed**：team 座标来自 relay（可为 null）与外部载荷——
 * 查不到成员身份（ctx.teamId 缺／空）时 team 资产一律不可见，不降格成「人人可见的 personal」，
 * 也不猜「大概是哪个团队」。与既有 project 鬼状态同一把尺。
 */
export function resolveAssetScopeVisibility(
  asset: { id: string; kind: AssetKind; scope?: AssetScope; projectIds?: string[] },
  ctx: AssetUseContext,
): AssetVisibility | null {
  const scope = asset.scope ?? DEFAULT_ASSET_SCOPE;
  if (scope.owner === "team") {
    const ownedByTeam = scope.teamId ?? "";
    if (!ownedByTeam) return null;
    const viewerTeam = typeof ctx.teamId === "string" ? ctx.teamId.trim() : "";
    if (!viewerTeam) return null;
    return viewerTeam === ownedByTeam ? "in-team" : null;
  }
  if (scope.owner !== "project") return "owner";
  const ownedBy = scope.projectId ?? "";
  if (!ownedBy) return null;
  if (ctx.projectId && ownedBy === ctx.projectId) return "in-project";
  // P1-A 新允许路径（纯加法）：项目标签（多归属）。**插在旧精确匹配之后、share 查表之前**。
  // `ctx.projectId` 为空时**不生效**——标签不得因此把 fail-closed 打开（无项目上下文仍只有 personal 可见）。
  if (ctx.projectId && asset.projectIds?.includes(ctx.projectId)) return "in-project";
  // 画布 id → 创作项目 id 打通（2026-10-09 前置改造）：面板打的标签是**创作项目 id（`prj_…`）**，
  // 而画布生成闸的 `ctx.projectId` 是**画布 id（`canvas-…`）**——两者命名空间不同，上面那条恒不命中。
  // 独立新增一条按 `creativeProjectId` 命中的路径；**保留**上面的画布 id 路径（旧数据/旧标签仍可能用画布 id）。
  // 只按标签数组命中：个人卡与跨项目未打标签的卡不在 `projectIds` 里，故不因此进注入。
  if (ctx.creativeProjectId && asset.projectIds?.includes(ctx.creativeProjectId)) return "in-project";
  return findActiveAssetShare(ctx.shares, asset.kind, asset.id, ownedBy, ctx.projectId) ? "shared-in" : null;
}

/**
 * 可见性判定（唯一入口）。
 * 回 null 的每一条都是**硬边界**，呼叫端不得再放行：
 * - 跨帐号：一律不可见（跨帐号是 RBAC 那一刀，不在本作用域层内）
 * - project-scoped 且非本项目、且没有 from→to 的有效分享 → 不可见
 */
export function resolveAssetVisibility(asset: ScopedAssetLike, ctx: AssetUseContext): AssetVisibility | null {
  if (asset.ownerUserId !== ctx.viewerUserId) return null;
  return resolveAssetScopeVisibility(asset, ctx);
}

/** 可否在当前项目使用该资产（挂用前置检查；不可见 = 不可用）。 */
export function canUseAsset(asset: ScopedAssetLike, ctx: AssetUseContext): boolean {
  return resolveAssetVisibility(asset, ctx) !== null;
}

/**
 * **读取端作用域闸（客户端）**：锁定卡清单里不可见的卡一律剔除（fail-closed）。
 *
 * 为何要这一层：`CanvasProject.cardIds` 是持久化栏位，写入端闸（
 * `/api/canvas/projects` 的 filterCardIdsForProject）管不住**旧资料**与
 * **客户端新增的锁定**（角色卡面板可锁任何一张自己名下的卡）；生成注入读的
 * `activeCharacterCards` 若不过闸，就会出现「卡不属于本项目却被注入」的真泄漏。
 *
 * 客户端没有 owner 可比（卡清单已由按登入用户隔离的 `/api/character-cards` 取得），
 * 故只过 scope 段——**与伺服器端同一把尺**（resolveAssetScopeVisibility），
 * 两端不可能漂移。个人卡（含全部 legacy 卡）缺 scope → 恒可见＝零回归（b 类）。
 */
export function filterLockedCardsForProjectUse<T extends { id: string; scope?: AssetScope; projectIds?: string[] }>(
  cards: readonly T[],
  ctx: { projectId: string | null; creativeProjectId?: string | null; shares: readonly AssetShareRecord[] },
): T[] {
  if (!cards.length) return [];
  const useCtx: AssetUseContext = {
    viewerUserId: 0,
    projectId: ctx.projectId,
    ...(ctx.creativeProjectId ? { creativeProjectId: ctx.creativeProjectId } : {}),
    shares: ctx.shares,
  };
  return cards.filter(
    (card) =>
      resolveAssetScopeVisibility(
        { id: card.id, kind: "card", scope: card.scope, projectIds: card.projectIds },
        useCtx,
      ) !== null,
  );
}

/**
 * 把一次「副本变更」（挂用＝锁定副本 / 解除＝解锁副本）套进项目锁定集（纯函式）。
 * 这是 copy-on-use 生效的最后一哩：`localCopyId` 不进这个集合＝画面标「已挂用」而生成不注入。
 * 规则：先移除 unlocked，再依序补进 locked（去重、保序：既有在前、新锁定在后）。
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
 * **使用/注入路径的唯一包装**：把一批资产按作用域裁决过一遍，回可用子集。
 * 不可见即不可用——生成注入 / agent 注入 / 锁定卡注入都必须经过这里（或等价的
 * asset-library.isAssetUsable），禁在呼叫端另立规则。
 * 方向可切换：跨项目语义（copy-on-use ↔ 引用＋解链闸）只改 resolveAssetVisibility。
 */
export function filterUsableAssets<T extends ScopedAssetLike>(assets: readonly T[], ctx: AssetUseContext): T[] {
  return assets.filter((asset) => resolveAssetVisibility(asset, ctx) !== null);
}

// ─────────────────────────────────────────── 挂用（项目资产库成员）

/**
 * REQ-B2b：挂用＝**copy-on-use**（项目负责人 09-23 裁定）——挂用记录是「来源 → 目标」的连接记录，
 * 目标项目里的**本地副本**由 `localCopyId` 指名（副本自足：来源删除不影响副本）。
 * 本档只做纯推导；副本本体的落地在 asset-library.mountAssetWithCopy。
 */

// ── 副本键（确定性、无分隔符、段内单射语义）

/**
 * 副本键杂凑：4 条 32 位元 FNV-1a 车道（不同播种）拼成 32 位十六进位。
 * 为何不用 node:crypto：本档前端也会载入（character-cards → 角色卡面板 → 画布），
 * 且 tsconfig target=ES2017（BigInt 字面量不可用）；Math.imul 版可前后端同码。
 * 128 位元在同帐号资产量级（≤数百）下碰撞机率可忽略，且**碰撞不得静默**：
 * 建副本前会验证同 id 卡是否真是这条来源的副本（asset-library 的
 * AssetMountCopyConflictError），不是就 409，不当成幂等重放。
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
 * 副本键的规范编码：`{namespace}:{len}:{projectId}:{kind}:{len}:{sourceKey}`。
 * 段长度前缀＝单射（`("x:card:y")` 与 `("x","y")` 不撞），namespace 再切开
 * 「资产卡副本」与「包内条目副本」两族——裸 `:` 拼接正是旧版撞键源。
 * **此字串只作杂凑输入，永不落成资产 id**（落地的 id 是十六进位，不含分隔符）。
 */
function canonicalCopyKey(namespace: string, projectId: string, assetKind: AssetKind, sourceKey: string): string {
  return `${namespace}:${keySegment(projectId)}:${assetKind}:${keySegment(sourceKey)}`;
}

/** 副本 id 前缀（`copy-` 家族；`cp-` 短前缀给包内条目以免与卡 id 混形）。 */
const COPY_ID_PREFIX = "copy-";

/**
 * 资产副本的确定性 id（同 `(projectId, assetKind, sourceAssetId)` → 恒同一个 id）。
 * 性质：**不含分隔符**（纯 `[a-z0-9-]`，可直接当资产卡 id）、长度固定 42 字元（卡 id 上限 100 内）、
 * 与 mount/share 键**不同形**（后两者以 `share:` / `mount:` 开头且含分隔符）。
 */
export function assetLocalCopyId(projectId: string, assetKind: AssetKind, sourceAssetId: string): string {
  const hash = copyKeyHash(canonicalCopyKey("copy", projectId, assetKind, sourceAssetId), "asset-copy");
  return `${COPY_ID_PREFIX}${assetKind}-${hash}`;
}

/** 包内条目的来源把手（只在杂凑输入内用：`{len}:{packId}#{index}`——包 id 与序号共同定位条目）。 */
export function assetPackItemSourceKey(packId: string, itemIndex: number): string {
  return `${keySegment(packId)}#${itemIndex}`;
}

/**
 * 包内条目复制成卡时的确定性 id（同 `(projectId, packId, itemIndex)` → 恒同一张卡）。
 * 与 `assetLocalCopyId` 用**不同 namespace**，故「卡的副本」与「包条目的副本」不可能撞键。
 */
export function assetPackItemCopyId(projectId: string, packId: string, itemIndex: number): string {
  const hash = copyKeyHash(
    canonicalCopyKey("pack-item", projectId, "card", assetPackItemSourceKey(packId, itemIndex)),
    "asset-copy",
  );
  return `${COPY_ID_PREFIX}card-${hash}`;
}

/** 资产包本身的本地副本 id（副本单位＝卡，包副本只是让目标项目有本地包记录）。 */
export function assetPackLocalCopyId(projectId: string, packId: string): string {
  return assetLocalCopyId(projectId, "pack", packId);
}

/**
 * 这个 id 是不是 copy-on-use 落地的**内部副本**（`copy-card-<32hex>` / `copy-pack-<32hex>`）。
 *
 * 为什么需要这个判据：副本与使用者资产同住一套 store，若不区分就会被当成可挂用条目列出，
 * 使用者（或 UI）再挂用一次＝在**同一个项目**里生出「副本的副本」→ 卡片额度无限膨胀（D5）。
 * 判据用**家族前缀 + 固定长度十六进位**（不是「有 lineage 就算是副本」：使用者资产也可能有血统）。
 */
export function isAssetLocalCopyId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^copy-(card|pack)-[0-9a-f]{32}$/.test(value.trim());
}

/** 挂用记录：资产收入某项目的资产库（copy-on-use 下＝来源→目标副本的连接记录）。
 *
 * **LEGACY 并存（P1-A）**：copy-on-use 挂用机制保留、语义一行不动；P1-A 起不再新增挂用记录，
 * 新归属走 `projectIds` 标签（多归属、免副本）。旧记录只读兼容。
 */
export interface AssetMountRecord {
  /** 确定性 id：`mount:{len(projectId)}:{projectId}:{kind}:{len(assetId)}:{assetId}`（同键重挂 = 同一件）。 */
  id: string;
  projectId: string;
  assetKind: AssetKind;
  assetId: string;
  /**
   * copy-on-use：本笔挂用在目标项目里的**本地副本** id（由 `(projectId, kind, assetId)`
   * 确定性推导，纯 `[a-z0-9-]`，不含分隔符）。同键重挂 → 同一个副本 id（幂等一份）。
   * 引用制（reference）下不落地副本，但此栏仍是同一推导值（切换方向不必改资料形状）。
   */
  localCopyId: string;
  /**
   * 卡＝[localCopyId]；包＝逐 item 卡副本 id（D1：**挂用当下实际锁过的卡副本清单**）。
   *
   * 为什么要落盘而不是解除时再推导：推导的输入（来源包当下条目 / 本地包副本当下存在）
   * 会事后改变，两者不同源就会出现「解除了记录里的 id，实际锁著的副本没解到」——
   * 挂用→来源追加条目→挂用→解除、或挂用→删掉本地包副本→解除，都会漏解（实测 D1）。
   * legacy 记录（本栏之前落的）没有这张清单 → 呼叫端回退既有推导（向后相容）。
   */
  cardCopyIds?: string[];
  /**
   * 幂等链键（确定性）：`asset-mount:{len(projectId)}:{projectId}:{kind}:{len(assetId)}:{assetId}`。
   * 形状对齐既有 `{action}:{scope}:{target}` 惯例（master-ingest / billing projection），
   * 任何以它为键的计费或幂等记录，重挂只会命中同一笔 → 不双扣。
   */
  idempotencyRef: string;
  mountedAt: string;
}

/** 挂用记录的确定性 id（段长度前缀 = 单射，禁裸 `:` 拼接）。 */
export function assetMountId(projectId: string, assetKind: AssetKind, assetId: string): string {
  return `mount:${keySegment(projectId)}:${assetKind}:${keySegment(assetId)}`;
}

/** 挂用的幂等键（与 id 分开命名：一个是记录主键，一个是计费/幂等链的键）。 */
export function assetMountIdempotencyRef(projectId: string, assetKind: AssetKind, assetId: string): string {
  return `asset-mount:${keySegment(projectId)}:${assetKind}:${keySegment(assetId)}`;
}

/** 项目资产库列表的「已挂用」键（kind + id 同一种编码，禁与 id 拼接混用）。 */
export function mountedAssetKey(assetKind: AssetKind, assetId: string): string {
  return `${assetKind}:${keySegment(assetId)}`;
}

/** 卡副本清单的清洗收口（去重、保序、逐笔过 id 边界；非法值丢弃而非截断）。 */
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

/** 清洗挂用记录（存档/读档唯一收口；id、idempotencyRef、localCopyId 一律重新推导）。 */
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
 * 幂等挂用（纯函式）：
 * - 同 `(projectId, assetKind, assetId)` 已存在 → 原样返回 created:false，**不新增第二笔**，
 *   且 `localCopyId` 逐位相同（同一个来源在同一个项目里只有一份副本 = 幂等一份）。
 *   `cardCopyIds` 取**联集**（挂用期间来源追加条目、重放补建了新副本 → 清单必须跟上，
 *   否则解除时解锁不全 = D1「已解除但仍被注入」）；清单没变 → `updated:false`（零副作用）。
 * - 同键但三元组不同 → **conflict:true**（真碰撞/别名，呼叫端必须回 409，禁静默成功）。
 * 这是「跨项目复用不双扣 / 不建第二份副本」在作用域层的落点。
 */
export function applyAssetMount(
  mounts: readonly AssetMountRecord[],
  input: { projectId: string; assetKind: AssetKind; assetId: string; now?: string; cardCopyIds?: readonly string[] },
): {
  mounts: AssetMountRecord[];
  mount: AssetMountRecord;
  created: boolean;
  conflict: boolean;
  /** 既有记录的卡副本清单被这次呼叫扩充了（呼叫端据此决定要不要落盘）。 */
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
    // 同键重放：回**既有**那一笔（其 localCopyId 与推导值逐位相同 → 指向同一份副本）。
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

/** 挂用三元组逐栏等值。 */
function sameMountTriple(a: AssetMountRecord, b: AssetMountRecord): boolean {
  return a.projectId === b.projectId && a.assetKind === b.assetKind && a.assetId === b.assetId;
}

// ─────────────────────────────────────────── copy-on-use 的单一分歧点

/** 跨项目语义：copy-on-use（挂用即建本地副本）｜reference（引用制，不建副本）。 */
export type AssetMountCopyMode = "copy-on-use" | "reference";

/** 拒绝理由（呼叫端必须直说，不得静默降级成「已挂用」）。 */
export type AssetMountCopyRejectReason =
  /** 推导出的副本 id 等于来源 id（会产生自引用边）。 */
  | "self_reference"
  /** 来源的血统链成环（已含自己），或计画建的副本已在来源的祖先链里（副本会成为自己的祖先）。 */
  | "cyclic_lineage"
  /** 血统图超出可完整遍历的节点预算 → 无法证明无环（**超界 fail-closed**，不当成没环）。 */
  | "unbounded_lineage";

/** 挂用计画（copy-on-use 与引用制共用同一笔挂用记录键；差别只在要不要落地副本）。 */
export interface AssetMountCopyPlan {
  mode: AssetMountCopyMode;
  /** copy-on-use＝要落地的卡/包副本 id；reference＝null（**唯一分歧点**在 planAssetMountCopy）。 */
  localCopyId: string | null;
  /** 目标项目已存在同一来源的副本 → 它的 id（幂等重放不建第二份）。 */
  existingCopyId: string | null;
  /** 需不需要真的建副本（引用制、或幂等重放且副本已在 → false）。 */
  shouldCreateCopy: boolean;
  mountId: string;
  idempotencyRef: string;
  projectId: string;
  assetKind: AssetKind;
  sourceAssetId: string;
}

/**
 * **挂用 copy-on-use 与引用制的唯一分歧点**（纯函式、零 IO）：
 * 决定「这次挂用要不要建副本、副本 id 是什么、是不是幂等重放、是不是环」。
 * 呼叫端（asset-library.mountAssetWithCopy）只照计画执行，不另立规则。
 *
 * 环路守卫（递归挂用可回溯、环路必拒）：
 * 1. 副本 id === 来源 id → self_reference（会写出自引用血统边）；
 * 2. 来源的祖先链已含来源自己 → cyclic_lineage（既有资料成环，拒绝延伸）；
 * 3. 计画建的副本已在来源的祖先链里 → cyclic_lineage（副本会成为自己的祖先）。
 * 注意：**「把副本再挂回它来源所属的项目」不是环**（每次挂用产生的是新节点，
 * 其血统边指向来源链），故不在此拒绝——递归挂用是被允许且可回溯的。
 *
 * `established`（D4 裁定）：呼叫端**已**由 store 实测出「同键挂用记录存在 + 该次副本已落地」
 * 时设 true → 跳过 2/3 两条环路守卫。理由：既成事实不得被**事后**的血统编辑（例如把副本 id
 * 写进来源自己的 lineage）打成 400；这条路径是幂等重放，不是新的延伸。
 * 首次挂用一律 established=false，守卫一条不少。
 */
export function planAssetMountCopy(input: {
  projectId: string;
  assetKind: AssetKind;
  sourceAssetId: string;
  mode?: AssetMountCopyMode;
  /** 目标项目既有的副本 id 集（呼叫端由 store 读；缺省＝空）。 */
  existingCopyIds?: readonly string[];
  /** 来源的血统祖先把手（呼叫端完整解析后填入；缺省＝无祖先）。 */
  ancestorAssetIds?: readonly string[];
  /** 已成立的幂等重放（见上）：跳过环路守卫，其余语义不变。 */
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

/** 解除挂用（按确定性 id）。回是否真的移除了。 */
export function applyAssetUnmount(
  mounts: readonly AssetMountRecord[],
  mountId: string,
): { mounts: AssetMountRecord[]; removed: boolean } {
  const next = mounts.filter((m) => m.id !== mountId);
  return { mounts: next, removed: next.length !== mounts.length };
}

/** 某项目当前挂用的资产键集合（列表标记 mounted 用；键段与 id 同一种单射编码）。 */
export function mountedAssetKeys(mounts: readonly AssetMountRecord[], projectId: string): Set<string> {
  const keys = new Set<string>();
  for (const m of mounts) {
    if (m.projectId !== projectId) continue;
    keys.add(mountedAssetKey(m.assetKind, m.assetId));
  }
  return keys;
}

// ─────────────────────────────────────────── 项目资产库（列表 + 检索 + 挂用入口）

/**
 * 资产来源锚点。与 `asset-pack-store.AssetPackItem.source` **同形**（此处本地声明，
 * 不 import 存储层以免循环依赖）。「从生成记录存卡 / 存资产」写的是
 * `{type:"history", id:<historyEntry.id>}`（见 history-card-anchor.ts）。
 */
export interface AssetSource {
  type: "history" | "canvas" | "chat" | "workflow" | "manual";
  id: string;
  sessionId?: string;
}

export interface AssetLibraryCandidate {
  assetKind: AssetKind;
  assetId: string;
  title: string;
  tags: string[];
  /** 人看的种类标签（资产包 / 角色 / 场景 / 风格）。 */
  kindLabel: string;
  scope?: AssetScope;
  /**
   * P1-A 项目标签（多归属，纯加法）：与 scope 并存；缺省＝没有标签。
   * 只给人看与前端筛选，不进 canvas 节点 metadata / agent 压缩白名单（同 scope 裁决）。
   */
  projectIds?: string[];
  /**
   * 资产来源锚点（**只读投射**）：资产包 items[].source 的代表值，缺省＝无来源。
   * 供只读消费者取 join 键（如 /history 的项目维度据 `source.type === "history"` 的
   * `source.id` 反查该项目的生成记录血缘）。纯读——不进任何写路径，也不进 canvas
   * metadata / agent 压缩白名单（与 projectIds 同裁决）。
   */
  source?: AssetSource;
  ownerUserId: number;
  updatedAt: string;
}

export interface AssetLibraryItem extends AssetLibraryCandidate {
  visibility: AssetVisibility;
  /** 已在当前项目资产库中挂用（LEGACY 标记，P1-A 起恒为 false）。 */
  mounted: boolean;
  /** P1-A：**永远存在**（没有标签＝[]），给前端按项目筛选用。 */
  projectIds: string[];
}

/**
 * 取包内「代表来源」：第一个带 `source` 的 item 的 source。历史存成的资产包每个 item
 * 都写同一条 `{type:"history", id:<entry.id>}`，取首个即代表包的来源。找不到回 null。
 */
function firstAssetSource(items: readonly { source?: AssetSource }[] | undefined): AssetSource | null {
  for (const item of items ?? []) {
    if (item.source && typeof item.source.id === "string" && item.source.id) return item.source;
  }
  return null;
}

/** 资产包 → 候选项（结构型别，不 import 存储层，避免循环）。 */
export function candidatesFromPacks(
  packs: readonly { id: string; title: string; digest?: string; tags?: string[]; scope?: AssetScope; projectIds?: string[]; updatedAt: string; items?: readonly { source?: AssetSource }[] }[],
  ownerUserId: number,
): AssetLibraryCandidate[] {
  return packs.map((p) => {
    const source = firstAssetSource(p.items);
    return {
      assetKind: "pack" as const,
      assetId: p.id,
      title: p.title,
      tags: Array.isArray(p.tags) ? [...p.tags] : [],
      kindLabel: "资产包",
      ...(p.scope ? { scope: p.scope } : {}),
      ...(p.projectIds?.length ? { projectIds: [...p.projectIds] } : {}),
      ...(source ? { source } : {}),
      ownerUserId,
      updatedAt: p.updatedAt,
    };
  });
}

const CARD_KIND_LABELS: Record<string, string> = { character: "角色", scene: "场景", style: "风格" };

/** 资产卡 → 候选项（标签＝卡名称 + 种类，卡的检索面与包同构）。 */
export function candidatesFromCards(
  cards: readonly { id: string; name: string; kind: string; prompt?: string; scope?: AssetScope; projectIds?: string[]; updatedAt: string }[],
  ownerUserId: number,
): AssetLibraryCandidate[] {
  return cards.map((c) => ({
    assetKind: "card" as const,
    assetId: c.id,
    title: c.name,
    tags: [CARD_KIND_LABELS[c.kind] ?? c.kind],
    kindLabel: CARD_KIND_LABELS[c.kind] ?? "卡",
    ...(c.scope ? { scope: c.scope } : {}),
    ...(c.projectIds?.length ? { projectIds: [...c.projectIds] } : {}),
    ownerUserId,
    updatedAt: c.updatedAt,
  }));
}

/** 检索：标题/标签模糊命中（大小写不敏感；空 query 全收）。 */
export function matchesAssetQuery(item: AssetLibraryCandidate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (item.title.toLowerCase().includes(q)) return true;
  if (item.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
  return false;
}

export interface AssetLibraryQuery {
  q?: string;
  /** 种类筛选：all（缺省）| pack | card。 */
  kind?: AssetKind | "all";
  /** 只看已挂用。 */
  mountedOnly?: boolean;
}

/**
 * 项目资产库列表（唯一组装口）：
 * 先过可见性（不可见即不列）→ 再过检索/筛选 → updatedAt 由新到旧。
 * mounted 标记只看当前项目（别的项目的挂用不算）。
 *
 * **内部副本不列**（D5）：copy-on-use 落地的副本是挂用机制的一部分，不是使用者资产；
 * 列出来只会被再挂用一次，在**同一个项目**里生出「副本的副本」→ 卡片额度无限膨胀。
 * 挂用关系的真相在挂用记录（来源键），来源那笔照样标「已挂用」，使用者不会因此看不到状态。
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
    if (isAssetLocalCopyId(candidate.assetId)) continue; // 内部副本不是可挂用条目
    const visibility = resolveAssetVisibility(
      {
        id: candidate.assetId,
        kind: candidate.assetKind,
        scope: candidate.scope,
        projectIds: candidate.projectIds,
        ownerUserId: candidate.ownerUserId,
      },
      ctx,
    );
    if (!visibility) continue; // 不可见即不可用：不列进列表
    if (kind !== "all" && candidate.assetKind !== kind) continue;
    if (!matchesAssetQuery(candidate, q)) continue;
    const mounted = keys.has(mountedAssetKey(candidate.assetKind, candidate.assetId));
    if (mountedOnly && !mounted) continue;
    // P1-A：projectIds 永远存在（没有标签＝[]），前端可直接照它筛选。
    items.push({ ...candidate, projectIds: candidate.projectIds ? [...candidate.projectIds] : [], visibility, mounted });
  }
  return items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/**
 * 挂用前置裁决：把候选项按可见性过一遍再决定能不能挂。
 * 回 null = 不可见/不可用（API 层必须回 403，不得静默成功）；
 * **内部副本（copy-…）一律回 null**（D5：副本不可再挂用，见 buildProjectAssetLibrary 的说明）。
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
    {
      id: candidate.assetId,
      kind: candidate.assetKind,
      scope: candidate.scope,
      projectIds: candidate.projectIds,
      ownerUserId: candidate.ownerUserId,
    },
    ctx,
  );
  return visibility ? { candidate, visibility } : null;
}
