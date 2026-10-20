// ─────────────────────────────────────────── 资产种类（既有两套表示的键）

/** 资产种类＝既有两种表示：pack（资产包）/ card（角色·场景·风格卡）。 */
export type AssetKind = "pack" | "card";

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

export const MAX_PROJECT_ID_LENGTH = 120;
export const MAX_TEAM_ID_LENGTH = 120;

// ─────────────────────────────────────────── 项目标签（P1-A：资产用标签不用分类）

/**
 * 单笔资产可挂的项目标签数上限（P1-A：`projectIds` 是用户自己的「多归属标签」）。
 * **写入路由入口已 fail-loud 拒收超限投入**（见 {@link projectTagIdsOverLimit}，400
 * `too_many_project_tags`）；此处 `normalizeProjectIds` 的截断保留为**纵深防御**
 * （读档收口 / 绕过路由的呼叫端仍不会写出超限记录）。
 */
export const MAX_ASSET_PROJECT_TAGS = 20;
export const MAX_ASSET_PROJECT_TAG_LENGTH = 120;

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

/** 分享动作的裁决结果（拒绝理由要能直说，不吞）。 */
export type ShareGrantRejectReason =
  | "cross_user"
  | "not_a_project_asset"
  | "project_mismatch"
  | "missing_target_project"
  | "same_project";

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

export interface AssetLibraryQuery {
  q?: string;
  /** 种类筛选：all（缺省）| pack | card。 */
  kind?: AssetKind | "all";
  /** 只看已挂用。 */
  mountedOnly?: boolean;
}
